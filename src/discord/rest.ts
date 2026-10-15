const API = "https://discord.com/api/v10";

export function botConfigured(): boolean {
  return !!process.env.DISCORD_BOT_TOKEN;
}

/**
 * The app's public address, e.g. "https://your-project.vercel.app". Uses APP_URL, else (on Vercel) the
 * project's production domain, else the current request's address. A missing "https://", a trailing
 * slash, or a path in APP_URL is tolerated.
 */
export function appUrl(fallbackOrigin?: string): string {
  const raw =
    process.env.APP_URL?.trim() || process.env.VERCEL_PROJECT_PRODUCTION_URL || fallbackOrigin || "http://localhost:3000";
  const local = /^(localhost|127\.0\.0\.1)(:|\/|$)/i.test(raw);
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `${local ? "http" : "https"}://${raw}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    return withScheme.replace(/\/+$/, "");
  }
}

/** Where Discord sends people after "Log in with Discord". It must be listed under OAuth2 → Redirects. */
export function discordRedirectUri(fallbackOrigin?: string): string {
  return `${appUrl(fallbackOrigin)}/api/auth/discord/callback`;
}

export interface Button {
  type: 2;
  style: 1 | 2 | 3 | 4 | 5; // primary, secondary, success, danger, link
  label: string;
  custom_id?: string;
  url?: string;
  emoji?: { name: string };
  disabled?: boolean;
}
export interface ActionRow {
  type: 1;
  components: Button[];
}
export interface DiscordMessage {
  content: string;
  components?: ActionRow[];
  allowed_mentions?: { users?: string[]; parse?: string[] };
  flags?: number;
}

async function discordFetch<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error("DISCORD_BOT_TOKEN is not set");
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Discord ${method} ${path} → ${res.status} ${await res.text()}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const postMessage = (channelId: string, msg: DiscordMessage) =>
  discordFetch<{ id: string }>(`/channels/${channelId}/messages`, "POST", msg);

export const editMessage = (channelId: string, messageId: string, msg: Partial<DiscordMessage>) =>
  discordFetch<{ id: string }>(`/channels/${channelId}/messages/${messageId}`, "PATCH", msg);

/** Follow-up message on an interaction (uses the interaction token; no bot token needed). */
export async function postFollowup(applicationId: string, interactionToken: string, msg: DiscordMessage) {
  const res = await fetch(`${API}/webhooks/${applicationId}/${interactionToken}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(msg),
  });
  if (!res.ok) throw new Error(`Discord follow-up → ${res.status} ${await res.text()}`);
}

export interface ScheduledEventInput {
  name: string;
  description?: string;
  startMs: number;
  endMs: number;
  voiceChannelId?: string | null;
}

/** Discord Scheduled Event: everyone who taps "Interested" gets notified when it starts. */
export function createScheduledEvent(guildId: string, e: ScheduledEventInput) {
  const base = {
    name: e.name.slice(0, 100),
    description: e.description?.slice(0, 1000),
    privacy_level: 2, // guild only
    scheduled_start_time: new Date(e.startMs).toISOString(),
    scheduled_end_time: new Date(e.endMs).toISOString(),
  };
  const body = e.voiceChannelId
    ? { ...base, entity_type: 2, channel_id: e.voiceChannelId }
    : { ...base, entity_type: 3, entity_metadata: { location: "Valorant" } };
  return discordFetch<{ id: string }>(`/guilds/${guildId}/scheduled-events`, "POST", body);
}
