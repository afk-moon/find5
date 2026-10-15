import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db";
import { account, memberProfiles, user } from "@/db/schema";
import { appUrl, discordRedirectUri } from "@/discord/rest";
import { DEV_USER_COOKIE } from "@/server/auth";
import { createMember } from "@/server/availability";
import { SESSION_COOKIE, createSessionToken, sessionCookieOptions } from "@/server/session-cookie";
import { OAUTH_STATE_COOKIE, TZ_COOKIE } from "@/server/oauth-cookies";

interface DiscordProfile {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
}

export async function GET(req: NextRequest) {
  const base = appUrl(req.nextUrl.origin);
  const fail = (reason: string) => NextResponse.redirect(new URL(`/login?error=${reason}`, base));

  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  if (!code || !state || state !== req.cookies.get(OAUTH_STATE_COOKIE)?.value) return fail("oauth-state");

  const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: (process.env.DISCORD_CLIENT_ID ?? process.env.DISCORD_APPLICATION_ID)!,
      client_secret: process.env.DISCORD_CLIENT_SECRET!,
      grant_type: "authorization_code",
      code,
      redirect_uri: discordRedirectUri(req.nextUrl.origin),
    }),
  });
  if (!tokenRes.ok) return fail("oauth-token");
  const { access_token } = (await tokenRes.json()) as { access_token: string };

  const profileRes = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  if (!profileRes.ok) return fail("oauth-profile");
  const profile = (await profileRes.json()) as DiscordProfile;

  const userId = await findOrCreateDiscordMember(profile, req.cookies.get(TZ_COOKIE)?.value);
  const res = NextResponse.redirect(new URL("/", base));
  res.cookies.set(SESSION_COOKIE, createSessionToken(userId), sessionCookieOptions);
  res.cookies.delete(OAUTH_STATE_COOKIE);
  res.cookies.delete(DEV_USER_COOKIE);
  return res;
}

async function findOrCreateDiscordMember(p: DiscordProfile, timezone?: string): Promise<string> {
  const db = await getDb();
  const name = p.global_name || p.username;
  const image = p.avatar ? `https://cdn.discordapp.com/avatars/${p.id}/${p.avatar}.png?size=96` : null;
  const [existing] = await db
    .select({ userId: memberProfiles.userId })
    .from(memberProfiles)
    .where(eq(memberProfiles.discordId, p.id));
  if (existing) {
    await db.update(user).set({ name, image }).where(eq(user.id, existing.userId));
    return existing.userId;
  }
  const id = await createMember({
    name,
    image,
    timezone: timezone ?? "America/Chicago",
    discordId: p.id,
    email: `${p.id}@discord.receptionist.local`,
  });
  await db.insert(account).values({ id: crypto.randomUUID(), accountId: p.id, providerId: "discord", userId: id });
  return id;
}
