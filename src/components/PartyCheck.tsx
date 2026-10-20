import { toggleDropOutAction, toggleKickVoteAction } from "@/app/actions";
import type { GroupContext } from "@/server/context";
import type { PartyState } from "@/server/party";
import { ActionButton } from "./ActionButton";
import { Avatar } from "./Avatar";
import { MemberName } from "./LateTag";

/**
 * A locked-in session's party: "Can't make it" for yourself, and votes to remove a teammate who's late or not
 * coming. Only vote counts are shown, so voters stay anonymous.
 */
export function PartyCheck({
  ctx,
  party,
  partySize,
  viewerId,
}: {
  ctx: GroupContext;
  party: PartyState;
  partySize: number;
  viewerId: string;
}) {
  const nameOf = (id: string) => ctx.byId.get(id)?.name ?? "someone";
  const inParty = party.party.includes(viewerId);
  const others = party.party.filter((id) => id !== viewerId);
  const short = partySize - party.party.length;
  return (
    <div className="space-y-2 border-t border-line pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-semibold">
          👥 Party {party.party.length}/{partySize}
          {short > 0 && <span className="font-medium text-quick"> · need {short} more</span>}
        </div>
        {party.open && inParty && (
          <ActionButton
            key="drop"
            className="btn btn-ghost px-2.5 py-1 text-xs"
            action={toggleDropOutAction.bind(null, party.sessionId)}
            confirm="Can't make it? You'll leave the party. You can rejoin until the session ends."
          >
            🙅 Can&apos;t make it
          </ActionButton>
        )}
        {party.open && party.dropped.includes(viewerId) && (
          <ActionButton
            key="rejoin"
            className="btn btn-secondary px-2.5 py-1 text-xs"
            action={toggleDropOutAction.bind(null, party.sessionId)}
          >
            ✅ I can make it after all
          </ActionButton>
        )}
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {party.party.map((id) => {
          const m = ctx.byId.get(id);
          if (!m) return null;
          const n = party.votes[id] ?? 0;
          return (
            <div key={id} className="flex items-center gap-2 text-sm">
              <Avatar name={m.name} color={m.color} image={m.image} size={22} />
              <MemberName m={m} />
              {n > 0 && (
                <span className="text-xs text-val" title="Votes to remove them from the party">
                  🗳️ {n}/{party.needed}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {party.dropped.length > 0 && (
        <p className="text-xs text-muted">🙅 Can&apos;t make it: {party.dropped.map(nameOf).join(", ")}</p>
      )}
      {party.removed.length > 0 && <p className="text-xs text-muted">🚪 Voted out: {party.removed.map(nameOf).join(", ")}</p>}
      {party.removed.includes(viewerId) && <p className="text-xs text-val">You were voted out of this one.</p>}

      {party.open && inParty && others.length > 0 && (
        <details>
          <summary className="cursor-pointer select-none text-xs text-muted hover:text-bone">🗳️ Vote someone out</summary>
          <div className="mt-2 space-y-2">
            <p className="text-xs text-muted">
              {`Late or not coming? Once ${party.needed} of you vote for someone, they're out of the party. ` +
                "Votes are anonymous, and you can tap again to take yours back."}
            </p>
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
                    title={mine ? "Take back your vote" : `Vote to remove ${nameOf(id)} from the party`}
                  >
                    {mine ? "✓ " : ""}
                    {nameOf(id)} · {party.votes[id] ?? 0}/{party.needed}
                  </ActionButton>
                );
              })}
            </div>
          </div>
        </details>
      )}
    </div>
  );
}
