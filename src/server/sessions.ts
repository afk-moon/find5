import { and, asc, desc, eq, gt, gte, inArray, lt, type SQL } from "drizzle-orm";
import { DateTime } from "luxon";
import { getDb } from "@/db";
import {
  kickVotes,
  playSessionPlayers,
  playSessions,
  sessionEvents,
  type PlayerStatus,
  type SessionEventKind,
  type SessionPlan,
} from "@/db/schema";
import type { PlayWindow } from "@/engine";
import type { GameContext, GameView, GroupContext } from "./context";
import { findWindowByBounds } from "./windows";

export type PlaySession = typeof playSessions.$inferSelect;
export type SessionPlayer = typeof playSessionPlayers.$inferSelect;
/** A vote to remove someone from a lobby or a locked-in session's party. */
export interface KickVote {
  voterId: string;
  targetId: string;
}
/** A change to a locked-in party after it was locked in (see sessionEvents), oldest first. */
export interface SessionEvent {
  userId: string;
  kind: SessionEventKind;
  atMs: number;
}
/** A session with its players, the votes to remove someone, and its party's changes. */
export interface SessionWithPlayers {
  session: PlaySession;
  players: SessionPlayer[];
  votes: KickVote[];
  events: SessionEvent[];
}

const toEvent = (e: { userId: string; kind: SessionEventKind; createdAt: Date }): SessionEvent => ({
  userId: e.userId,
  kind: e.kind,
  atMs: e.createdAt.getTime(),
});
const eventOrder = () => [asc(sessionEvents.createdAt), asc(sessionEvents.id)];

/** Note a change to a locked-in party (Join, Can't make it, voted out…), for its post's change log. */
export async function logSessionEvent(sessionId: string, userId: string, kind: SessionEventKind, nowMs = Date.now()) {
  const db = await getDb();
  await db.insert(sessionEvents).values({ sessionId, userId, kind, createdAt: new Date(nowMs) });
}

/** Lobby statuses that count as being in the lobby: in, on the way, or at dinner. */
export const LOBBY_STATUSES: readonly PlayerStatus[] = ["in", "soon", "quick_dinner", "long_dinner"];

/** How long a long-dinner break is assumed to take when someone taps "long dinner" live. */
export const LONG_DINNER_MINUTES = 90;
const LIVE_MAX_AGE_MS = 12 * 3_600_000;

/** Sessions matching `where` (by start time), their players and kick votes, fetched side by side in one round trip. */
async function findWithPlayers(
  where: () => SQL | undefined,
  order: "asc" | "desc",
  limit: number,
): Promise<SessionWithPlayers[]> {
  const db = await getDb();
  const byStart = () => (order === "asc" ? asc(playSessions.startAt) : desc(playSessions.startAt));
  const ids = () => db.select({ id: playSessions.id }).from(playSessions).where(where()).orderBy(byStart()).limit(limit);
  const [rows, players, votes, events] = await Promise.all([
    db.select().from(playSessions).where(where()).orderBy(byStart()).limit(limit),
    db.select().from(playSessionPlayers).where(inArray(playSessionPlayers.sessionId, ids())),
    db.select().from(kickVotes).where(inArray(kickVotes.sessionId, ids())),
    db
      .select()
      .from(sessionEvents)
      .where(inArray(sessionEvents.sessionId, ids()))
      .orderBy(...eventOrder()),
  ]);
  return rows.map((session) => ({
    session,
    players: players.filter((p) => p.sessionId === session.id),
    votes: votes.filter((v) => v.sessionId === session.id).map((v) => ({ voterId: v.voterId, targetId: v.targetId })),
    events: events.filter((e) => e.sessionId === session.id).map(toEvent),
  }));
}

export async function getSession(groupId: string, sessionId: string): Promise<SessionWithPlayers | null> {
  const db = await getDb();
  const [[session], players, votes, events] = await Promise.all([
    db
      .select()
      .from(playSessions)
      .where(and(eq(playSessions.id, sessionId), eq(playSessions.groupId, groupId))),
    db.select().from(playSessionPlayers).where(eq(playSessionPlayers.sessionId, sessionId)),
    db
      .select({ voterId: kickVotes.voterId, targetId: kickVotes.targetId })
      .from(kickVotes)
      .where(eq(kickVotes.sessionId, sessionId)),
    db
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, sessionId))
      .orderBy(...eventOrder()),
  ]);
  return session ? { session, players, votes, events: events.map(toEvent) } : null;
}

