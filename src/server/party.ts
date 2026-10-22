import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { kickVotes, playSessionPlayers, type PlayerStatus, type SessionEventKind } from "@/db/schema";
import { SLOT_MS, buildTimelines, lateReportsNeeded, makeHorizon } from "@/engine";
import { sessionGame, type GroupContext } from "./context";
import {
  activeLive,
  getSession,
  LOBBY_STATUSES,
  lobbyExpired,
  logSessionEvent,
  upcomingPlanned,
  type KickVote,
  type PlaySession,
  type SessionEvent,
  type SessionPlayer,
} from "./sessions";

/** Tapped "Can't make it" on a locked-in session (they can tap again to rejoin). */
const DROPPED = "declined";
/** Voted out by the others, of a lobby or a locked-in session's party. */
const KICKED = "kicked";

/**
 * Votes needed to remove someone from a party of `n`: half of the others, like late reports, but never one
 * person's call when two or more could vote (2 of 4 in a 5-stack, 2 of 2 in a trio, 1 in a duo).
 */
export const kickVotesNeeded = (n: number) => (n <= 2 ? 1 : Math.max(2, lateReportsNeeded(n)));

/**
 * Who can be voted out of a session, who can vote, and the open votes. For a locked-in session that's its
 * party; for the live lobby it's everyone in it, and the people who are in right now vote (someone who tapped
 * I'm in but isn't around, or said "in 15 min" and never showed).
 */
export interface PartyState {
  sessionId: string;
  kind: "planned" | "live";
  /** Who can be voted out, in member order: the party still in, or everyone in the lobby (in, on the way, at dinner). */
  party: string[];
  /** Who can vote: the whole party, or in a lobby the people who are in right now. */
  voters: string[];
  /** Tapped "Can't make it" (locked-in sessions only; in a lobby you tap Leaving). */
  dropped: string[];
  /** Voted out by the others. A lobby lets them back in when they tap I'm in. */
  removed: string[];
  /** Votes to remove each person, counting only voters who can vote now (counts only: voters stay anonymous). */
  votes: Record<string, number>;
  /**
   * Votes needed to remove someone (see kickVotesNeeded). A locked-in session counts the party that locked in,
   * so drop-outs never push a pending vote over the line; a lobby counts who's in right now.
   */
  needed: number;
  /** Who the viewer voted to remove (only ever shown to the viewer). */
  mine: string[];
  /** Votes (and drop-outs) are allowed until a locked-in session ends, or while the lobby is open. */
  open: boolean;
  /** A locked-in party's changes since it was locked in, oldest first (who joined, left, rejoined, was removed). */
  log: SessionEvent[];
  /** People in the party who weren't when it was locked in (they tapped ✋ Join, or were added after the start). */
  joined: string[];
  /** Who else plays the game and is free by their schedule for some or all of what's left (while it's open). */
  alsoFree: FreeSpell[];
}

/** How each change reads in a locked-in party's change log (Discord post and website). */
export const EVENT_WORDS: Record<SessionEventKind, string> = {
  joined: "joined",
  left: "left",
  rejoined: "rejoined",
  removed: "was voted out",
  added: "played (added by a teammate)",
};

/** When someone outside a locked-in party is free during it, by their schedule. */
export interface FreeSpell {
  id: string;
  fromMs: number;
  untilMs: number;
  /** Free for all of what's left of the session. */
  whole: boolean;
}

/**
 * Who else plays a locked-in session's game and is free by their schedule for some or all of what's left of it:
 * people who weren't free for the whole window when it was locked in, or changed their schedule since. They
 * can tap ✋ Join. (People who left or were voted out are listed as such instead.)
 */
function alsoFree(ctx: GroupContext, session: PlaySession, players: readonly SessionPlayer[], nowMs: number): FreeSpell[] {
  if (!session.endAt) return [];
  const taken = new Set(players.map((p) => p.userId));
  const inputs = sessionGame(ctx, session).inputs.filter((m) => !taken.has(m.id));
  const from = Math.max(session.startAt.getTime(), nowMs);
  const h = makeHorizon(from, session.endAt.getTime());
  if (!inputs.length || !h.slots) return [];
  const rows = buildTimelines(inputs, h);
  return inputs.flatMap((m, i) => {
    const free = rows[i].map((state) => state === "F" || state === "M");
    const first = free.indexOf(true);
    if (first < 0) return [];
    const last = free.lastIndexOf(true);
    return [{ id: m.id, fromMs: Math.max(from, h.startMs + first * SLOT_MS), untilMs: h.startMs + (last + 1) * SLOT_MS, whole: free.every(Boolean) }];
  });
}

