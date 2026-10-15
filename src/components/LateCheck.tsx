import { toggleLateReportAction } from "@/app/actions";
import { fmtRelative } from "@/lib/format";
import type { GroupContext } from "@/server/context";
import type { LateTally } from "@/server/lateness";
import { ActionButton } from "./ActionButton";
import { Avatar } from "./Avatar";
import { MemberName } from "./LateTag";

/** "Who was late?" for a session whose late check is open. Only counts are shown, so reporters stay anonymous. */
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
  return (
    <div className="space-y-2 rounded-lg border border-quick/30 bg-quick/5 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="text-sm font-semibold">⏰ Who was late?</div>
        <div className="text-xs text-muted">Closes {fmtRelative(tally.closesAt, now)}</div>
      </div>
      <p className="text-xs text-muted">
        Someone counts as late once {tally.needed} teammate{tally.needed === 1 ? "" : "s"} report them. Reports are
        anonymous, and you can tap again to take yours back.
        {!canReport && " Only players in this session can report."}
      </p>
      <div className="space-y-1.5">
        {tally.players.map((id) => {
          const m = ctx.byId.get(id);
          if (!m) return null;
          const n = tally.counts[id] ?? 0;
          const late = n >= tally.needed;
          const mine = tally.mine.includes(id);
          return (
            <div key={id} className="flex flex-wrap items-center gap-2 text-sm">
              <Avatar name={m.name} color={m.color} image={m.image} size={22} />
              <MemberName m={m} />
              {n > 0 && (
                <span className={`text-xs ${late ? "font-semibold text-quick" : "text-muted"}`}>
                  {n} {n === 1 ? "report" : "reports"}
                  {late ? " · counts as late" : ""}
                </span>
              )}
              <span className="ml-auto">
                {id === viewerId ? (
                  <span className="text-xs text-muted">you</span>
                ) : canReport ? (
                  <ActionButton
                    className={`btn px-2.5 py-1 text-xs ${
                      mine ? "border border-quick/60 bg-quick/15 text-quick hover:bg-quick/25" : "btn-secondary"
                    }`}
                    action={toggleLateReportAction.bind(null, tally.sessionId, id)}
                    title={mine ? "Take back your report" : `Report ${m.name} as late`}
                  >
                    {mine ? "✓ You reported" : "Was late"}
                  </ActionButton>
                ) : null}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
