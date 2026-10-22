/**
 * Late reports on locked-in sessions.
 *
 * - Reporting opens when the session's start time arrives and stays open for LATE_VOTING_HOURS.
 * - Only players in the session can report, and not themselves.
 * - A player counts as late for a session when at least half of the *other* players reported them
 *   (2 of 4 in a 5-stack), so one person can't mark someone late alone.
 * - "Frequently late" = late in more than half of their most recent sessions (up to 10). A session
 *   only counts once its voting has closed, and at least MIN_SESSIONS_FOR_TAG sessions are needed
 *   so a single bad night doesn't tag anyone.
 */

export const LATE_VOTING_HOURS = 24;
export const RECENT_SESSION_COUNT = 10;
export const FREQUENT_LATE_RATIO = 0.5;
export const MIN_SESSIONS_FOR_TAG = 3;

const HOUR_MS = 3_600_000;

export type LateVoting = "not-started" | "open" | "closed";

export function lateVotingClosesAt(startMs: number): number {
  return startMs + LATE_VOTING_HOURS * HOUR_MS;
}

export function lateVotingState(startMs: number, nowMs: number): LateVoting {
  if (nowMs < startMs) return "not-started";
  return nowMs < lateVotingClosesAt(startMs) ? "open" : "closed";
}

/** Reports needed to count as late: at least half of the other players (minimum 1). */
export function lateReportsNeeded(playerCount: number): number {
  return Math.max(1, Math.ceil((playerCount - 1) / 2));
}

export interface LateReport {
  reporterId: string;
  lateUserId: string;
}

export interface SessionLateRecord {
  sessionId: string;
  startMs: number;
  players: readonly string[];
  reports: readonly LateReport[];
}

/** Valid report counts per player: one per reporter, from other players in the session only. */
export function lateReportCounts(s: SessionLateRecord): Map<string, number> {
  return reportCounts(
    s.players,
    s.reports.map((r) => ({ reporterId: r.reporterId, targetId: r.lateUserId })),
  );
}

/** Counts per player from any kind of report about them (late, no-show): one per reporter, players only. */
export function reportCounts(
  playerIds: readonly string[],
  reports: ReadonlyArray<{ reporterId: string; targetId: string }>,
): Map<string, number> {
  const players = new Set(playerIds);
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  for (const r of reports) {
    if (r.reporterId === r.targetId || !players.has(r.reporterId) || !players.has(r.targetId)) continue;
    const key = `${r.reporterId}>${r.targetId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    counts.set(r.targetId, (counts.get(r.targetId) ?? 0) + 1);
  }
  return counts;
}

/** Players who were voted late in a session. */
export function lateInSession(s: SessionLateRecord): Set<string> {
  const needed = lateReportsNeeded(s.players.length);
  return new Set([...lateReportCounts(s)].filter(([, n]) => n >= needed).map(([id]) => id));
}

export interface LateStats {
  /** Sessions they were voted late in, among `sessions`. */
  late: number;
  /** How many of their recent (closed) sessions were considered, up to RECENT_SESSION_COUNT. */
  sessions: number;
  frequentlyLate: boolean;
}

export const NO_LATE_STATS: LateStats = { late: 0, sessions: 0, frequentlyLate: false };

/** Per-player lateness over each player's most recent sessions whose voting has closed. */
export function lateStats(records: readonly SessionLateRecord[], nowMs: number): Map<string, LateStats> {
  const closed = records
    .filter((r) => lateVotingState(r.startMs, nowMs) === "closed")
    .sort((a, b) => b.startMs - a.startMs);
  const history = new Map<string, boolean[]>(); // newest first
  for (const r of closed) {
    const late = lateInSession(r);
    for (const p of new Set(r.players)) {
      const flags = history.get(p) ?? [];
      if (flags.length < RECENT_SESSION_COUNT) flags.push(late.has(p));
      history.set(p, flags);
    }
  }
  const stats = new Map<string, LateStats>();
  for (const [player, flags] of history) {
    const late = flags.filter(Boolean).length;
    stats.set(player, {
      late,
      sessions: flags.length,
      frequentlyLate: flags.length >= MIN_SESSIONS_FOR_TAG && late / flags.length > FREQUENT_LATE_RATIO,
    });
  }
  return stats;
}
