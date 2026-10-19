import Link from "next/link";
import { liveAction, startLfgAction, type LiveAction } from "@/app/actions";
import { ActionButton } from "@/components/ActionButton";
import { Avatar } from "@/components/Avatar";
import { AutoRefresh } from "@/components/client";
import { MemberName } from "@/components/LateTag";
import { currentGamingDay, vacationOn } from "@/engine";
import { fmtDate, fmtRelative, fmtTime, zoneAbbr } from "@/lib/format";
import {
  gamesOf,
  requestTime,
  requireMember,
  requireViewer,
  sessionGame,
  type GameContext,
  type MemberView,
} from "@/server/context";
import { openLobbies, summarizeLive, type SessionWithPlayers } from "@/server/sessions";
import { membersNow, type MemberNow } from "@/server/windows";

export default async function LivePage() {
  const { groupId, homeTimezone } = await requireMember();
  const now = requestTime();
  const [{ me, ctx }, lobbies] = await Promise.all([requireViewer(), openLobbies({ id: groupId, homeTimezone }, now)]);
  const zone = me.timezone;
  const status = membersNow(ctx, now);
  const statusOf = new Map(status.map((s) => [s.member.id, s]));
  const isFree = (id: string) => {
    const s = statusOf.get(id);
    return !!s && (s.state === "F" || s.state === "M");
  };
  const mine = gamesOf(ctx, me.id);
  const hasLobby = new Set(lobbies.map((l) => l.session.gameId));
  // Their games that don't have a lobby open yet, most free right now first.
  const startable = mine
    .filter((g) => !hasLobby.has(g.id))
    .map((g) => ({ g, free: g.players.filter(isFree).length }))
    .sort((a, b) => b.free - a.free);

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <AutoRefresh seconds={lobbies.length ? 10 : 30} />
      <div>
        <h1 className="h1">Live lobby</h1>
        <p className="mt-1 text-sm text-muted">
          Spontaneous game? Open a lobby for it. Whoever plays it and is free gets pinged (in Discord, if it&apos;s
          connected), and it fills up to that game&apos;s party size.
        </p>
      </div>

      {lobbies.map((live) => (
        <LobbyCard key={live.session.id} live={live} game={sessionGame(ctx, live.session)} me={me} zone={zone} now={now} statusOf={statusOf} />
      ))}

      {mine.length === 0 ? (
        <div className="card text-sm">
          🎮 Pick the games you play on{" "}
          <Link className="text-val underline" href="/availability">
            My availability
          </Link>{" "}
          to open lobbies for them.
        </div>
      ) : (
        startable.length > 0 && (
          <div className="card space-y-3">
            <div className="label">{lobbies.length ? "Start another lobby" : "No lobby open"}</div>
            {startable.map(({ g, free }) => (
              <div key={g.id} className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="font-semibold">{g.name}</div>
                  <div className="text-sm text-muted">
                    {free} of {g.players.length} free right now
                    {free >= g.partySize ? ": enough for a full party 🎉" : ` · needs ${g.partySize}`}
                  </div>
                </div>
                <ActionButton className="btn btn-primary" action={startLfgAction.bind(null, g.id)} pendingLabel="Opening…">
                  Start LFG
                </ActionButton>
              </div>
            ))}
          </div>
        )
      )}

      {lobbies.length === 0 && (
        <div className="card space-y-2">
          <div className="label">Everyone right now</div>
          {status.map((s) => (
            <StatusRow key={s.member.id} s={s} zone={zone} now={now} />
          ))}
        </div>
      )}
    </div>
  );
}