export function partyOf(
  ctx: GroupContext,
  session: PlaySession,
  players: readonly SessionPlayer[],
  votes: readonly KickVote[],
  viewerId: string | null,
  nowMs = Date.now(),
  events: readonly SessionEvent[] = [],
): PartyState {
  // Member order, so lists don't shuffle between renders (database rows come back in any order).
  const order = new Map(ctx.members.map((m, i) => [m.id, i]));
  const sorted = [...players].sort((a, b) => (order.get(a.userId) ?? 999) - (order.get(b.userId) ?? 999));
  const withStatus = (fn: (status: PlayerStatus) => boolean) => sorted.filter((p) => fn(p.status)).map((p) => p.userId);
  const live = session.kind === "live";
  const party = live ? withStatus((s) => LOBBY_STATUSES.includes(s)) : withStatus((s) => s !== DROPPED && s !== KICKED);
  const voters = live ? withStatus((s) => s === "in") : party;
  const canVote = new Set(voters);
  const targets = new Set(party);
  const counted = votes.filter((v) => canVote.has(v.voterId) && targets.has(v.targetId));
  const counts: Record<string, number> = {};
  for (const v of counted) counts[v.targetId] = (counts[v.targetId] ?? 0) + 1;
  const open = live
    ? session.status === "active" && !lobbyExpired(session, nowMs, ctx.group.homeTimezone)
    : session.status !== "cancelled" && nowMs < (session.endAt ?? session.startAt).getTime();
  return {
    sessionId: session.id,
    kind: live ? "live" : "planned",
    party,
    voters,
    dropped: live ? [] : withStatus((s) => s === DROPPED),
    removed: withStatus((s) => s === KICKED),
    votes: counts,
    needed: kickVotesNeeded(live ? voters.length : sorted.length),
    mine: viewerId ? counted.filter((v) => v.voterId === viewerId).map((v) => v.targetId) : [],
    open,
    log: live ? [] : [...events],
    joined: party.filter((id) => events.some((e) => e.userId === id && (e.kind === "joined" || e.kind === "added"))),
    alsoFree: !live && open ? alsoFree(ctx, session, players, nowMs) : [],
  };
}

/** A session (locked-in or lobby) with its party, or null if it doesn't exist or was cancelled. */
export async function getParty(ctx: GroupContext, sessionId: string, viewerId: string | null = null, nowMs = Date.now()) {
  const found = await getSession(ctx.group.id, sessionId);
  if (!found || found.session.status === "cancelled") return null;
  const { session, players, votes, events } = found;
  return { session, party: partyOf(ctx, session, players, votes, viewerId, nowMs, events) };
}

async function openParty(ctx: GroupContext, sessionId: string, viewerId: string, nowMs: number) {
  const found = await getParty(ctx, sessionId, viewerId, nowMs);
  if (!found) throw new Error("That session isn't available anymore.");
  if (!found.party.open) throw new Error(found.session.kind === "live" ? "That lobby is closed." : "This session is over.");
  return found;
}

/** The change time matters: dropping out after the start doesn't take you out of the late check. */
async function setStatus(sessionId: string, userId: string, status: PlayerStatus, nowMs: number) {
  const db = await getDb();
  await db
    .update(playSessionPlayers)
    .set({ status, backAt: null, updatedAt: new Date(nowMs) })
    .where(and(eq(playSessionPlayers.sessionId, sessionId), eq(playSessionPlayers.userId, userId)));
}

/** "Can't make it" on a locked-in session: leave the party. Tap again to rejoin (unless you were voted out). */
export async function toggleDropOut(ctx: GroupContext, sessionId: string, userId: string, nowMs = Date.now()) {
  const { session, party } = await openParty(ctx, sessionId, userId, nowMs);
  if (session.kind === "live") throw new Error("In a lobby, tap Leaving instead.");
  if (party.removed.includes(userId)) throw new Error("You were voted out of this one.");
  const dropping = party.party.includes(userId);
  if (!dropping && !party.dropped.includes(userId)) throw new Error("You're not in this session.");
  await setStatus(sessionId, userId, dropping ? DROPPED : "in", nowMs);
  await logSessionEvent(sessionId, userId, dropping ? "left" : "rejoined", nowMs);
  const after = (await getParty(ctx, sessionId, userId, nowMs))!;
  return { dropped: dropping, ...after };
}

/**
 * ✋ Join a locked-in session, before or after it starts (until it ends): a sub, someone running late, or someone
 * free for only part of it. Someone who said they can't make it is back in the party.
 */
