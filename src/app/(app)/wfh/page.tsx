import Link from "next/link";
import {
  clearBallotAction,
  closeVoteAction,
  postVoteToDiscordAction,
  reopenVoteAction,
  toggleBallotAction,
} from "@/app/actions";
import { ActionButton } from "@/components/ActionButton";
import { Avatar } from "@/components/Avatar";
import { botConfigured } from "@/discord/rest";
import type { PlayWindow, Weekday } from "@/engine";
import { WEEKDAY_LONG, fmtDate, fmtDuration, fmtRange, zoneAbbr } from "@/lib/format";
import { requireViewer } from "@/server/context";
import { getWfhState, weekStartOf } from "@/server/wfh";

export default async function WfhPage({ searchParams }: { searchParams: Promise<{ week?: string }> }) {
  const { me, ctx } = await requireViewer();
  const { week } = await searchParams;
  const home = ctx.group.homeTimezone;
  const thisWeek = weekStartOf(home, 0);
  const nextWeek = weekStartOf(home, 1);
  const weekStart = week && /^\d{4}-\d{2}-\d{2}$/.test(week) ? week : nextWeek;
  const state = await getWfhState(ctx, weekStart);

  const P = ctx.group.partySize;
  const zone = me.timezone;
  const open = state.vote?.status !== "closed";
  const decided = (state.vote?.decidedDays ?? []) as Weekday[];
  const voters = state.hybrid.filter((m) => Object.values(m.hybridDays).includes("flex"));
  const votedCount = voters.filter((m) => state.ballots[m.id] !== undefined).length;
  const iVote = voters.some((m) => m.id === me.id);
  const myBallot = state.ballots[me.id] ?? [];
  const highlight = open ? state.plan.recommended : decided;
  const windowText = (w: PlayWindow | null) =>
    w ? `${fmtRange(w.startMs, w.endMs, zone)} (${fmtDuration(w.playMinutes)})` : "no window";

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="h1">WFH sync</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Hybrid folks tap every day they <em>could</em> work from home. The day the most of you can share wins;
            ties go to the day that unlocks the most {P}-stack time (earlier starts, later nights before WFH).
          </p>
        </div>
        <div className="flex gap-1">
          {[
            [thisWeek, "This week"],
            [nextWeek, "Next week"],
          ].map(([w, label]) => (
            <Link key={w} href={`/wfh?week=${w}`} className={`btn text-xs ${w === weekStart ? "bg-panel-2 text-bone" : "btn-ghost"}`}>
              {label} · {fmtDate(w)}
            </Link>
          ))}
        </div>
      </div>

      <div className="card flex flex-wrap items-center gap-3">
        {open ? (
          <>
            <span className="chip text-maybe">Vote open</span>
            <span className="text-sm">
              {votedCount} of {voters.length} flexible hybrid member{voters.length === 1 ? "" : "s"} voted
              {state.plan.recommended.length > 0 && (
                <>
                  {" "}· leading: <b>{state.plan.recommended.map((d) => WEEKDAY_LONG[d]).join(" & ")}</b>
                  {state.plan.projected && <span className="text-muted"> (projected)</span>}
                </>
              )}
            </span>
          </>
        ) : (
          <>
            <span className="chip text-free">Decided</span>
            <span className="text-sm">
              {decided.length ? (
                <>
                  WFH together on <b>{decided.map((d) => WEEKDAY_LONG[d]).join(" & ")}</b> ✅
                </>
              ) : (
                "No shared WFH day this week."
              )}
            </span>
          </>
        )}
        <div className="ml-auto flex flex-wrap gap-2">
          {open && iVote && (
            <ActionButton className="btn btn-ghost text-xs" action={clearBallotAction.bind(null, weekStart)}>
              Can&apos;t WFH this week
            </ActionButton>
          )}
          {open ? (
            <ActionButton className="btn btn-primary text-xs" action={closeVoteAction.bind(null, weekStart)} confirm="Close the vote and decide?">
              Close vote &amp; decide
            </ActionButton>
          ) : (
            <ActionButton className="btn btn-secondary text-xs" action={reopenVoteAction.bind(null, weekStart)}>
              Reopen vote
            </ActionButton>
          )}
          {botConfigured() && ctx.group.discordChannelId && (
            <ActionButton className="btn btn-secondary text-xs" action={postVoteToDiscordAction.bind(null, weekStart)}>
              Post to Discord
            </ActionButton>
          )}
        </div>
      </div>

      {state.hybrid.length === 0 && (
        <div className="card text-sm text-muted">
          Nobody is hybrid yet. Set your work schedule to “Hybrid” on{" "}
          <Link href="/availability" className="text-val underline">My availability</Link>.
        </div>
      )}
      {me.workStyle !== "hybrid" && state.hybrid.length > 0 && (
        <p className="text-sm text-muted">You&apos;re not hybrid, so you don&apos;t vote, but your availability counts toward each day&apos;s gain.</p>
      )}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        {state.projection.options.map((o) => {
          const current = state.plan.options.find((p) => p.weekday === o.weekday);
          const flexible = state.hybrid.filter((m) => m.hybridDays[o.weekday] === "flex");
          const office = state.hybrid.filter((m) => (m.hybridDays[o.weekday] ?? "office") === "office" && !o.fixed.includes(m.id));
          const mineVotable = open && iVote && me.hybridDays[o.weekday] === "flex";
          const yes = myBallot.includes(o.weekday);
          return (
            <div key={o.weekday} className={`card space-y-3 ${highlight.includes(o.weekday) ? "border-free/60" : ""}`}>
              <div className="flex items-start justify-between">
                <div>
                  <div className="font-bold">{WEEKDAY_LONG[o.weekday]}</div>
                  <div className="text-xs text-muted">{fmtDate(o.date)}</div>
                </div>
                {highlight.includes(o.weekday) && <span className="chip text-free">{open ? "⭐ leading" : "✅ WFH day"}</span>}
              </div>

              <div className="space-y-1 text-sm">
                {flexible.map((m) => {
                  const ballot = state.ballots[m.id];
                  return (
                    <div key={m.id} className="flex items-center gap-2">
                      <Avatar name={m.name} color={m.color} image={m.image} size={20} />
                      <span>{m.name}</span>
                      <span className="ml-auto text-xs">
                        {ballot === undefined ? <span className="text-muted">hasn&apos;t voted</span> : ballot.includes(o.weekday) ? "✅ can WFH" : "▫️ can't"}
                      </span>
                    </div>
                  );
                })}
                {o.fixed.length > 0 && (
                  <div className="text-xs text-muted">🏠 Home anyway: {o.fixed.map((id) => ctx.byId.get(id)?.name).join(", ")}</div>
                )}
                {office.length > 0 && <div className="text-xs text-muted">🏢 Office: {office.map((m) => m.name).join(", ")}</div>}
                {flexible.length === 0 && o.fixed.length === 0 && <div className="text-xs text-muted">Nobody can switch this day.</div>}
              </div>

              <div className="space-y-1 border-t border-line pt-2 text-xs text-muted">
                {o.votable.length > 0 ? (
                  <div>
                    <span className={o.gainMinutes > 0 ? "font-semibold text-free" : ""}>
                      {o.gainMinutes > 0 ? `Up to +${fmtDuration(o.gainMinutes)}` : "No extra"}
                    </span>{" "}
                    {P}-stack time this week
                  </div>
                ) : null}
                {current && !state.plan.projected && current.approvers.length > 0 && (
                  <div>With current votes: +{fmtDuration(Math.max(0, current.gainMinutes))}</div>
                )}
                <div>
                  With WFH: <span className="text-bone">{windowText(o.best)}</span>
                </div>
                <div>Without: {windowText(o.baseline)}</div>
              </div>

              {mineVotable && (
                <ActionButton
                  className={`btn w-full text-xs ${yes ? "btn-on" : "btn-secondary"}`}
                  action={toggleBallotAction.bind(null, weekStart, o.weekday)}
                >
                  {yes ? "✓ I can WFH" : "I could WFH"}
                </ActionButton>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-xs text-muted">
        Windows shown in your zone ({zoneAbbr(zone)}). The vote opens and closes automatically each week when the
        Discord bot is set up (see Settings).
      </p>
    </div>
  );
}
