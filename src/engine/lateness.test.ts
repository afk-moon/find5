import { describe, expect, it } from "vitest";
import {
  lateInSession,
  lateReportCounts,
  lateReportsNeeded,
  lateStats,
  lateVotingState,
  type SessionLateRecord,
} from "./lateness";

const H = 3_600_000;
const D = 24 * H;
const NOW = Date.parse("2026-10-20T12:00:00Z");
const PARTY = ["A", "B", "C", "D", "E"];

/** A session `daysAgo` days back where each listed player was reported by the given reporters. */
function session(daysAgo: number, late: Record<string, string[]> = {}, players = PARTY): SessionLateRecord {
  return {
    sessionId: `s${daysAgo}`,
    startMs: NOW - daysAgo * D,
    players,
    reports: Object.entries(late).flatMap(([lateUserId, by]) => by.map((reporterId) => ({ reporterId, lateUserId }))),
  };
}

describe("late voting window", () => {
  it("opens at the start time and closes 24 hours later", () => {
    expect(lateVotingState(NOW + 1, NOW)).toBe("not-started");
    expect(lateVotingState(NOW, NOW)).toBe("open");
    expect(lateVotingState(NOW - 24 * H + 1, NOW)).toBe("open");
    expect(lateVotingState(NOW - 24 * H, NOW)).toBe("closed");
  });

  it("needs at least half of the other players", () => {
    expect(lateReportsNeeded(5)).toBe(2); // 2 of the other 4
    expect(lateReportsNeeded(6)).toBe(3); // 3 of the other 5
    expect(lateReportsNeeded(2)).toBe(1);
    expect(lateReportsNeeded(1)).toBe(1);
  });
});

describe("counting reports", () => {
  it("ignores self-reports, outsiders, and duplicates", () => {
    const s: SessionLateRecord = {
      sessionId: "x",
      startMs: NOW,
      players: PARTY,
      reports: [
        { reporterId: "A", lateUserId: "E" },
        { reporterId: "A", lateUserId: "E" }, // duplicate
        { reporterId: "E", lateUserId: "E" }, // self
        { reporterId: "Z", lateUserId: "E" }, // not in the session
        { reporterId: "B", lateUserId: "Z" }, // reported someone not in the session
      ],
    };
    expect(Object.fromEntries(lateReportCounts(s))).toEqual({ E: 1 });
  });

  it("marks someone late only once enough players agree", () => {
    expect(lateInSession(session(1, { E: ["A"] }))).toEqual(new Set());
    expect(lateInSession(session(1, { E: ["A", "B"] }))).toEqual(new Set(["E"]));
  });
});

describe("frequently late", () => {
  it("tags players late in more than half of their last 10 sessions", () => {
    const records = Array.from({ length: 10 }, (_, i) => session(i + 2, i < 6 ? { E: ["A", "B"] } : {}));
    const e = lateStats(records, NOW).get("E")!;
    expect(e).toEqual({ late: 6, sessions: 10, frequentlyLate: true });
    expect(lateStats(records, NOW).get("A")).toEqual({ late: 0, sessions: 10, frequentlyLate: false });
  });

  it("requires strictly more than half", () => {
    const records = Array.from({ length: 10 }, (_, i) => session(i + 2, i < 5 ? { E: ["A", "B"] } : {}));
    expect(lateStats(records, NOW).get("E")).toMatchObject({ late: 5, frequentlyLate: false });
  });

  it("only looks at the most recent 10 sessions", () => {
    const recent = Array.from({ length: 10 }, (_, i) => session(i + 2)); // on time lately
    const old = Array.from({ length: 10 }, (_, i) => session(i + 20, { E: ["A", "B", "C"] })); // late long ago
    expect(lateStats([...old, ...recent], NOW).get("E")).toEqual({ late: 0, sessions: 10, frequentlyLate: false });
  });

  it("waits for voting to close before counting a session", () => {
    const records = [session(0.5, { E: ["A", "B"] }), session(2, { E: ["A", "B"] }), session(3, { E: ["A", "B"] })];
    // The session from 12 hours ago is still open, so only two sessions count: below the 3-session minimum.
    expect(lateStats(records, NOW).get("E")).toEqual({ late: 2, sessions: 2, frequentlyLate: false });
    expect(lateStats([...records, session(4)], NOW).get("E")).toEqual({ late: 2, sessions: 3, frequentlyLate: true });
  });

  it("only counts sessions each player was actually in", () => {
    const records = [
      session(2, { E: ["A", "B"] }),
      session(3, {}, ["A", "B", "C", "D", "F"]), // E wasn't there
      session(4, { E: ["C", "D"] }),
      session(5),
    ];
    expect(lateStats(records, NOW).get("E")).toEqual({ late: 2, sessions: 3, frequentlyLate: true });
    expect(lateStats(records, NOW).get("F")).toEqual({ late: 0, sessions: 1, frequentlyLate: false });
  });
});
