import { and, desc, eq, gt, inArray, lt, lte, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { lateReports, noShowReports, playSessionPlayers, playSessions, type PlayerStatus } from "@/db/schema";
import {
  lateReportCounts,
  lateReportsNeeded,
  lateVotingClosesAt,
  lateVotingState,
  reportCounts,
  type LateVoting,
  type SessionLateRecord,
} from "@/engine";
import type { GroupContext } from "./context";
import { logSessionEvent } from "./sessions";

export interface LateRecord extends SessionLateRecord {
  endMs: number | null;
  /** "Didn't show" reports from the attendance check. */
  noShows: Array<{ reporterId: string; targetId: string }>;
  /** Players who were in a lobby while the session was on, so they showed up (worked out while the check is open). */
  seen: string[];
}

/** Statuses that mean someone isn't playing a session: declined ("Can't make it"), left, or voted out. */
const OUT = new Set(["declined", "left", "kicked"]);
/** Lobby statuses that mean someone was there ("on the way" doesn't: they may never have come). */
const THERE: readonly PlayerStatus[] = ["in", "quick_dinner", "long_dinner"];
/** A lobby can stay open this long (see LIVE_MAX_AGE_MS in sessions.ts). */
const LOBBY_MAX_MS = 12 * 3_600_000;

/**
 * Players who count for a session's late check: everyone still in the party, plus anyone who dropped out or
 * was voted out after it started (leaving late doesn't wipe a late report). People who were out before the
 * start don't count.
 */
const countsForLate = (p: { status: string; updatedAt: Date }, startMs: number) =>
  !OUT.has(p.status) || p.updatedAt.getTime() >= startMs;

/** Someone's row in a lobby, with the lobby's times. */
interface LobbyPresence {
  userId: string;
  status: PlayerStatus;
  updatedAt: Date;
  startAt: Date;
  endAt: Date | null;
}

/** Lobby rows for lobbies opened between `fromMs` and `untilMs`. */
async function lobbyPresence(groupId: string, fromMs: number, untilMs: number): Promise<LobbyPresence[]> {
  const db = await getDb();
  return db
    .select({
      userId: playSessionPlayers.userId,
      status: playSessionPlayers.status,
      updatedAt: playSessionPlayers.updatedAt,
      startAt: playSessions.startAt,
      endAt: playSessions.endAt,
    })
    .from(playSessionPlayers)
    .innerJoin(playSessions, eq(playSessions.id, playSessionPlayers.sessionId))
    .where(
      and(
        eq(playSessions.groupId, groupId),
        eq(playSessions.kind, "live"),
        gt(playSessions.startAt, new Date(fromMs)),
        lt(playSessions.startAt, new Date(untilMs)),
      ),
    );
}

/**
 * Players who tapped in on a lobby while the session was on: still in when they last tapped before it ended
 * (in, or at dinner), or tapped Leaving after it started. People don't always use the lobby, so this only ever
 * confirms someone showed up; it never marks anyone missing.
 */
function seenIn(rows: readonly LobbyPresence[], players: readonly string[], startMs: number, endMs: number): string[] {
  const seen = new Set<string>();
  for (const r of rows) {
    const from = r.startAt.getTime();
    const until = r.endAt?.getTime() ?? from + LOBBY_MAX_MS;
    if (from >= endMs || until <= startMs) continue;
    const at = r.updatedAt.getTime();
    if ((THERE.includes(r.status) && at < endMs) || (r.status === "left" && at >= startMs)) seen.add(r.userId);
  }
  return players.filter((id) => seen.has(id));
}

/** Locked-in sessions that have started (newest first), with their players and reports. */
export async function loadLateRecords(groupId: string, nowMs = Date.now(), limit = 200): Promise<LateRecord[]> {
  const db = await getDb();
  const started = () =>
    and(
      eq(playSessions.groupId, groupId),
      eq(playSessions.kind, "planned"),
      ne(playSessions.status, "cancelled"),
      lte(playSessions.startAt, new Date(nowMs)),
    );
  // One parallel round trip: players and reports pick their sessions with the same subquery.
  const sessionIds = () =>
    db.select({ id: playSessions.id }).from(playSessions).where(started()).orderBy(desc(playSessions.startAt)).limit(limit);
  const [sessions, players, reports, noShows, lobbies] = await Promise.all([
    db.select().from(playSessions).where(started()).orderBy(desc(playSessions.startAt)).limit(limit),
    db.select().from(playSessionPlayers).where(inArray(playSessionPlayers.sessionId, sessionIds())),
    db.select().from(lateReports).where(inArray(lateReports.sessionId, sessionIds())),
    db.select().from(noShowReports).where(inArray(noShowReports.sessionId, sessionIds())),
    // Lobbies that could overlap a session whose check is still open (it started in the last day).
    lobbyPresence(groupId, nowMs - 48 * 3_600_000, nowMs),
  ]);
  return sessions.map((s) => {
    const startMs = s.startAt.getTime();
    const endMs = s.endAt?.getTime() ?? null;
    const ids = players.filter((p) => p.sessionId === s.id && countsForLate(p, startMs)).map((p) => p.userId);
    return {
      sessionId: s.id,
      startMs,
      endMs,
      players: ids,
      reports: reports
        .filter((r) => r.sessionId === s.id)
        .map((r) => ({ reporterId: r.reporterId, lateUserId: r.lateUserId })),
      noShows: noShows.filter((r) => r.sessionId === s.id).map((r) => ({ reporterId: r.reporterId, targetId: r.targetId })),
      seen: lateVotingState(startMs, nowMs) === "open" ? seenIn(lobbies, ids, startMs, endMs ?? startMs) : [],
    };
  });
}

export interface LateTally {
  sessionId: string;
  startMs: number;
  endMs: number | null;
  voting: LateVoting;
  closesAt: number;
  needed: number;
  players: string[];
  /** Valid reports per player. */
  counts: Record<string, number>;
  /** Players the viewer has reported (only ever shown to the viewer). */
  mine: string[];
  /** Valid "didn't show" reports per player (never for someone seen in a lobby). Counts with `needed`, like late. */
  noShows: Record<string, number>;
  /** Players the viewer reported as a no-show (only ever shown to the viewer). */
  mineNoShow: string[];
  /** Players who were in a lobby during the session: they showed up, so nobody can report them as a no-show. */
  seen: string[];
}

export function tallyOf(r: LateRecord, viewerId: string | null, nowMs = Date.now()): LateTally {
  const noShows = [...reportCounts(r.players, r.noShows)].filter(([id]) => !r.seen.includes(id));
  return {
    sessionId: r.sessionId,
    startMs: r.startMs,
    endMs: r.endMs,
    voting: lateVotingState(r.startMs, nowMs),
    closesAt: lateVotingClosesAt(r.startMs),
    needed: lateReportsNeeded(r.players.length),
    players: [...r.players],
    counts: Object.fromEntries(lateReportCounts(r)),
    mine: viewerId ? r.reports.filter((x) => x.reporterId === viewerId).map((x) => x.lateUserId) : [],
    noShows: Object.fromEntries(noShows),
    mineNoShow: viewerId ? r.noShows.filter((x) => x.reporterId === viewerId).map((x) => x.targetId) : [],
    seen: [...r.seen],
  };
}

/** Who counts as late, and who as a no-show (each with `needed` reports), and who played (everyone else). */
export function attendanceOf(t: LateTally) {
  const late = t.players.filter((id) => (t.counts[id] ?? 0) >= t.needed);
  const noShow = t.players.filter((id) => (t.noShows[id] ?? 0) >= t.needed);
  return { late, noShow, played: t.players.filter((id) => !noShow.includes(id)) };
}

/** Sessions whose late voting is open right now, newest first. */
export function openLateVotes(ctx: GroupContext, viewerId: string | null, nowMs = Date.now()): LateTally[] {
  return ctx.lateRecords
    .filter((r) => lateVotingState(r.startMs, nowMs) === "open")
    .map((r) => tallyOf(r, viewerId, nowMs));
}

/** Fresh tally for one session (also works before it starts, for the Discord announcement). */
export async function getLateTally(groupId: string, sessionId: string, viewerId: string | null = null, nowMs = Date.now()) {
  const db = await getDb();
  const [s] = await db
    .select()
    .from(playSessions)
    .where(and(eq(playSessions.id, sessionId), eq(playSessions.groupId, groupId)));
  if (!s || s.kind !== "planned" || s.status === "cancelled") return null;
  const startMs = s.startAt.getTime();
  const endMs = s.endAt?.getTime() ?? startMs;
  const [players, reports, noShows, lobbies] = await Promise.all([
    db.select().from(playSessionPlayers).where(eq(playSessionPlayers.sessionId, sessionId)),
    db.select().from(lateReports).where(eq(lateReports.sessionId, sessionId)),
    db.select().from(noShowReports).where(eq(noShowReports.sessionId, sessionId)),
    lateVotingState(startMs, nowMs) === "not-started" ? Promise.resolve([]) : lobbyPresence(groupId, startMs - LOBBY_MAX_MS, endMs),
  ]);
  const ids = players.filter((p) => countsForLate(p, startMs)).map((p) => p.userId);
  const record: LateRecord = {
    sessionId,
    startMs,
    endMs: s.endAt?.getTime() ?? null,
    players: ids,
    reports: reports.map((r) => ({ reporterId: r.reporterId, lateUserId: r.lateUserId })),
    noShows: noShows.map((r) => ({ reporterId: r.reporterId, targetId: r.targetId })),
    seen: seenIn(lobbies, ids, startMs, endMs),
  };
  return { session: s, tally: tallyOf(record, viewerId, nowMs) };
}

/** The checks every report goes through: the check is open, and it's a player reporting another player. */
function checkReport(tally: LateTally, reporterId: string, targetId: string, what: string) {
  if (tally.voting === "not-started") throw new Error(`${what} open when the session starts.`);
  if (tally.voting === "closed") throw new Error(`${what} for this session are closed.`);
  if (reporterId === targetId) throw new Error("You can't report yourself.");
  if (!tally.players.includes(reporterId)) throw new Error("Only players in this session can report.");
  if (!tally.players.includes(targetId)) throw new Error("They weren't in this session.");
}

const lateMatch = (sessionId: string, reporterId: string, targetId: string) =>
  and(eq(lateReports.sessionId, sessionId), eq(lateReports.reporterId, reporterId), eq(lateReports.lateUserId, targetId));
const noShowMatch = (sessionId: string, reporterId: string, targetId: string) =>
  and(eq(noShowReports.sessionId, sessionId), eq(noShowReports.reporterId, reporterId), eq(noShowReports.targetId, targetId));

/** Report (or un-report) a teammate as late. Returns whether the report is now on. It replaces your no-show report for them. */
export async function toggleLateReport(
  ctx: GroupContext,
  sessionId: string,
  reporterId: string,
  lateUserId: string,
  nowMs = Date.now(),
): Promise<{ reported: boolean; tally: LateTally }> {
  const found = await getLateTally(ctx.group.id, sessionId, reporterId, nowMs);
  if (!found) throw new Error("That session isn't available.");
  const { tally } = found;
  checkReport(tally, reporterId, lateUserId, "Late reports");

  const db = await getDb();
  const reported = !tally.mine.includes(lateUserId);
  if (reported) {
    await db.insert(lateReports).values({ sessionId, reporterId, lateUserId }).onConflictDoNothing();
    await db.delete(noShowReports).where(noShowMatch(sessionId, reporterId, lateUserId));
  } else await db.delete(lateReports).where(lateMatch(sessionId, reporterId, lateUserId));
  return { reported, tally: (await getLateTally(ctx.group.id, sessionId, reporterId, nowMs))!.tally };
}

/**
 * Report (or un-report) a teammate as a no-show: in the party, but never came. It replaces your late report for
 * them, and nobody seen in a lobby during the session can be reported.
 */
export async function toggleNoShowReport(
  ctx: GroupContext,
  sessionId: string,
  reporterId: string,
  targetId: string,
  nowMs = Date.now(),
): Promise<{ reported: boolean; tally: LateTally }> {
  const found = await getLateTally(ctx.group.id, sessionId, reporterId, nowMs);
  if (!found) throw new Error("That session isn't available.");
  const { tally } = found;
  checkReport(tally, reporterId, targetId, "No-show reports");
  if (tally.seen.includes(targetId)) throw new Error("They were in the lobby during the session, so they showed up.");

  const db = await getDb();
  const reported = !tally.mineNoShow.includes(targetId);
  if (reported) {
    await db.insert(noShowReports).values({ sessionId, reporterId, targetId }).onConflictDoNothing();
    await db.delete(lateReports).where(lateMatch(sessionId, reporterId, targetId));
  } else await db.delete(noShowReports).where(noShowMatch(sessionId, reporterId, targetId));
  return { reported, tally: (await getLateTally(ctx.group.id, sessionId, reporterId, nowMs))!.tally };
}

/**
 * ➕ Someone else played: a teammate marks someone who played without being in the party (a sub who never tapped
 * ✋ Join). They're added to the session as a player, so they're in its attendance. Only players can, once the
 * session has started and while its check is open.
 */
export async function addPlayer(ctx: GroupContext, sessionId: string, adderId: string, targetId: string, nowMs = Date.now()) {
  const found = await getLateTally(ctx.group.id, sessionId, adderId, nowMs);
  if (!found) throw new Error("That session isn't available.");
  const { tally } = found;
  if (tally.voting === "not-started") throw new Error("Until it starts, people can tap ✋ Join themselves.");
  if (tally.voting === "closed") throw new Error("The check for this session is closed.");
  if (!tally.players.includes(adderId)) throw new Error("Only players in this session can add someone.");
  if (!ctx.byId.has(targetId)) throw new Error("They're not in the group.");
  if (tally.players.includes(targetId)) throw new Error("They're already in this session.");

  const db = await getDb();
  const match = and(eq(playSessionPlayers.sessionId, sessionId), eq(playSessionPlayers.userId, targetId));
  const [row] = await db.select().from(playSessionPlayers).where(match);
  if (row?.status === "kicked") throw new Error("They were voted out of this one.");
  if (row) await db.update(playSessionPlayers).set({ status: "in", backAt: null, updatedAt: new Date(nowMs) }).where(match);
  else await db.insert(playSessionPlayers).values({ sessionId, userId: targetId, status: "in", updatedAt: new Date(nowMs) });
  await logSessionEvent(sessionId, targetId, "added", nowMs);
  return { tally: (await getLateTally(ctx.group.id, sessionId, adderId, nowMs))!.tally };
}

/** Group members who could be added to a session as having played: everyone who isn't a player in it. */
export const addableTo = (ctx: GroupContext, tally: LateTally) => ctx.members.filter((m) => !tally.players.includes(m.id)).map((m) => m.id);
