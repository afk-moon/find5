import { liveAction, startLfgAction, type LiveAction } from "@/app/actions";
import { ActionButton } from "@/components/ActionButton";
import { Avatar } from "@/components/Avatar";
import { AutoRefresh } from "@/components/client";
import { MemberName } from "@/components/LateTag";
import { VoteOut } from "@/components/VoteOut";
import { currentGamingDay, vacationOn } from "@/engine";
import { fmtDate, fmtRelative, fmtTime, zoneAbbr } from "@/lib/format";
import { mainGame, requestTime, requireMember, requireViewer, type GroupContext, type MemberView } from "@/server/context";
import { partyOf } from "@/server/party";
import { activeLive, gamesInLobby, progressText, summarizeLive, type SessionWithPlayers } from "@/server/sessions";
import { membersNow, type MemberNow } from "@/server/windows";

export default async function LivePage() {
  const { groupId, homeTimezone } = await requireMember();
  const now = requestTime();
  const [{ me, ctx }, live] = await Promise.all([requireViewer(), activeLive({ id: groupId, homeTimezone }, now)]);
  const zone = me.timezone;
  const status = membersNow(ctx, now);
  const statusOf = new Map(status.map((s) => [s.member.id, s]));

  if (!live) {
    const free = new Set(status.filter((s) => s.state === "F" || s.state === "M").map((s) => s.member.id));
    // Games enough people are free for right now.
    const enough = ctx.games.filter((g) => g.players.filter((id) => free.has(id)).length >= g.partySize).map((g) => g.name);
    return (
      <div className="mx-auto max-w-3xl space-y-5">
        <AutoRefresh seconds={30} />
        <div>
          <h1 className="h1">Live lobby</h1>
          <p className="mt-1 text-sm text-muted">
            Spontaneous game? Open a lobby, for any game. Whoever&apos;s free gets pinged (in Discord, if it&apos;s
            connected), and the lobby shows which games the people who join can play.
          </p>
        </div>
        <div className="card flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="font-semibold">No lobby open</div>
            <div className="text-sm text-muted">
              {free.size} of {ctx.members.length} free right now{enough.length ? `: enough for ${enough.join(", ")} 🎉` : ""}
            </div>
          </div>
          <ActionButton className="btn btn-primary" action={startLfgAction} pendingLabel="Opening…">
            Start LFG
          </ActionButton>
        </div>
        <div className="card space-y-2">
          <div className="label">Everyone right now</div>
          {status.map((s) => (
            <StatusRow key={s.member.id} s={s} zone={zone} now={now} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <AutoRefresh seconds={10} />
      <LobbyCard live={live} ctx={ctx} me={me} zone={zone} now={now} statusOf={statusOf} />
    </div>
  );
}

/** The open lobby: who's in, which games they can play, buttons for the viewer, and dinner heads-ups. */
function LobbyCard({
  live,
  ctx,
  me,
  zone,
  now,
  statusOf,
}: {
  live: SessionWithPlayers;
  ctx: GroupContext;
  me: MemberView;
  zone: string;
  now: number;
  statusOf: Map<string, MemberNow>;
}) {
  const summary = summarizeLive(ctx.games, live.players);
  const games = gamesInLobby(summary);
  const ready = games.filter((g) => g.ready).map((g) => g.game.name);
  const closest = games.find((g) => !g.ready);
  const mine = live.players.find((p) => p.userId === me.id)?.status;
  const answered = new Set(live.players.map((p) => p.userId));
  const waiting = ctx.members.filter((m) => !answered.has(m.id));
  const name = (id: string) => ctx.byId.get(id);
  const act = (a: LiveAction) => liveAction.bind(null, live.session.id, a);
  // Votes to remove someone (AFK, or "in 15 min" and never showed): counts only, so voters stay anonymous.
  const party = partyOf(ctx, live.session, live.players, live.votes, me.id, now);
  const votesOn = (id: string) => (party.votes[id] ? `🗳️ ${party.votes[id]}/${party.needed}` : "");

  const headline =
    summary.state === "full"
      ? `✅ Ready to play: ${ready.join(", ")}. Queue up!`
      : summary.state === "paused"
        ? "⏸️ Paused: waiting on a quick dinner"
        : `🎮 ${summary.playing.length} in${closest ? `, ${closest.game.name} needs ${closest.needed} more` : ""}`;

  // Upcoming dinners for people in the lobby, with the last sensible queue (for the readiest game).
  const queueGame = games[0]?.game ?? mainGame(ctx).game;
  const headsUps = summary.playing
    .map((id) => statusOf.get(id))
    .filter((s): s is MemberNow => !!s?.nextDinner && s.nextDinner.startMs > now && s.nextDinner.startMs - now < 4 * 3_600_000);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="h1">Live lobby</h1>
          <p className="text-sm text-muted">
            Opened {fmtRelative(live.session.startAt.getTime(), now)} by {name(live.session.createdBy ?? "")?.name ?? "someone"}
          </p>
        </div>
        <ActionButton className="btn btn-ghost text-xs" action={act("end")} confirm="End this lobby for everyone?">
          End lobby
        </ActionButton>
      </div>

      <div className={`card space-y-4 ${summary.state === "full" ? "border-free/60" : ""}`}>
        <div className="space-y-2">
          <div className="text-xl font-bold">{headline}</div>
          {games.length > 0 && (
            <div className="flex flex-wrap gap-1.5" title="Players in the lobby who play each game, out of its party size">
              {games.map((g) => (
                <span key={g.game.id} className={`chip ${g.ready ? "text-free" : ""}`}>
                  {progressText(g)}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          {mine === "kicked" && (
            <p className="w-full text-sm text-val">🚪 You were voted out of the lobby. Here after all? Tap I&apos;m in.</p>
          )}
          {(!mine || mine === "declined" || mine === "left" || mine === "kicked" || mine === "soon") && (
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
          <Group title="In" ids={summary.playing} lookup={name} extra={votesOn} />
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
                    {votesOn(e.id) && <span className="text-xs text-val">{votesOn(e.id)}</span>}
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
              return [at ? `back ${fmtTime(at, zone)} (${fmtRelative(at, now)})` : "", votesOn(id)].filter(Boolean).join(" · ");
            }}
          />
          <Group title="Not tonight" ids={summary.declined} lookup={name} extra={() => ""} dim />
          <Group title="Left" ids={summary.left} lookup={name} extra={() => ""} dim />
          <Group title="Voted out" ids={summary.kicked} lookup={name} extra={() => "can tap I'm in to come back"} dim />
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
          <VoteOut ctx={ctx} party={party} viewerId={me.id} />
        </div>
      </div>

      {headsUps.length > 0 && (
        <div className="card space-y-1 text-sm">
          <div className="label">Dinner heads-ups</div>
          {headsUps.map((s) => (
            <div key={s.member.id}>
              {s.nextDinner!.kind === "Q" ? "🍔" : "🍝"} <b>{s.member.name}</b> eats at {fmtTime(s.nextDinner!.startMs, zone)} (
              {s.nextDinner!.kind === "Q" ? "quick" : "long"}). Last {queueGame.name} queue ~
              {fmtTime(s.nextDinner!.startMs - queueGame.matchMinutes * 60_000, zone)} {zoneAbbr(zone)}.
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
