import Link from "next/link";
import { cancelSessionAction, lockInAction } from "@/app/actions";
import { ActionButton } from "@/components/ActionButton";
import { Avatar } from "@/components/Avatar";
import { Heatmap } from "@/components/Heatmap";
import { LateCheck } from "@/components/LateCheck";
import { MemberName } from "@/components/LateTag";
import { PartyCheck } from "@/components/PartyCheck";
import { SessionPlan, TimelineBar, WindowCard } from "@/components/WindowCard";
import { fmtDay, fmtDuration, fmtRange, fmtTime, zoneAbbr } from "@/lib/format";
import { partyLabel } from "@/lib/games";
import {
  forGame,
  gamesOf,
  mainGame,
  requestTime,
  requireMember,
  requireViewer,
  sessionGame,
  type GroupContext,
} from "@/server/context";
import { openLateVotes } from "@/server/lateness";
import { partyOf } from "@/server/party";
import { upcomingPlanned } from "@/server/sessions";
import { membersNow, upcomingWindows, weekHeat, type MemberNow } from "@/server/windows";

export default async function WindowsPage({ searchParams }: { searchParams: Promise<{ game?: string }> }) {
  const { groupId } = await requireMember();
  const now = requestTime();
  const [{ me, ctx }, planned, params] = await Promise.all([requireViewer(), upcomingPlanned(groupId, now), searchParams]);
  const zone = me.timezone;
  // One game at a time: the one picked, else the most-played game they play, else the group's main game.
  const mine = gamesOf(ctx, me.id);
  const picked = (params.game && ctx.gameById.get(params.game)) || mine[0];
  const game = picked ? forGame(ctx, picked) : mainGame(ctx);
  const P = game.game.partySize;
  const tooFew = game.game.players.length < P;
  const windows = tooFew ? [] : upcomingWindows(game, now);
  const locked = new Set(
    planned.filter((p) => p.session.gameId === game.game.id).map((p) => p.session.startAt.getTime()),
  );
  // Their games first, then the rest (each list most players first).
  const tabs = [...mine, ...ctx.games.filter((g) => !mine.includes(g))];
  // Open late checks. Sessions still in progress show theirs on their "Locked in" card; finished ones get their own card.
  const lateChecks = new Map(openLateVotes(ctx, me.id, now).map((t) => [t.sessionId, t]));
  const onLockedCards = new Set(planned.map((p) => p.session.id));
  const finishedChecks = [...lateChecks.values()].filter((t) => !onLockedCards.has(t.sessionId));

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <section className="space-y-4">
        <div>
          <h1 className="h1">
            This week&apos;s {game.game.name} windows
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Times are in your zone ({zoneAbbr(zone)}). Each window has at least{" "}
            {fmtDuration(ctx.group.minSessionMinutes)} of play with the same {P} people who play {game.game.name}. A
            quick dinner (up to {ctx.group.maxPauseMinutes} min) pauses the party; a long dinner splits the evening.
          </p>
        </div>

        {tabs.length > 1 && (
          <nav className="flex flex-wrap gap-1.5" aria-label="Games">
            {tabs.map((g) => {
              const on = g.id === game.game.id;
              return (
                <Link
                  key={g.id}
                  href={`/?game=${encodeURIComponent(g.id)}`}
                  aria-current={on ? "page" : undefined}
                  title={`${g.players.length} ${g.players.length === 1 ? "member plays" : "members play"} it · ${partyLabel(g.partySize)}`}
                  className={`btn px-2.5 py-1 text-xs ${on ? "btn-primary" : mine.includes(g) ? "" : "btn-ghost"}`}
                >
                  {g.name} <span className={on ? "opacity-80" : "text-muted"}>({g.players.length})</span>
                </Link>
              );
            })}
          </nav>
        )}

        {mine.length === 0 && (
          <div className="card text-sm">
            🎮 Pick the games you play on{" "}
            <Link className="text-val underline" href="/availability">
              My availability
            </Link>{" "}
            so you show up in their windows and lobbies.
          </div>
        )}

        {finishedChecks.length > 0 && (
          <div className="space-y-2">
            <div className="label">Late check</div>
            {finishedChecks.map((t) => (
              <div key={t.sessionId} className="card space-y-3">
                <div>
                  <div className="label">{fmtDay(t.startMs, zone)}</div>
                  <div className="font-bold">
                    {t.endMs ? fmtRange(t.startMs, t.endMs, zone) : fmtTime(t.startMs, zone)}{" "}
                    <span className="text-sm font-medium text-muted">{zoneAbbr(zone, t.startMs)}</span>
                  </div>
                </div>
                <LateCheck ctx={ctx} tally={t} viewerId={me.id} now={now} />
              </div>
            ))}
          </div>
        )}

        {planned.length > 0 && (
          <div className="space-y-2">
            <div className="label">Locked in</div>
            {planned.map(({ session, players, votes, events }) => {
              const w = {
                startMs: session.startAt.getTime(),
                endMs: session.endAt!.getTime(),
                pauses: session.plan?.pauses ?? [],
              };
              const started = w.startMs <= now;
              const late = lateChecks.get(session.id);
              const its = sessionGame(ctx, session);
              const party = partyOf(ctx, session, players, votes, me.id, now, events);
              return (
                <div key={session.id} className="card space-y-3 border-free/40">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="label text-free">
                        {started ? "🟢 Playing now" : `🔒 ${fmtDay(w.startMs, zone)}`} · {its.game.name}
                      </div>
                      <div className="text-xl font-bold">
                        {fmtRange(w.startMs, w.endMs, zone)}{" "}
                        <span className="text-sm font-medium text-muted">{zoneAbbr(zone, w.startMs)}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      {party.party.map((id) => {
                        const m = ctx.byId.get(id);
                        return m ? <Avatar key={id} name={m.name} color={m.color} image={m.image} size={26} /> : null;
                      })}
                      {!started && (
                        <ActionButton
                          className="btn btn-ghost ml-2 text-xs"
                          action={cancelSessionAction.bind(null, session.id)}
                          confirm="Cancel this session?"
                        >
                          Cancel
                        </ActionButton>
                      )}
                    </div>
                  </div>
                  <TimelineBar {...w} />
                  <SessionPlan ctx={its} w={w} zone={zone} />
                  <PartyCheck ctx={ctx} party={party} partySize={its.game.partySize} viewerId={me.id} startMs={w.startMs} zone={zone} />
                  {late ? (
                    <LateCheck ctx={ctx} tally={late} viewerId={me.id} now={now} />
                  ) : (
                    !started && (
                      <p className="text-xs text-muted">
                        ⏰ Late check opens at {fmtTime(w.startMs, zone)}, when the session starts.
                      </p>
                    )
                  )}
                </div>
              );
            })}
          </div>
        )}

        {tooFew ? (
          <div className="card space-y-2 text-sm text-muted">
            <p className="text-bone">
              {game.game.name} needs {P} players, and {game.game.players.length}{" "}
              {game.game.players.length === 1 ? "member plays" : "members play"} it so far.
            </p>
            <p>
              {game.game.players.includes(me.id) ? "Ask the others who play it to tick it" : "Play it too? Tick it"} under My
              games on {game.game.players.includes(me.id) ? "their" : "your"}{" "}
              <Link className="text-val underline" href="/availability">
                availability
              </Link>
              .
            </p>
          </div>
        ) : windows.length === 0 ? (
          <div className="card space-y-2 text-sm text-muted">
            <p className="text-bone">No {game.game.name} windows in the next 7 days.</p>
            <p>
              Try adding “if needed” time on your <Link className="text-val underline" href="/availability">availability</Link>, or
              check <Link className="text-val underline" href="/wfh">WFH sync</Link> to see which shared WFH day would open one up.
            </p>
          </div>
        ) : (
          windows.map((w) => (
            <WindowCard
              key={w.startMs}
              ctx={game}
              w={w}
              zone={zone}
              action={
                locked.has(w.startMs) ? (
                  <span className="chip text-free">🔒 Locked</span>
                ) : (
                  <ActionButton
                    className="btn btn-primary px-2.5 py-1 text-xs"
                    action={lockInAction.bind(null, game.game.id, w.startMs, w.endMs)}
                    pendingLabel="Locking…"
                  >
                    Lock it in
                  </ActionButton>
                )
              }
            />
          ))
        )}
      </section>

      <aside className="space-y-4">
        <div className="card space-y-3">
          <div className="label">
            {game.game.name} week at a glance ({zoneAbbr(zone)})
          </div>
          <Heatmap rows={weekHeat(game, zone, windows, now)} partySize={P} zone={zone} />
          <div className="flex flex-wrap gap-3 text-xs text-muted">
            <span className="flex items-center gap-1">
              <span className="h-3 w-3 rounded-sm bg-free" /> {P}+ free
            </span>
            <span className="flex items-center gap-1">
              <span className="h-3 w-3 rounded-sm bg-maybe/60" /> {P - 1} free
            </span>
            <span className="flex items-center gap-1">
              <span className="h-3 w-3 rounded-sm ring-1 ring-bone/70" /> suggested window
            </span>
          </div>
        </div>
        <div className="card space-y-3">
          <div className="label">Right now</div>
          {membersNow(ctx, now).map((s) => (
            <MemberStatus key={s.member.id} s={s} ctx={ctx} viewerZone={zone} now={now} />
          ))}
          <Link href="/live" className="btn btn-primary w-full">
            Who&apos;s on? Open a lobby
          </Link>
        </div>
      </aside>
    </div>
  );
}

