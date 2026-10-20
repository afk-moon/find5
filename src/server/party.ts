import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { kickVotes, playSessionPlayers, playSessions } from "@/db/schema";
import { lateReportsNeeded } from "@/engine";
import type { GroupContext } from "./context";
import type { KickVote, PlaySession, SessionPlayer } from "./sessions";

/** Statuses a locked-in session's players can have besides "in". */
const DROPPED = "declined"; // tapped "Can't make it"
const REMOVED = "left"; // voted out by the others

/**
 * Votes needed to remove someone from a party of `n`: half of the others, like late reports, but never one
 * person's call when two or more could vote (2 of 4 in a 5-stack, 2 of 2 in a trio, 1 in a duo).
 */
export const kickVotesNeeded = (n: number) => (n <= 2 ? 1 : Math.max(2, lateReportsNeeded(n)));

/**
 * A locked-in session's party: who's still in, who said they can't make it, who was voted out, and the open
 * votes to remove someone.
 */
export interface PartyState {
  sessionId: string;
  /** Still in the party, in member order. */
  party: string[];
  /** Tapped "Can't make it" (they can tap again to rejoin). */
  dropped: string[];
  /** Voted out by the others. */
  removed: string[];
  /** Votes to remove each party member, counting only voters still in the party (counts only: voters stay anonymous). */
  votes: Record<string, number>;
  /**
   * Votes needed to remove someone (see kickVotesNeeded), from the party that locked in: it doesn't drop as
   * people leave, so a drop-out never pushes a pending vote over the line.
   */
  needed: number;
  /** Who the viewer voted to remove (only ever shown to the viewer). */
  mine: string[];
  /** Votes and drop-outs are allowed until the session ends. */
  open: boolean;
}

export function partyOf(
  ctx: GroupContext,
  session: PlaySession,
  players: readonly SessionPlayer[],
  votes: readonly KickVote[],
  viewerId: string | null,
  nowMs = Date.now(),
): PartyState {
  // Member order, so lists don't shuffle between renders (database rows come back in any order).
  const order = new Map(ctx.members.map((m, i) => [m.id, i]));
  const sorted = [...players].sort((a, b) => (order.get(a.userId) ?? 999) - (order.get(b.userId) ?? 999));
  const withStatus = (fn: (status: string) => boolean) => sorted.filter((p) => fn(p.status)).map((p) => p.userId);
  const party = withStatus((s) => s !== DROPPED && s !== REMOVED);
  const inParty = new Set(party);
  const counted = votes.filter((v) => inParty.has(v.voterId) && inParty.has(v.targetId));
  const counts: Record<string, number> = {};
  for (const v of counted) counts[v.targetId] = (counts[v.targetId] ?? 0) + 1;
  const endMs = (session.endAt ?? session.startAt).getTime();
  return {
    sessionId: session.id,
    party,
    dropped: withStatus((s) => s === DROPPED),
    removed: withStatus((s) => s === REMOVED),
    votes: counts,
    needed: kickVotesNeeded(sorted.length),
    mine: viewerId ? counted.filter((v) => v.voterId === viewerId).map((v) => v.targetId) : [],
    open: session.status !== "cancelled" && nowMs < endMs,
  };
}

/** A locked-in session with its party, or null if it doesn't exist (or was cancelled). */
export async function getParty(ctx: GroupContext, sessionId: string, viewerId: string | null = null, nowMs = Date.now()) {
  const db = await getDb();
  const [[session], players, votes] = await Promise.all([
    db
      .select()
      .from(playSessions)
      .where(and(eq(playSessions.id, sessionId), eq(playSessions.groupId, ctx.group.id))),
    db.select().from(playSessionPlayers).where(eq(playSessionPlayers.sessionId, sessionId)),
    db
      .select({ voterId: kickVotes.voterId, targetId: kickVotes.targetId })
      .from(kickVotes)
      .where(eq(kickVotes.sessionId, sessionId)),
  ]);
  if (!session || session.kind !== "planned" || session.status === "cancelled") return null;
  return { session, party: partyOf(ctx, session, players, votes, viewerId, nowMs) };
}

async function openParty(ctx: GroupContext, sessionId: string, viewerId: string, nowMs: number) {
  const found = await getParty(ctx, sessionId, viewerId, nowMs);
  if (!found) throw new Error("That session isn't available anymore.");
  if (!found.party.open) throw new Error("This session is over.");
  return found;
}

/** The change time matters: dropping out after the start doesn't take you out of the late check. */
async function setStatus(sessionId: string, userId: string, status: string, nowMs: number) {
  const db = await getDb();
  await db
    .update(playSessionPlayers)
    .set({ status: status as SessionPlayer["status"], updatedAt: new Date(nowMs) })
    .where(and(eq(playSessionPlayers.sessionId, sessionId), eq(playSessionPlayers.userId, userId)));
}

/** "Can't make it": leave the party. Tap again to rejoin (unless you were voted out). */
export async function toggleDropOut(ctx: GroupContext, sessionId: string, userId: string, nowMs = Date.now()) {
  const { party } = await openParty(ctx, sessionId, userId, nowMs);
  if (party.removed.includes(userId)) throw new Error("You were voted out of this one.");
  const dropping = party.party.includes(userId);
  if (!dropping && !party.dropped.includes(userId)) throw new Error("You're not in this session.");
  await setStatus(sessionId, userId, dropping ? DROPPED : "in", nowMs);
  const after = (await getParty(ctx, sessionId, userId, nowMs))!;
  return { dropped: dropping, ...after };
}

/**
 * Vote to remove someone from the party (tap again to take it back). Once enough of the others vote (see
 * PartyState.needed), they're out. Votes are anonymous: only counts are shown.
 */
export async function toggleKickVote(
  ctx: GroupContext,
  sessionId: string,
  voterId: string,
  targetId: string,
  nowMs = Date.now(),
) {
  const { party } = await openParty(ctx, sessionId, voterId, nowMs);
  if (voterId === targetId) throw new Error("You can't vote yourself out. Tap “Can't make it” instead.");
  if (!party.party.includes(voterId)) throw new Error("Only players in this session can vote.");
  if (!party.party.includes(targetId)) throw new Error("They're not in the party anymore.");

  const db = await getDb();
  const voted = !party.mine.includes(targetId);
  if (voted) await db.insert(kickVotes).values({ sessionId, voterId, targetId }).onConflictDoNothing();
  else {
    await db
      .delete(kickVotes)
      .where(and(eq(kickVotes.sessionId, sessionId), eq(kickVotes.voterId, voterId), eq(kickVotes.targetId, targetId)));
  }
  let after = (await getParty(ctx, sessionId, voterId, nowMs))!;
  const removed = voted && (after.party.votes[targetId] ?? 0) >= after.party.needed;
  if (removed) {
    await setStatus(sessionId, targetId, REMOVED, nowMs);
    after = (await getParty(ctx, sessionId, voterId, nowMs))!;
  }
  return { voted, removed, ...after };
}
