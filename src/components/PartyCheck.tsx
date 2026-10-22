import { joinSessionAction, toggleDropOutAction } from "@/app/actions";
import { fmtTime, sinceStart } from "@/lib/format";
import type { GroupContext } from "@/server/context";
import { EVENT_WORDS, type PartyState } from "@/server/party";
import { ActionButton } from "./ActionButton";
import { Avatar } from "./Avatar";
import { MemberName } from "./LateTag";
import { VoteOut } from "./VoteOut";

/**
 * A locked-in session's party: ✋ Join (before or after the start) or "Can't make it" for yourself, votes to remove
 * a teammate who's late or not coming, what changed since it was locked in, and who else is free during it. Only
 * vote counts are shown, so voters stay anonymous.
 */
export function PartyCheck({
  ctx,
  party,
  partySize,
  viewerId,
  startMs,
  zone,
}: {
  ctx: GroupContext;
  party: PartyState;
  partySize: number;
  viewerId: string;
  startMs: number;
  zone: string;
}) {
  const nameOf = (id: string) => ctx.byId.get(id)?.name ?? "someone";
  const inParty = party.party.includes(viewerId);
  const canJoin = party.open && !inParty && !party.dropped.includes(viewerId) && !party.removed.includes(viewerId);
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
        {canJoin && (
          <ActionButton
            key="join"
            className="btn btn-secondary px-2.5 py-1 text-xs"
            action={joinSessionAction.bind(null, party.sessionId)}
            title="Join this session, even if you can only make part of it"
          >
            ✋ Join
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
      {party.log.length > 0 && (
        <p className="text-xs text-muted">
          {`🔁 ${party.log
            .slice(-6)
            .map((e) => `${nameOf(e.userId)} ${EVENT_WORDS[e.kind]} ${sinceStart(e.atMs, startMs)}`)
            .join(" · ")}`}
        </p>
      )}
      {party.alsoFree.length > 0 && (
        <p className="text-xs text-muted">
          {`🕘 Also free: ${party.alsoFree
            .map((f) => `${nameOf(f.id)} (${f.whole ? "all of it" : `${fmtTime(f.fromMs, zone)}–${fmtTime(f.untilMs, zone)}`})`)
            .join(", ")}. They can ✋ Join, even for part of it.`}
        </p>
      )}

      <VoteOut ctx={ctx} party={party} viewerId={viewerId} />
    </div>
  );
}
