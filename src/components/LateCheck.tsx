import { toggleLateReportAction, toggleNoShowAction } from "@/app/actions";
import { fmtRelative } from "@/lib/format";
import type { GroupContext } from "@/server/context";
import { attendanceOf, type LateTally } from "@/server/lateness";
import { ActionButton } from "./ActionButton";
import { AddPlayer } from "./AddPlayer";
import { Avatar } from "./Avatar";
import { MemberName } from "./LateTag";

const lit = "border border-quick/60 bg-quick/15 text-quick hover:bg-quick/25";

/**
 * 📋 Who showed up? for a session whose attendance check is open: who counts as late or a no-show so far, and a
 * collapsed list (so the card stays short) with ⏰ late and 👻 no-show for each player, plus ➕ for someone who
 * played without being in the party. Only counts are shown, so reporters stay anonymous.
 */
export function LateCheck({
  ctx,
  tally,
  viewerId,
  now,
}: {
  ctx: GroupContext;
  tally: LateTally;
  viewerId: string;
  now: number;
}) {
  const canReport = tally.players.includes(viewerId);
  const nameOf = (id: string) => ctx.byId.get(id)?.name ?? "someone";
  const order = new Map(ctx.members.map((m, i) => [m.id, i]));
  const people = [...tally.players].sort((a, b) => (order.get(a) ?? 999) - (order.get(b) ?? 999));
  const { late, noShow } = attendanceOf(tally);
  const reports = Object.values(tally.counts).reduce((a, b) => a + b, 0) + Object.values(tally.noShows).reduce((a, b) => a + b, 0);
  const others = ctx.members.filter((m) => !tally.players.includes(m.id)).map((m) => ({ id: m.id, name: m.name }));
  const summary = [
    ...(late.length ? [`⏰ Late: ${late.map(nameOf).join(", ")}`] : []),
    ...(noShow.length ? [`👻 No-show: ${noShow.map(nameOf).join(", ")}`] : []),
  ];
  return (
    <div className="space-y-2 rounded-lg border border-quick/30 bg-quick/5 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="text-sm font-semibold">📋 Who showed up?</div>
        <div className="text-xs text-muted">Closes {fmtRelative(tally.closesAt, now)}</div>
      </div>
      <p className="text-xs text-muted">
        {summary.length
          ? summary.join(" · ")
          : reports
            ? `${reports} report${reports === 1 ? "" : "s"} so far; nobody counts as late or missing yet.`
            : "No reports yet: everyone counts as having shown up on time."}
      </p>
      <details>
        <summary className="cursor-pointer select-none text-xs text-muted hover:text-bone">
          {canReport ? "Report late or no-show" : "Players"} ({people.length})
        </summary>
        <div className="mt-2 space-y-1.5">
          <p className="text-xs text-muted">
            {`Someone counts as late, or as a no-show, once ${tally.needed} teammate${tally.needed === 1 ? "" : "s"} report them. ` +
              "Reports are anonymous, and you can tap again to take yours back. ✅ means they tapped in on a lobby during the session."}
            {!canReport && " Only players in this session can report."}
          </p>
          {people.map((id) => {
            const m = ctx.byId.get(id);
            if (!m) return null;
            const n = tally.counts[id] ?? 0;
            const gone = tally.noShows[id] ?? 0;
            const mineLate = tally.mine.includes(id);
            const mineGone = tally.mineNoShow.includes(id);
            const counts = [n ? `⏰ ${n}` : "", gone ? `👻 ${gone}` : ""].filter(Boolean).join(" · ");
            return (
              <div key={id} className="flex flex-wrap items-center gap-2 text-sm">
                <Avatar name={m.name} color={m.color} image={m.image} size={22} />
                <MemberName m={m} />
                {counts && (
                  <span className="text-xs text-muted" title="Reports so far">
                    {counts}
                  </span>
                )}
                <span className="ml-auto flex flex-wrap items-center gap-1.5">
                  {tally.seen.includes(id) && <span className="text-xs text-free">✅ in the lobby</span>}
                  {id === viewerId ? (
                    <span className="text-xs text-muted">you</span>
                  ) : canReport ? (
                    <>
                      <ActionButton
                        className={`btn px-2.5 py-1 text-xs ${mineLate ? lit : "btn-secondary"}`}
                        action={toggleLateReportAction.bind(null, tally.sessionId, id)}
                        title={mineLate ? "Take back your report" : `Report ${m.name} as late`}
                      >
                        {mineLate ? "✓ Late" : "⏰ Late"}
                      </ActionButton>
                      {!tally.seen.includes(id) && (
                        <ActionButton
                          className={`btn px-2.5 py-1 text-xs ${mineGone ? lit : "btn-secondary"}`}
                          action={toggleNoShowAction.bind(null, tally.sessionId, id)}
                          title={mineGone ? "Take back your report" : `Report ${m.name} as a no-show (never came)`}
                        >
                          {mineGone ? "✓ No-show" : "👻 No-show"}
                        </ActionButton>
                      )}
                    </>
                  ) : null}
                </span>
              </div>
            );
          })}
          {canReport && others.length > 0 && <AddPlayer sessionId={tally.sessionId} people={others} />}
        </div>
      </details>
    </div>
  );
}