export async function joinSession(ctx: GroupContext, sessionId: string, userId: string, nowMs = Date.now()) {
  const { session, party } = await openParty(ctx, sessionId, userId, nowMs);
  if (session.kind === "live") throw new Error("In a lobby, tap I'm in instead.");
  if (party.removed.includes(userId)) throw new Error("You were voted out of this one.");
  if (party.party.includes(userId)) throw new Error("You're already in this session.");
  const rejoin = party.dropped.includes(userId);
  if (rejoin) await setStatus(sessionId, userId, "in", nowMs);
  else {
    const db = await getDb();
    await db.insert(playSessionPlayers).values({ sessionId, userId, status: "in", updatedAt: new Date(nowMs) }).onConflictDoNothing();
  }
  await logSessionEvent(sessionId, userId, rejoin ? "rejoined" : "joined", nowMs);
  return { rejoined: rejoin, ...(await getParty(ctx, sessionId, userId, nowMs))! };
}

/**
 * Vote to remove someone from a lobby or a locked-in party ("toggle" takes a vote back if it's there; "on"
 * only adds). Once enough people vote (PartyState.needed), they're out and the votes against them are cleared,
 * so they start fresh if they come back (a lobby lets them back in with I'm in). Voters stay anonymous.
 */
async function kickVote(
  ctx: GroupContext,
  sessionId: string,
  voterId: string,
  targetId: string,
  mode: "toggle" | "on",
  nowMs: number,
) {
  const { session, party } = await openParty(ctx, sessionId, voterId, nowMs);
  const live = session.kind === "live";
  if (voterId === targetId) {
    throw new Error(`You can't vote yourself out. Tap ${live ? "Leaving" : "“Can't make it”"} instead.`);
  }
  if (!party.voters.includes(voterId)) {
    throw new Error(live ? "Only people who are in the lobby can vote. Tap I'm in first." : "Only players in this session can vote.");
  }
  if (!party.party.includes(targetId)) throw new Error(live ? "They're not in the lobby." : "They're not in the party anymore.");

  const db = await getDb();
  const had = party.mine.includes(targetId);
  const voted = mode === "on" || !had;
  if (voted && !had) await db.insert(kickVotes).values({ sessionId, voterId, targetId }).onConflictDoNothing();
  if (!voted && had) {
    await db
      .delete(kickVotes)
      .where(and(eq(kickVotes.sessionId, sessionId), eq(kickVotes.voterId, voterId), eq(kickVotes.targetId, targetId)));
  }
  let after = (await getParty(ctx, sessionId, voterId, nowMs))!;
  const removed = voted && (after.party.votes[targetId] ?? 0) >= after.party.needed;
  if (removed) {
    await setStatus(sessionId, targetId, KICKED, nowMs);
    await db.delete(kickVotes).where(and(eq(kickVotes.sessionId, sessionId), eq(kickVotes.targetId, targetId)));
    if (!live) await logSessionEvent(sessionId, targetId, "removed", nowMs);
    after = (await getParty(ctx, sessionId, voterId, nowMs))!;
  }
  return { voted, changed: voted !== had, removed, ...after };
}

/** Vote to remove someone, or take your vote back (buttons). */
export const toggleKickVote = (ctx: GroupContext, sessionId: string, voterId: string, targetId: string, nowMs = Date.now()) =>
  kickVote(ctx, sessionId, voterId, targetId, "toggle", nowMs);

/** Vote to remove someone; voting again changes nothing (/votekick). */
export const castKickVote = (ctx: GroupContext, sessionId: string, voterId: string, targetId: string, nowMs = Date.now()) =>
  kickVote(ctx, sessionId, voterId, targetId, "on", nowMs);

/**
 * Where `targetId` could be voted out: the open lobby first, then open locked-in sessions, soonest first.
 * `canVote` says whether `voterId` may vote there (in a lobby, only people who are in vote).
 */
export async function kickOptions(ctx: GroupContext, voterId: string, targetId: string, nowMs = Date.now()) {
  const [live, planned] = await Promise.all([activeLive(ctx.group, nowMs), upcomingPlanned(ctx.group.id, nowMs)]);
  return [...(live ? [live] : []), ...planned]
    .map((s) => ({ session: s.session, party: partyOf(ctx, s.session, s.players, s.votes, voterId, nowMs, s.events) }))
    .filter(({ party }) => party.open && party.party.includes(targetId))
    .map((o) => ({ ...o, canVote: o.party.voters.includes(voterId) && voterId !== targetId }));
}