function MemberStatus({ s, viewerZone, now }: { s: MemberNow; ctx: GroupContext; viewerZone: string; now: number }) {
  const m = s.member;
  const free = s.state === "F" || s.state === "M";
  const eating = s.state === "Q" || s.state === "L";
  let detail: string;
  if (eating) detail = `${s.state === "Q" ? "🍔 quick" : "🍝 long"} dinner`;
  else if (free) detail = `free until ${s.freeUntil ? fmtTime(s.freeUntil, viewerZone) : "late"}`;
  else detail = s.nextFreeAt ? `free at ${fmtTime(s.nextFreeAt, viewerZone)}` : "busy tonight";
  if (!eating && s.nextDinner && s.nextDinner.startMs > now) {
    detail += ` · ${s.nextDinner.kind === "Q" ? "🍔" : "🍝"} ${fmtTime(s.nextDinner.startMs, viewerZone)}`;
  }
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      <span className={`h-2 w-2 rounded-full ${free ? "bg-free" : eating ? "bg-quick" : "bg-line"}`} />
      <Avatar name={m.name} color={m.color} image={m.image} size={22} dim={!free} />
      <MemberName m={m} />
      <span className="text-xs text-muted">
        {fmtTime(now, m.timezone)} {zoneAbbr(m.timezone)}
      </span>
      <span className="ml-auto text-right text-xs text-muted">{detail}</span>
    </div>
  );
}
