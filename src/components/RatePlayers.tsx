import { rateAction, reportOffenseAction } from "@/app/actions";
import { MENACE_TAG, NO_REPUTATION, OFFENSES_FOR_TAG, REPORTS_PER_OFFENSE } from "@/engine/reputation";
import type { GroupContext } from "@/server/context";
import { FEEDBACK_MAX_CHARS, type LobbyRatings } from "@/server/reputation";
import { ActionButton } from "./ActionButton";
import { Avatar } from "./Avatar";
import { FeedbackForm } from "./FeedbackForm";
import { MemberName } from "./LateTag";

const off = "btn-secondary";

/**
 * ⭐ Rate players in the lobby: 👍/👎 (with everyone's totals), 🚫 bannable offense, and a feedback box.
 * Votes and reports are anonymous: only counts show. Nothing shows if the viewer isn't in the lobby.
 */
export function RatePlayers({ ctx, ratings, viewerId }: { ctx: GroupContext; ratings: LobbyRatings; viewerId: string }) {
  if (!ratings.open || !ratings.people.includes(viewerId)) return null;
  const others = ratings.people.filter((id) => id !== viewerId);
  return (
    <div className="card space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="label">⭐ Rate players</div>
        <div className="text-xs text-muted">Anonymous: only totals show</div>
      </div>
      <p className="text-xs text-muted">
        {`👍/👎: one each per lobby (tap again to undo). 🚫 Bannable offense: counts once ${REPORTS_PER_OFFENSE} people ` +
          `report the same person in a lobby, and ${OFFENSES_FOR_TAG} of those earn ${MENACE_TAG}.`}
      </p>
      {others.length === 0 ? (
        <p className="text-sm text-muted">Nobody else is here yet.</p>
      ) : (
        <div className="space-y-2">
          {others.map((id) => {
            const m = ctx.byId.get(id);
            if (!m) return null;
            const t = ratings.totals[id] ?? NO_REPUTATION;
            const vote = ratings.mine[id];
            const reported = ratings.myReports.includes(id);
            const reports = ratings.reports[id] ?? 0;
            return (
              <div key={id} className="flex flex-wrap items-center gap-2 text-sm">
                <Avatar name={m.name} color={m.color} image={m.image} size={22} />
                <MemberName m={{ ...m, rep: t }} />
                <span className="text-xs text-muted" title="Totals over every lobby">
                  👍 {t.up} · 👎 {t.down}
                </span>
                <span className="ml-auto flex flex-wrap gap-1.5">
                  <ActionButton
                    className={`btn px-2.5 py-1 text-xs ${vote === 1 ? "border border-free/60 bg-free/15 text-free" : off}`}
                    action={rateAction.bind(null, ratings.sessionId, id, 1)}
                    title={vote === 1 ? "Take back your upvote" : `Upvote ${m.name}`}
                  >
                    👍
                  </ActionButton>
                  <ActionButton
                    className={`btn px-2.5 py-1 text-xs ${vote === -1 ? "border border-val/60 bg-val/15 text-val" : off}`}
                    action={rateAction.bind(null, ratings.sessionId, id, -1)}
                    title={vote === -1 ? "Take back your downvote" : `Downvote ${m.name}`}
                  >
                    👎
                  </ActionButton>
                  <ActionButton
                    className={`btn px-2.5 py-1 text-xs ${reported ? "border border-val/60 bg-val/15 text-val" : off}`}
                    action={reportOffenseAction.bind(null, ratings.sessionId, id)}
                    confirm={reported ? undefined : `Report ${m.name} for a bannable offense?`}
                    title={reported ? "Take back your report" : `Bannable offense (${reports} of ${REPORTS_PER_OFFENSE} reports in this lobby)`}
                  >
                    🚫 {reports}/{REPORTS_PER_OFFENSE}
                  </ActionButton>
                </span>
              </div>
            );
          })}
        </div>
      )}
      {others.length > 0 && (
        <FeedbackForm
          sessionId={ratings.sessionId}
          people={others.map((id) => ({ id, name: ctx.byId.get(id)?.name ?? "someone" }))}
          maxLength={FEEDBACK_MAX_CHARS}
        />
      )}
    </div>
  );
}
