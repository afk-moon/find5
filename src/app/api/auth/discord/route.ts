import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { appUrl, discordRedirectUri } from "@/discord/rest";
import { OAUTH_STATE_COOKIE, TZ_COOKIE } from "@/server/oauth-cookies";

/** Start "Log in with Discord" (OAuth2 authorization code flow, identify scope only). */
export async function GET(req: NextRequest) {
  const clientId = process.env.DISCORD_CLIENT_ID ?? process.env.DISCORD_APPLICATION_ID;
  if (!clientId || !process.env.DISCORD_CLIENT_SECRET) {
    return NextResponse.redirect(new URL("/login?error=discord-not-configured", req.url));
  }

  // Start on the address Discord sends people back to (e.g. when someone opened a deployment-specific
  // Vercel URL), so the state cookie set below is there when they return.
  const home = new URL(appUrl(req.nextUrl.origin));
  if (home.host !== req.nextUrl.host && !req.nextUrl.searchParams.has("moved")) {
    const there = new URL(`/api/auth/discord${req.nextUrl.search}`, home);
    there.searchParams.set("moved", "1");
    return NextResponse.redirect(there);
  }

  const state = randomBytes(16).toString("hex");
  const authorize = new URL("https://discord.com/oauth2/authorize");
  authorize.search = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    scope: "identify",
    redirect_uri: discordRedirectUri(req.nextUrl.origin),
    state,
    prompt: "none",
  }).toString();

  const res = NextResponse.redirect(authorize);
  const short = { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/", maxAge: 600 };
  res.cookies.set(OAUTH_STATE_COOKIE, state, short);
  const tz = req.nextUrl.searchParams.get("tz");
  if (tz) res.cookies.set(TZ_COOKIE, tz, short); // new members start in their browser's time zone
  return res;
}
