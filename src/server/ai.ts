/**
 * AI replies through an OpenAI-compatible chat API (plain fetch, nothing to install). By default it's Gemini:
 * set GEMINI_API_KEY (a free key from https://aistudio.google.com/apikey). For another provider, set
 * AI_BASE_URL, AI_API_KEY and AI_MODEL (any API with an OpenAI-style /chat/completions endpoint).
 */

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
const GEMINI_MODEL = "gemini-3.8-flash";

const apiKey = () => process.env.AI_API_KEY || process.env.GEMINI_API_KEY || "";

/** Whether a key is set (without one, AI features show something simpler instead). */
export function aiConfigured(): boolean {
  return apiKey() !== "";
}

/** One reply to `prompt`, following the `system` instructions. Null without a key; throws if the call fails. */
export async function chat(system: string, prompt: string, timeoutMs = 20_000): Promise<string | null> {
  const key = apiKey();
  if (!key) return null;
  const base = (process.env.AI_BASE_URL || GEMINI_BASE_URL).replace(/\/+$/, "");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.AI_MODEL || GEMINI_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      // Gemini thinks before it answers; a short summary needs little. (Other providers may not accept this.)
      ...(base === GEMINI_BASE_URL ? { reasoning_effort: "low" } : {}),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`AI request failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
  const text = json.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("The AI sent back an empty reply.");
  return text;
}
