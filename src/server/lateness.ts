import { and, desc, eq, inArray, lte, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { lateReports, playSessionPlayers, playSessions } from "@/db/schema";
import {
  lateReportCounts,
  lateReportsNeeded,
  lateVotingClosesAt,
  lateVotingState,
  type LateVoting,
  type SessionLateRecord,
} from "@/engine";
import type { GroupContext } from "./context";

export interface LateRecord extends SessionLateRecord {
  endMs: number | null;
}

/** Players who were actually in a session (not ones who declined or left). */
const isPlaying = (status: string) => status !== "declined" && status !== "left";

/** Locked-in sessions that have started (newest first), with their players and late reports. */
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
  const [sessions, players, reports] = await Promise.all([
    db.select().from(playSessions).where(started()).orderBy(desc(playSessions.startAt)).limit(limit),
    db.select().from(playSessionPlayers).where(inArray(playSessionPlayers.sessionId, sessionIds())),
    db.select().from(lateReports).where(inArray(lateReports.sessionId, sessionIds())),
  ]);
  return sessions.map((s) => ({
    sessionId: s.id,
    startMs: s.startAt.getTime(),
    endMs: s.endAt?.getTime() ?? null,
    players: players.filter((p) => p.sessionId === s.id && isPlaying(p.status)).map((p) => p.userId),
    reports: reports
      .filter((r) => r.sessionId === s.id)
      .map((r) => ({ reporterId: r.reporterId, lateUserId: r.lateUserId })),
  }));
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
}

export function tallyOf(r: LateRecord, viewerId: string | null, nowMs = Date.now()): LateTally {
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
  };
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
  const [players, reports] = await Promise.all([
    db.select().from(playSessionPlayers).where(eq(playSessionPlayers.sessionId, sessionId)),
    db.select().from(lateReports).where(eq(lateReports.sessionId, sessionId)),
  ]);
  const record: LateRecord = {
    sessionId,
    startMs: s.startAt.getTime(),
    endMs: s.endAt?.getTime() ?? null,
    players: players.filter((p) => isPlaying(p.status)).map((p) => p.userId),
    reports: reports.map((r) => ({ reporterId: r.reporterId, lateUserId: r.lateUserId })),
  };
  return { session: s, tally: tallyOf(record, viewerId, nowMs) };
}

/** Report (or un-report) a teammate as late. Returns whether the report is now on. */
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
  if (tally.voting === "not-started") throw new Error("Late reports open when the session starts.");
  if (tally.voting === "closed") throw new Error("Late reports for this session are closed.");
  if (reporterId === lateUserId) throw new Error("You can't report yourself.");
  if (!tally.players.includes(reporterId)) throw new Error("Only players in this session can report.");
  if (!tally.players.includes(lateUserId)) throw new Error("They weren't in this session.");

  const db = await getDb();
  const match = and(
    eq(lateReports.sessionId, sessionId),
    eq(lateReports.reporterId, reporterId),
    eq(lateReports.lateUserId, lateUserId),
  );
  const reported = !tally.mine.includes(lateUserId);
  if (reported) await db.insert(lateReports).values({ sessionId, reporterId, lateUserId }).onConflictDoNothing();
  else await db.delete(lateReports).where(match);
  return { reported, tally: (await getLateTally(ctx.group.id, sessionId, reporterId, nowMs))!.tally };
}