export function planFromWindow(w: PlayWindow): SessionPlan {
  return {
    playMinutes: w.playMinutes,
    subs: w.subs,
    pauses: w.pauses.map((p) => ({ startMs: p.startMs, endMs: p.endMs, who: p.who })),
  };
}

// ─── Planned sessions ──────────────────────────────────────────────────────────────────────

/** Lock in one of a game's suggested windows. The window is re-computed server-side; returns the session and window. */
export async function lockInWindow(ctx: GameContext, userId: string, startMs: number, endMs: number) {
  const window = findWindowByBounds(ctx, startMs, endMs);
  if (!window) throw new Error("That window isn't available anymore. Someone's availability changed.");
  const db = await getDb();
  const [existing] = await db
    .select()
    .from(playSessions)
    .where(
      and(
        eq(playSessions.groupId, ctx.group.id),
        eq(playSessions.gameId, ctx.game.id),
        eq(playSessions.kind, "planned"),
        eq(playSessions.status, "active"),
        eq(playSessions.startAt, new Date(startMs)),
      ),
    );
  if (existing) return { session: existing, window, created: false };

  const [session] = await db
    .insert(playSessions)
    .values({
      groupId: ctx.group.id,
      gameId: ctx.game.id,
      kind: "planned",
      startAt: new Date(startMs),
      endAt: new Date(endMs),
      plan: planFromWindow(window),
      createdBy: userId,
    })
    .returning();
  await db
    .insert(playSessionPlayers)
    .values(window.party.map((id) => ({ sessionId: session.id, userId: id, status: "in" as const })));
  return { session, window, created: true };
}

export function upcomingPlanned(groupId: string, nowMs = Date.now()): Promise<SessionWithPlayers[]> {
  return findWithPlayers(
    () =>
      and(
        eq(playSessions.groupId, groupId),
        eq(playSessions.kind, "planned"),
        eq(playSessions.status, "active"),
        gt(playSessions.endAt, new Date(nowMs)),
      ),
    "asc",
    100,
  );
}

export async function cancelSession(groupId: string, sessionId: string, nowMs = Date.now()) {
  const db = await getDb();
  const [session] = await db
    .select()
    .from(playSessions)
    .where(and(eq(playSessions.id, sessionId), eq(playSessions.groupId, groupId)));
  if (!session) throw new Error("That session doesn't exist anymore.");
  // Cancelled sessions drop out of the late history, so a session can't be cancelled once it has started.
  if (session.startAt.getTime() <= nowMs) throw new Error("This session already started, so it can't be cancelled.");
  await db.update(playSessions).set({ status: "cancelled" }).where(eq(playSessions.id, sessionId));
}

// ─── Live (spontaneous) sessions ───────────────────────────────────────────────────────────

/** What lobby lookups need to know about the group. */
export type LobbyGroup = { id: string; homeTimezone: string };

/** Gaming days end at 4am. */
const DAY_END_HOUR = 4;

/**
 * Live lobbies last until the end of the day they opened on (4am in the group's home zone), and 12 hours at
 * most, so last night's lobby is never mistaken for tonight's. A lobby is still open if it started at or
 * after this instant.
 */
export function lobbyCutoff(nowMs: number, zone: string): number {
  const local = DateTime.fromMillis(nowMs, { zone });
  const dayEnd = local.set({ hour: DAY_END_HOUR, minute: 0, second: 0, millisecond: 0 });
  const dayStart = (local < dayEnd ? dayEnd.minus({ days: 1 }) : dayEnd).toMillis();
  return Math.max(nowMs - LIVE_MAX_AGE_MS, dayStart);
}

export function lobbyExpired(session: PlaySession, nowMs: number, zone: string): boolean {
  return session.kind === "live" && session.startAt.getTime() < lobbyCutoff(nowMs, zone);
}

const openLobbyWhere = (group: LobbyGroup, nowMs: number) =>
  and(
    eq(playSessions.groupId, group.id),
    eq(playSessions.kind, "live"),
    eq(playSessions.status, "active"),
    gte(playSessions.startAt, new Date(lobbyCutoff(nowMs, group.homeTimezone))),
  );