/** One game's open lobby: who's in, buttons for the viewer, who hasn't answered, and dinner heads-ups. */
function LobbyCard({
  live,
  game,
  me,
  zone,
  now,
  statusOf,
}: {
  live: SessionWithPlayers;
  game: GameContext;
  me: MemberView;
  zone: string;
  now: number;
  statusOf: Map<string, MemberNow>;
}) {
  const ctx = game;
  const P = game.game.partySize;
  const summary = summarizeLive(P, live.players);
  const mine = live.players.find((p) => p.userId === me.id)?.status;
  const answered = new Set(live.players.map((p) => p.userId));
  // Only people who play this game are waited on.
  const waiting = game.members.filter((m) => !answered.has(m.id));
  const name = (id: string) => ctx.byId.get(id);
  const act = (a: LiveAction) => liveAction.bind(null, live.session.id, a);

  const headline =
    summary.state === "full"
      ? `✅ Party's full (${summary.playing.length}/${P}). Queue up!`
      : summary.state === "paused"
        ? "⏸️ Paused: waiting on a quick dinner"
        : `🎮 ${summary.playing.length}/${P} in, need ${summary.needed} more`;

  // Upcoming dinners for people in the lobby, with the last sensible queue.
  const headsUps = summary.playing
    .map((id) => statusOf.get(id))
    .filter((s): s is MemberNow => !!s?.nextDinner && s.nextDinner.startMs > now && s.nextDinner.startMs - now < 4 * 3_600_000);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-lg font-bold">{game.game.name}</h2>
          <p className="text-sm text-muted">
            Opened {fmtRelative(live.session.startAt.getTime(), now)} by {name(live.session.createdBy ?? "")?.name ?? "someone"}
          </p>
        </div>
        <ActionButton className="btn btn-ghost text-xs" action={act("end")} confirm={`End the ${game.game.name} lobby for everyone?`}>
          End lobby
        </ActionButton>
      </div>

      <div className={`card space-y-4 ${summary.state === "full" ? "border-free/60" : ""}`}>
        <div className="text-xl font-bold">{headline}</div>

        <div className="flex flex-wrap gap-2">
          {(!mine || mine === "declined" || mine === "left" || mine === "soon") && (
            <>
              <ActionButton className="btn btn-primary" action={act("in")}>I&apos;m in</ActionButton>
              {mine !== "soon" && <ActionButton action={act("soon")}>In 15 min</ActionButton>}
              {mine !== "declined" && <ActionButton className="btn btn-ghost" action={act("declined")}>Not tonight</ActionButton>}
            </>
          )}
          {mine === "in" && (
            <>
              <ActionButton action={act("quick")} title={`The party waits ~${ctx.group.maxPauseMinutes} min`}>🍔 Quick dinner</ActionButton>
              <ActionButton action={act("long")} title="You're out for a while; the lobby looks for a sub">🍝 Long dinner</ActionButton>
              <ActionButton className="btn btn-ghost" action={act("left")}>Leaving</ActionButton>
            </>
          )}
          {(mine === "quick_dinner" || mine === "long_dinner") && (
            <>
              <ActionButton className="btn btn-primary" action={act("back")}>I&apos;m back</ActionButton>
              <ActionButton className="btn btn-ghost" action={act("left")}>Leaving</ActionButton>
            </>
          )}
        </div>

        <div className="space-y-2 border-t border-line pt-3">
          <Group title="In" ids={summary.playing} lookup={name} extra={() => ""} />
          {summary.eating.length > 0 && (
            <div className="space-y-1">
              <div className="label">At dinner</div>
              {summary.eating.map((e) => {
                const m = name(e.id);
                return m ? (
                  <div key={e.id} className="flex flex-wrap items-center gap-2 text-sm">
                    <Avatar name={m.name} color={m.color} image={m.image} size={22} />
                    <MemberName m={m} />
                    <span className="text-muted">
                      {e.kind === "quick" ? "🍔 quick, the party waits" : "🍝 long, find a sub"}
                      {e.backAt ? `, back ${fmtRelative(e.backAt, now)}` : ""}
                    </span>
                  </div>
                ) : null;
              })}
            </div>
          )}
          <Group
            title="On the way"
            ids={summary.soon.map((s) => s.id)}
            lookup={name}
            extra={(id) => {
              const at = summary.soon.find((s) => s.id === id)?.backAt;
              return at ? `back ${fmtTime(at, zone)} (${fmtRelative(at, now)})` : "";
            }}
          />
          <Group title="Not tonight" ids={summary.declined} lookup={name} extra={() => ""} dim />
          <Group title="Left" ids={summary.left} lookup={name} extra={() => ""} dim />
          {waiting.length > 0 && (
            <div className="space-y-1">
              <div className="label">Haven&apos;t answered</div>
              {waiting.map((m) => {
                const s = statusOf.get(m.id);
                const free = s && (s.state === "F" || s.state === "M");
                const away = vacationOn(m, currentGamingDay(now, m.timezone));
                return (
                  <div key={m.id} className="flex flex-wrap items-center gap-2 text-sm">
                    <Avatar name={m.name} color={m.color} image={m.image} size={22} dim={!free} />
                    <MemberName m={m} className="" />
                    <span className="text-xs text-muted">
                      {away
                        ? `🏖️ on vacation until ${fmtDate(away.end)}`
                        : free
                          ? "free now per their schedule"
                          : s?.nextFreeAt
                            ? `usually free at ${fmtTime(s.nextFreeAt, zone)}`
                            : "busy tonight"}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {headsUps.length > 0 && (
        <div className="card space-y-1 text-sm">
          <div className="label">Dinner heads-ups</div>
          {headsUps.map((s) => (
            <div key={s.member.id}>
              {s.nextDinner!.kind === "Q" ? "🍔" : "🍝"} <b>{s.member.name}</b> eats at {fmtTime(s.nextDinner!.startMs, zone)} (
              {s.nextDinner!.kind === "Q" ? "quick" : "long"}). Last queue ~
              {fmtTime(s.nextDinner!.startMs - game.game.matchMinutes * 60_000, zone)} {zoneAbbr(zone)}.
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Group({
  title,
  ids,
  lookup,
  extra,
  dim = false,
}: {
  title: string;
  ids: string[];
  lookup: (id: string) => MemberView | undefined;
  extra: (id: string) => string;
  dim?: boolean;
}) {
  if (!ids.length) return null;
  return (
    <div className="space-y-1">
      <div className="label">{title}</div>
      <div className="flex flex-wrap gap-3">
        {ids.map((id) => {
          const m = lookup(id);
          return m ? (
            <span key={id} className="flex items-center gap-1.5 text-sm">
              <Avatar name={m.name} color={m.color} image={m.image} size={22} dim={dim} />
              <MemberName m={m} className={dim ? "text-muted" : "font-semibold"} />
              <span className="text-xs text-muted">{extra(id)}</span>
            </span>
          ) : null;
        })}
      </div>
    </div>
  );
}

function StatusRow({ s, zone, now }: { s: MemberNow; zone: string; now: number }) {
  const m = s.member;
  const free = s.state === "F" || s.state === "M";
  const eating = s.state === "Q" || s.state === "L";
  const away = vacationOn(m, currentGamingDay(now, m.timezone));
  const detail = away
    ? `🏖️ on vacation until ${fmtDate(away.end)}`
    : eating
      ? `${s.state === "Q" ? "🍔 quick" : "🍝 long"} dinner`
      : free
        ? `free until ${s.freeUntil ? fmtTime(s.freeUntil, zone) : "late"}${s.state === "M" ? " (if needed)" : ""}`
        : s.nextFreeAt
          ? `free at ${fmtTime(s.nextFreeAt, zone)}`
          : "busy tonight";
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      <span className={`h-2 w-2 rounded-full ${free ? "bg-free" : eating ? "bg-quick" : "bg-line"}`} />
      <Avatar name={m.name} color={m.color} image={m.image} size={22} dim={!free} />
      <MemberName m={m} />
      <span className="text-xs text-muted">
        {fmtTime(now, m.timezone)} {zoneAbbr(m.timezone)}
      </span>
      <span className="ml-auto text-xs text-muted">{detail}</span>
    </div>
  );
}
