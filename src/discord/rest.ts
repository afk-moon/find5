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

/** Replace the reply to an interaction, e.g. a deferred "thinking…" one (interaction token; no bot token needed). */
export async function editOriginal(applicationId: string, interactionToken: string, msg: DiscordMessage) {
  const res = await fetch(`${API}/webhooks/${applicationId}/${interactionToken}/messages/@original`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(msg),
  });
  if (!res.ok) throw new Error(`Discord edit reply → ${res.status} ${await res.text()}`);
}

/** A text box in a pop-up form. */
export interface TextInput {
  type: 4;
  custom_id: string;
  label: string;
  style: 1 | 2; // short, paragraph
  min_length?: number;
  max_length?: number;
  required?: boolean;
  placeholder?: string;
}
/** A pop-up form ("modal") opened from a button. Its answers come back as a type 5 interaction. */
export interface DiscordModal {
  custom_id: string;
  title: string;
  components: Array<{ type: 1; components: TextInput[] }>;
}

/**
 * DM someone (by Discord user id). Works for anyone who shares a server with the bot, unless they turned off
 * "Allow direct messages from server members"; then Discord refuses (error 50007).
 */
export async function sendDirectMessage(discordUserId: string, msg: DiscordMessage) {
  const channel = await discordFetch<{ id: string }>("/users/@me/channels", "POST", { recipient_id: discordUserId });
  return postMessage(channel.id, msg);
}

export interface ScheduledEventInput {
  name: string;
  description?: string;
  startMs: number;
  endMs: number;
  voiceChannelId?: string | null;
  /** Where it happens when there's no voice channel (the game's name). */
  location?: string;
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
    : { ...base, entity_type: 3, entity_metadata: { location: (e.location || "Online").slice(0, 100) } };
  return discordFetch<{ id: string }>(`/guilds/${guildId}/scheduled-events`, "POST", body);
}

/** Change a scheduled event's description (e.g. the party list, after someone drops out). */
export function editScheduledEvent(guildId: string, eventId: string, e: { description: string }) {
  return discordFetch<{ id: string }>(`/guilds/${guildId}/scheduled-events/${eventId}`, "PATCH", {
    description: e.description.slice(0, 1000),
  });
}