/** The open lobby. There's one at a time, for every game: who's on decides what gets played. */
export async function activeLive(group: LobbyGroup, nowMs = Date.now()): Promise<SessionWithPlayers | null> {
  const [live] = await findWithPlayers(() => openLobbyWhere(group, nowMs), "desc", 1);
  return live ?? null;
}

/** Lobbies still marked open after they expired (nobody tapped End): close them. Returns their ids. */
export async function closeExpiredLobbies(group: LobbyGroup, nowMs = Date.now()): Promise<string[]> {
  const db = await getDb();
  const rows = await db
    .update(playSessions)
    .set({ status: "ended", endAt: new Date(nowMs) })
    .where(
      and(
        eq(playSessions.groupId, group.id),
        eq(playSessions.kind, "live"),
        eq(playSessions.status, "active"),
        lt(playSessions.startAt, new Date(lobbyCutoff(nowMs, group.homeTimezone))),
      ),
    )
    .returning({ id: playSessions.id });
  return rows.map((r) => r.id);
}

/**
 * Open the lobby (or join the open one). Expired lobbies are closed first; `closed` lists them so their
 * Discord posts can be updated.
 */
export async function startLive(ctx: GroupContext, userId: string, nowMs = Date.now()) {
  const [closed, existing] = await Promise.all([closeExpiredLobbies(ctx.group, nowMs), activeLive(ctx.group, nowMs)]);
  if (existing) {
    await setPlayerStatus(ctx, existing.session.id, userId, "in");
    return { sessionId: existing.session.id, created: false, closed };
  }
  const db = await getDb();
  const [session] = await db
    .insert(playSessions)
    .values({ groupId: ctx.group.id, kind: "live", startAt: new Date(nowMs), createdBy: userId })
    .returning();
  await db.insert(playSessionPlayers).values({ sessionId: session.id, userId, status: "in" });
  return { sessionId: session.id, created: true, closed };
}

/**
 * /lfg: always a fresh lobby. Every lobby that was still open closes (people tap I'm in again on the new post,
 * so old taps from earlier in the evening don't linger). `closed` lists them with their posts, so each post
 * can point to the new one.
 */
export async function startFreshLive(ctx: GroupContext, userId: string, nowMs = Date.now()) {
  const db = await getDb();
  const closed = await db
    .update(playSessions)
    .set({ status: "ended", endAt: new Date(nowMs) })
    .where(and(eq(playSessions.groupId, ctx.group.id), eq(playSessions.kind, "live"), eq(playSessions.status, "active")))
    .returning({ id: playSessions.id, discordMessageId: playSessions.discordMessageId });
  const [session] = await db
    .insert(playSessions)
    .values({ groupId: ctx.group.id, kind: "live", startAt: new Date(nowMs), createdBy: userId })
    .returning();
  await db.insert(playSessionPlayers).values({ sessionId: session.id, userId, status: "in" });
  return { sessionId: session.id, closed };
}

export async function setPlayerStatus(
  ctx: GroupContext,
  sessionId: string,
  userId: string,
  status: PlayerStatus,
  backAt: Date | null = null,
) {
  if (!ctx.byId.has(userId)) throw new Error("You're not in this group.");
  const db = await getDb();
  const [session] = await db
    .select()
    .from(playSessions)
    .where(and(eq(playSessions.id, sessionId), eq(playSessions.groupId, ctx.group.id)));
  if (!session || session.status !== "active") throw new Error("That session has ended.");
  await db
    .insert(playSessionPlayers)
    .values({ sessionId, userId, status, backAt })
    .onConflictDoUpdate({
      target: [playSessionPlayers.sessionId, playSessionPlayers.userId],
      set: { status, backAt, updatedAt: new Date() },
    });
}

/** Quick dinner: the party waits (up to the pause limit). Long dinner: they're out for a while. */
export async function goToDinner(ctx: GroupContext, sessionId: string, userId: string, kind: "quick" | "long") {
  const minutes = kind === "quick" ? ctx.group.maxPauseMinutes : LONG_DINNER_MINUTES;
  await setPlayerStatus(
    ctx,
    sessionId,
    userId,
    kind === "quick" ? "quick_dinner" : "long_dinner",
    new Date(Date.now() + minutes * 60_000),
  );
}

