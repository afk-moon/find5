import { asc, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { joinAsNewMemberAction, loginAsAction } from "@/app/actions";
import { Avatar } from "@/components/Avatar";
import { getDb } from "@/db";
import { memberProfiles, memberships, user } from "@/db/schema";
import { discordRedirectUri } from "@/discord/rest";
import { zoneAbbr } from "@/lib/format";
import { devLoginEnabled, discordLoginConfigured } from "@/server/auth";
import { DiscordLoginButton, ZonePicker } from "./LoginClient";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  "discord-not-configured": "Discord login isn't configured yet (see README).",
  "oauth-state": "Login expired or was tampered with. Please try again.",
  "oauth-token": "Discord didn't accept the login. Check DISCORD_CLIENT_SECRET and the redirect URL.",
  "oauth-profile": "Couldn't read your Discord profile. Please try again.",
  name: "Please enter a name.",
};

/** The address this page was opened at (used when APP_URL isn't set, e.g. locally). */
async function requestOrigin(): Promise<string | undefined> {
  const h = await headers();
  const host = (h.get("x-forwarded-host") ?? h.get("host"))?.split(",")[0].trim();
  return host ? `${h.get("x-forwarded-proto")?.split(",")[0].trim() ?? "http"}://${host}` : undefined;
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; stale?: string }> }) {
  const { error, stale } = await searchParams;
  const dev = devLoginEnabled();
  const discordReady = discordLoginConfigured();
  const db = await getDb();
  const people = dev
    ? await db
        .select({
          id: user.id,
          name: user.name,
          image: user.image,
          color: memberProfiles.color,
          timezone: memberProfiles.timezone,
          workStyle: memberProfiles.workStyle,
        })
        .from(memberships)
        .innerJoin(user, eq(user.id, memberships.userId))
        .leftJoin(memberProfiles, eq(memberProfiles.userId, user.id))
        .orderBy(asc(memberships.joinedAt), asc(user.name))
    : [];

  return (
    <main className="mx-auto max-w-md space-y-6 px-4 py-14">
      <div className="text-center">
        <div className="text-2xl font-black tracking-[0.18em] text-val sm:text-3xl">RECEPTIONIST</div>
        <p className="mt-2 text-sm text-muted">Find times for a full Valorant party, across time zones, around dinner.</p>
      </div>

      {(error || stale) && (
        <div className="card border-val/50 text-sm text-val">
          {error ? (ERRORS[error] ?? "Something went wrong.") : "That member no longer exists. Pick again."}
        </div>
      )}

      <div className="card space-y-3">
        <DiscordLoginButton enabled={discordReady} />
        <p className="text-center text-xs text-muted">Your Discord account links your pings in the bot&apos;s messages.</p>
        {discordReady && (
          <details className="text-xs text-muted">
            <summary className="cursor-pointer text-center">Discord says “Invalid OAuth2 redirect_uri”?</summary>
            <p className="mt-2">
              In the Discord Developer Portal, open your app → <b>OAuth2</b> → <b>Redirects</b>, add exactly this URL, and
              click <b>Save Changes</b>:
            </p>
            <code className="mt-1 block break-all rounded bg-ink-2 px-2 py-1 text-bone">{discordRedirectUri(await requestOrigin())}</code>
          </details>
        )}
      </div>

      {dev && (
        <>
          <div className="card space-y-2">
            <div className="label">Local demo: continue as…</div>
            {people.map((p, i) => (
              <form key={p.id} action={loginAsAction.bind(null, p.id)}>
                <button className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-panel-2">
                  <Avatar name={p.name} color={p.color ?? ["#ff4655", "#3b82f6", "#f59e0b", "#10b981", "#a78bfa"][i % 5]} image={p.image} />
                  <span className="font-semibold">{p.name}</span>
                  <span className="chip">{zoneAbbr(p.timezone ?? "America/Chicago")}</span>
                  {p.workStyle === "hybrid" && <span className="chip">🏠 hybrid</span>}
                </button>
              </form>
            ))}
          </div>
          <form action={joinAsNewMemberAction} className="card space-y-3">
            <div className="label">Or join as a new member</div>
            <div className="flex gap-2">
              <input name="name" placeholder="Your name" className="input flex-1" maxLength={40} />
              <ZonePicker name="timezone" />
            </div>
            <button className="btn btn-primary w-full">Join</button>
          </form>
          <p className="text-center text-xs text-muted">
            Demo login only appears in development (or with ALLOW_DEV_LOGIN=1).
          </p>
        </>
      )}
    </main>
  );
}
