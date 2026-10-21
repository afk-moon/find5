import { rateAction, reportOffenseAction } from "@/app/actions";
import { MENACE_TAG, NO_REPUTATION, OFFENSES_FOR_TAG, RATING_COOLDOWN_MS, REPORTS_PER_OFFENSE } from "@/engine/reputation";
import type { GroupContext } from "@/server/context";
import { FEEDBACK_MAX_CHARS, type LobbyRatings } from "@/server/reputation";
import { ActionButton } from "./ActionButton";
import { Avatar } from "./Avatar";
import { FeedbackForm } from "./FeedbackForm";
import { MemberName } from "./LateTag";

const off = "btn-secondary";

/**
 * ⭐ Rate players in the lobby: 👍/👎 (with everyone's totals) and 🚫 bannable offense, as often as every couple
 * of minutes per person, plus a feedback box. Votes and reports are anonymous: only counts show. The viewer is
 * listed too, with their own numbers and nothing to tap. Nothing shows if the viewer isn't in the lobby.
 */
export function RatePlayers({ ctx, ratings, viewerId }: { ctx: GroupContext; ratings: LobbyRatings; viewerId: string }) {
  if (!ratings.open || !ratings.people.includes(viewerId)) return null;
  const others = ratings.people.filter((id) => id !== viewerId);
  const cooldown = `${RATING_COOLDOWN_MS / 60_000} min`;
  return (
    <div className="card space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="label">⭐ Rate players</div>
        <div className="text-xs text-muted">Anonymous: only totals show</div>
      </div>
      <p className="text-xs text-muted">
        {`👍/👎 and 🚫 as often as every ${cooldown} per person. 🚫 Bannable offense: every ${REPORTS_PER_OFFENSE} reports ` +
          `from ${REPORTS_PER_OFFENSE} different people in a lobby make one offense, and ${OFFENSES_FOR_TAG} offenses earn ${MENACE_TAG}.`}
      </p>
      <div className="space-y-2">
        {ratings.people.map((id) => {
          const m = ctx.byId.get(id);
          if (!m) return null;
          const t = ratings.totals[id] ?? NO_REPUTATION;
          const vote = ratings.lastVote[id];
          const reports = ratings.reports[id] ?? 0;
          const offenses = ratings.offenses[id] ?? 0;
          const people = ratings.reporters[id] ?? 0;
          const reportCount = `🚫 ${reports}${offenses > 0 ? ` (${offenses} offense${offenses === 1 ? "" : "s"})` : ""}`;
          const reportTitle = `Bannable offense: ${reports} report${reports === 1 ? "" : "s"} from ${people} ${people === 1 ? "person" : "people"} in this lobby`;
          return (
            <div key={id} className="flex flex-wrap items-center gap-2 text-sm">
              <Avatar name={m.name} color={m.color} image={m.image} size={22} />
              <MemberName m={{ ...m, rep: t }} />
              <span className="text-xs text-muted" title="Totals over every lobby">
                👍 {t.up} · 👎 {t.down}
              </span>
              {id === viewerId ? (
                // Your own numbers: nothing to tap (nobody rates themselves).
                <span className="ml-auto text-xs text-muted" title={reportTitle}>
                  {`${reportCount} · you`}
                </span>
              ) : (
                <span className="ml-auto flex flex-wrap gap-1.5">
                  <ActionButton
                    className={`btn px-2.5 py-1 text-xs ${vote === 1 ? "border border-free/60 bg-free/15 text-free" : off}`}
                    action={rateAction.bind(null, ratings.sessionId, id, 1)}
                    title={`Upvote ${m.name}`}
                  >
                    👍
                  </ActionButton>
                  <ActionButton
                    className={`btn px-2.5 py-1 text-xs ${vote === -1 ? "border border-val/60 bg-val/15 text-val" : off}`}
                    action={rateAction.bind(null, ratings.sessionId, id, -1)}
                    title={`Downvote ${m.name}`}
                  >
                    👎
                  </ActionButton>
                  <ActionButton
                    className={`btn px-2.5 py-1 text-xs ${ratings.myReports[id] ? "border border-val/60 bg-val/15 text-val" : off}`}
                    action={reportOffenseAction.bind(null, ratings.sessionId, id)}
                    confirm={`Report ${m.name} for a bannable offense?`}
                    title={reportTitle}
                  >
                    {reportCount}
                  </ActionButton>
                </span>
              )}
            </div>
          );
        })}
      </div>
      {others.length === 0 ? (
        <p className="text-sm text-muted">Nobody else is here yet.</p>
      ) : (
        <FeedbackForm
          sessionId={ratings.sessionId}
          people={others.map((id) => ({ id, name: ctx.byId.get(id)?.name ?? "someone" }))}
          maxLength={FEEDBACK_MAX_CHARS}
        />
      )}
    </div>
  );
}