export async function endSession(ctx: GroupContext, sessionId: string) {
  const db = await getDb();
  await db
    .update(playSessions)
    .set({ status: "ended", endAt: new Date() })
    .where(and(eq(playSessions.id, sessionId), eq(playSessions.groupId, ctx.group.id)));
}

/** How close the people in the lobby are to a party for one game. */
export interface GameProgress {
  game: GameView;
  /** Lobby members playing right now who play this game… */
  playing: string[];
  /** …and the ones on a quick dinner (the party waits for them). */
  atDinner: string[];
  /** Enough of them are playing right now. */
  ready: boolean;
  /** How many more people it needs (quick diners count, since the party waits for them). */
  needed: number;
}

export interface LiveSummary {
  /** full: some game has a full party playing · paused: one would, after quick dinners · forming: need more people */
  state: "full" | "paused" | "forming";
  playing: string[];
  eating: Array<{ id: string; kind: "quick" | "long"; backAt: number | null }>;
  /** On the way ("In 15 min", or /back with a time), earliest first. */
  soon: Array<{ id: string; backAt: number | null }>;
  declined: string[];
  left: string[];
  /** Voted out by the others (they can tap I'm in to come back). */
  kicked: string[];
  /** Every game, readiest first: ready ones, then the fewest more needed, then the most people in. */
  games: GameProgress[];
  /** The fewest more people any game needs. */
  needed: number;
}

/**
 * The lobby is for every game, so it's summed up game by game: who's in decides what you can play
 * (two TFT players make a duo while Valorant still needs three more).
 */
export function summarizeLive(games: readonly GameView[], players: SessionPlayer[]): LiveSummary {
  const ids = (status: PlayerStatus) => players.filter((p) => p.status === status).map((p) => p.userId);
  const playing = ids("in");
  const quick = ids("quick_dinner");
  const eating = players
    .filter((p) => p.status === "quick_dinner" || p.status === "long_dinner")
    .map((p) => ({
      id: p.userId,
      kind: p.status === "quick_dinner" ? ("quick" as const) : ("long" as const),
      backAt: p.backAt?.getTime() ?? null,
    }));
  const soon = players
    .filter((p) => p.status === "soon")
    .map((p) => ({ id: p.userId, backAt: p.backAt?.getTime() ?? null }))
    .sort((a, b) => (a.backAt ?? Infinity) - (b.backAt ?? Infinity));
  const progress: GameProgress[] = games
    .map((game) => {
      const plays = new Set(game.players);
      const p = playing.filter((id) => plays.has(id));
      const q = quick.filter((id) => plays.has(id));
      return { game, playing: p, atDinner: q, ready: p.length >= game.partySize, needed: Math.max(0, game.partySize - p.length - q.length) };
    })
    // Stable, so ties keep the group's order (most players first).
    .sort((a, b) => Number(b.ready) - Number(a.ready) || a.needed - b.needed || b.playing.length - a.playing.length);
  const state = progress.some((g) => g.ready) ? "full" : progress.some((g) => g.needed === 0) ? "paused" : "forming";
  return {
    state,
    playing,
    eating,
    soon,
    declined: ids("declined"),
    left: ids("left"),
    kicked: ids("kicked"),
    games: progress,
    needed: progress.length ? Math.min(...progress.map((g) => g.needed)) : 0,
  };
}

/** Games at least one person in the lobby plays (playing or at a quick dinner), readiest first. */
export const gamesInLobby = (summary: LiveSummary): GameProgress[] =>
  summary.games.filter((g) => g.playing.length + g.atDinner.length > 0);

/** Smallest party that counts as a "stack" for DMs (Valorant, League): duos and 4-stacks don't DM anyone. */
export const DM_STACK_SIZE = 5;

/** Ids of the games with a full 5-stack playing in the lobby (compared before and after a tap, for DMs). */
export const fullStacks = (summary: LiveSummary): string[] =>
  summary.games.filter((g) => g.ready && g.game.partySize >= DM_STACK_SIZE).map((g) => g.game.id);

/** One game's progress in the lobby: "✅ TFT 2/2", "Valorant 3/5", "Aion 2 3/4 (+1 at dinner)". */
export const progressText = (g: GameProgress) =>
  `${g.ready ? "✅ " : ""}${g.game.name} ${g.playing.length}/${g.game.partySize}${g.atDinner.length ? ` (+${g.atDinner.length} at dinner)` : ""}`;
