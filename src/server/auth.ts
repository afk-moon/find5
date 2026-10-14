import { cookies } from "next/headers";
import { SESSION_COOKIE, readSessionToken } from "./session-cookie";

/** Cookie holding the demo member you're "logged in as" while developing locally. */
export const DEV_USER_COOKIE = "fivestack_dev_user";

export function devLoginEnabled(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.ALLOW_DEV_LOGIN === "1";
}

export function discordLoginConfigured(): boolean {
  return !!((process.env.DISCORD_CLIENT_ID ?? process.env.DISCORD_APPLICATION_ID) && process.env.DISCORD_CLIENT_SECRET);
}

/** The signed-in user's id: Discord session first, then (locally) the dev "log in as" cookie. */
export async function getSessionUserId(): Promise<string | null> {
  const jar = await cookies();
  const fromDiscord = readSessionToken(jar.get(SESSION_COOKIE)?.value);
  if (fromDiscord) return fromDiscord;
  if (!devLoginEnabled()) return null;
  return jar.get(DEV_USER_COOKIE)?.value ?? null;
}
