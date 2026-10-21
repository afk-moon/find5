import { after } from "next/server";
import { handleAutocomplete, handleInteraction, type Interaction } from "@/discord/handlers";
import { verifyDiscordRequest } from "@/discord/verify";

/** Seconds a request may run, follow-up work included (/summary waits on the AI after replying). */
export const maxDuration = 60;

/** Discord "Interactions Endpoint URL": slash commands and button clicks arrive here as signed POSTs. */
export async function POST(req: Request) {
  const raw = await req.text();
  const valid = verifyDiscordRequest(
    raw,
    req.headers.get("x-signature-ed25519"),
    req.headers.get("x-signature-timestamp"),
    process.env.DISCORD_PUBLIC_KEY,
  );
  if (!valid) return new Response("invalid request signature", { status: 401 });

  const interaction = JSON.parse(raw) as Interaction;
  // Autocomplete (suggestions while typing a game) only takes choices back, and has no follow-up work.
  if (interaction.type === 4) return Response.json(await handleAutocomplete(interaction));

  const tasks: Array<() => Promise<unknown>> = [];
  const response = await handleInteraction(interaction, (task) => tasks.push(task));
  if (tasks.length) {
    after(async () => {
      for (const task of tasks) {
        try {
          await task();
        } catch (err) {
          console.error("[discord] follow-up task failed:", err);
        }
      }
    });
  }
  return Response.json(response);
}
