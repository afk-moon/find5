import { toggleKickVoteAction } from "@/app/actions";
import type { GroupContext } from "@/server/context";
import type { PartyState } from "@/server/party";
import { ActionButton } from "./ActionButton";

/**
 * "🗳️ Vote someone out" for a lobby or a locked-in session: a button per person with the votes so far. Only
 * counts are shown (voters stay anonymous), and tapping again takes your vote back. Shows nothing when the
 * viewer can't vote (in a lobby, only people who are in vote).
 */
export function VoteOut({ ctx, party, viewerId }: { ctx: GroupContext; party: PartyState; viewerId: string }) {
  const others = party.party.filter((id) => id !== viewerId);
  if (!party.open || !party.voters.includes(viewerId) || !others.length) return null;
  const nameOf = (id: string) => ctx.byId.get(id)?.name ?? "someone";
  const takes = `It takes ${party.needed} vote${party.needed === 1 ? "" : "s"} to remove someone.`;
  const help =
    party.kind === "live"
      ? `Someone tapped in but isn't around, or isn't coming? ${takes} They can tap I'm in to come back.`
      : `Late or not coming? ${takes}`;
  return (
    <details>
      <summary className="cursor-pointer select-none text-xs text-muted hover:text-bone">🗳️ Vote someone out</summary>
      <div className="mt-2 space-y-2">
        <p className="text-xs text-muted">{`${help} Votes are anonymous, and you can tap again to take yours back.`}</p>
        <div className="flex flex-wrap gap-2">
          {others.map((id) => {
            const mine = party.mine.includes(id);
            return (
              <ActionButton
                key={id}
                className={`btn px-2.5 py-1 text-xs ${
                  mine ? "border border-val/60 bg-val/15 text-val hover:bg-val/25" : "btn-secondary"
                }`}
                action={toggleKickVoteAction.bind(null, party.sessionId, id)}
                title={mine ? "Take back your vote" : `Vote to remove ${nameOf(id)}`}
              >
                {mine ? "✓ " : ""}
                {nameOf(id)} · {party.votes[id] ?? 0}/{party.needed}
              </ActionButton>
            );
          })}
        </div>
      </div>
    </details>
  );
}
