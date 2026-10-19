import { DateTime } from "luxon";
import { pattern } from "@/engine/patterns";
import type { HybridMode, Weekday } from "@/engine/types";
import { DEFAULT_GAMES, defaultGameId, defaultGameRows } from "@/lib/games";
import type { DB } from "./index";
import {
  dayPatterns,
  games,
  groups,
  hybridDays,
  lateReports,
  memberGames,
  memberProfiles,
  memberships,
  playSessionPlayers,
  playSessions,
  user,
  wfhBallots,
  wfhVotes,
} from "./schema";

type Week = Partial<Record<Weekday, string>>;

interface DemoMember {
  id: string;
  name: string;
  timezone: string;
  color: string;
  weekly: Week;
  wfh?: string;
  hybrid?: Partial<Record<Weekday, HybridMode>>;
  nightBeforeWfhUntil?: string;
}

const weekdays = (p: string): Week => ({ 1: p, 2: p, 3: p, 4: p, 5: p });

/**
 * Five friends across ET / CT / Arizona / PT. Highlights:
 *  - weekday overlap is ~6:30–9pm PT, with Kai's quick dinner as a pause
 *  - Saturday splits around Maya's and Kai's long dinners; Sunday splits around Dev's
 *  - Sam has class Wednesdays, so Wednesday only works if Maya can stay up later
 *  - Maya and Kai are hybrid: WFH Thursday for both unlocks the most extra play time
 */
export const DEMO_MEMBERS: DemoMember[] = [
  {
    id: "demo-maya",
    name: "Maya",
    timezone: "America/New_York",
    color: "#ff4655",
    weekly: {
      ...weekdays(pattern({ F: [["18:30", "00:00"]], Q: [["19:30", "20:00"]] })),
      6: pattern({ F: [["11:00", "01:00"]], L: [["18:00", "19:30"]] }),
      7: pattern({ F: [["12:00", "22:00"]], Q: [["18:00", "18:30"]] }),
    },
    wfh: pattern({ F: [["17:00", "00:00"]], Q: [["18:30", "19:00"]] }),
    hybrid: { 1: "flex", 2: "office", 3: "office", 4: "flex", 5: "flex" },
    nightBeforeWfhUntil: "01:00",
  },
  {
    id: "demo-dev",
    name: "Dev",
    timezone: "America/Chicago",
    color: "#3b82f6",
    weekly: {
      ...weekdays(pattern({ F: [["17:30", "23:30"]], Q: [["18:30", "19:00"]] })),
      5: pattern({ F: [["17:30", "00:30"]], Q: [["18:30", "19:00"]] }),
      6: pattern({ F: [["13:00", "01:00"]], Q: [["18:30", "19:00"]] }),
      7: pattern({ F: [["12:00", "23:00"]], L: [["18:00", "19:30"]] }),
    },
  },
  {
    id: "demo-rosa",
    name: "Rosa",
    timezone: "America/Phoenix",
    color: "#f59e0b",
    weekly: {
      ...weekdays(pattern({ F: [["17:00", "23:00"]], Q: [["18:00", "18:30"]] })),
      5: pattern({ F: [["17:00", "00:00"]], Q: [["18:00", "18:30"]] }),
      6: pattern({ F: [["10:00", "23:00"]], Q: [["18:00", "18:30"]] }),
      7: pattern({ F: [["10:00", "23:00"]], Q: [["18:00", "18:30"]] }),
    },
  },
  {
    id: "demo-kai",
    name: "Kai",
    timezone: "America/Los_Angeles",
    color: "#10b981",
    weekly: {
      ...weekdays(pattern({ F: [["18:00", "23:30"]], Q: [["19:30", "20:00"]] })),
      6: pattern({ F: [["10:00", "00:00"]], L: [["18:00", "19:30"]] }),
      7: pattern({ F: [["10:00", "23:00"]], Q: [["18:00", "18:30"]] }),
    },
    wfh: pattern({ F: [["16:30", "23:30"]], Q: [["18:00", "18:30"]] }),
    hybrid: { 1: "office", 2: "flex", 3: "office", 4: "flex", 5: "wfh" },
  },
  {
    id: "demo-sam",
    name: "Sam",
    timezone: "America/Los_Angeles",
    color: "#a78bfa",
    weekly: {
      ...weekdays(pattern({ F: [["15:00", "01:00"]], Q: [["18:00", "18:30"]] })),
      3: pattern({ F: [["19:30", "01:00"]] }), // class until 7pm
      6: pattern({ F: [["12:00", "01:00"]], Q: [["18:00", "18:30"]] }),
      7: pattern({ F: [["12:00", "01:00"]], Q: [["18:00", "18:30"]] }),
    },
  },
];

export const DEMO_GROUP_ID = "demo-squad";
const HOME_ZONE = "America/Chicago";

/** Who plays what: everyone plays Valorant, TFT is a duo, Aion 2 has its four, and League is one short. */
const DEMO_PLAYERS: Record<(typeof DEFAULT_GAMES)[number]["slug"], string[]> = {
  valorant: ["demo-maya", "demo-dev", "demo-rosa", "demo-kai", "demo-sam"],
  lol: ["demo-maya", "demo-dev", "demo-kai", "demo-sam"],
  tft: ["demo-maya", "demo-rosa"],
  aion2: ["demo-dev", "demo-rosa", "demo-kai", "demo-sam"],
};

/**
 * Past locked-in sessions (6:30pm PT, all five players) and who reported whom as late.
 * Sam counts as late in 6 of the last 10 (frequently late); Dev in 1. One report alone never counts,
 * and the 11th session is too old to matter. Sam keeps 6 of 10 even after the open session below closes.
 */
const LATE_HISTORY: Array<{ daysAgo: number; late?: Record<string, string[]> }> = [
  { daysAgo: 2, late: { "demo-sam": ["demo-maya", "demo-kai"] } },
  { daysAgo: 3 },
  { daysAgo: 4, late: { "demo-sam": ["demo-dev", "demo-rosa", "demo-kai"] } },
  { daysAgo: 5, late: { "demo-sam": ["demo-maya", "demo-rosa"] } },
  { daysAgo: 6, late: { "demo-dev": ["demo-sam", "demo-kai"], "demo-sam": ["demo-rosa"] } },
  { daysAgo: 8, late: { "demo-sam": ["demo-maya", "demo-dev"] } },
  { daysAgo: 9, late: { "demo-sam": ["demo-kai"] } },
  { daysAgo: 12, late: { "demo-sam": ["demo-rosa", "demo-kai"] } },
  { daysAgo: 13, late: { "demo-sam": ["demo-maya", "demo-dev", "demo-rosa", "demo-kai"] } },
  { daysAgo: 15 },
  { daysAgo: 16, late: { "demo-sam": ["demo-maya", "demo-kai"] } },
];

async function seedSession(
  db: DB,
  startMs: number,
  minutes: number,
  status: "active" | "ended",
  late: Record<string, string[]> = {},
) {
  const [session] = await db
    .insert(playSessions)
    .values({
      groupId: DEMO_GROUP_ID,
      gameId: defaultGameId("valorant", DEMO_GROUP_ID),
      kind: "planned",
      status,
      startAt: new Date(startMs),
      endAt: new Date(startMs + minutes * 60_000),
      plan: { playMinutes: minutes, subs: 0, pauses: [] },
      createdBy: "demo-maya",
    })
    .returning({ id: playSessions.id });
  await db
    .insert(playSessionPlayers)
    .values(DEMO_MEMBERS.map((m) => ({ sessionId: session.id, userId: m.id, status: "in" as const })));
  const reports = Object.entries(late).flatMap(([lateUserId, by]) =>
    by.map((reporterId) => ({ sessionId: session.id, reporterId, lateUserId })),
  );
  if (reports.length) await db.insert(lateReports).values(reports);
}

export async function seedDemo(db: DB) {
  await db.insert(groups).values({ id: DEMO_GROUP_ID, name: "Valorant Squad", homeTimezone: HOME_ZONE });
  const seededAt = Date.now() - 60_000;
  await db.insert(games).values(defaultGameRows(DEMO_GROUP_ID, seededAt));

  for (const [i, m] of DEMO_MEMBERS.entries()) {
    await db.insert(user).values({ id: m.id, name: m.name, email: `${m.id}@demo.receptionist.local` });
    await db.insert(memberProfiles).values({
      userId: m.id,
      timezone: m.timezone,
      color: m.color,
      workStyle: m.hybrid ? "hybrid" : "fixed",
      nightBeforeWfhUntil: m.nightBeforeWfhUntil ?? null,
    });
    // Explicit, increasing join times keep the members in this order (inserts in the same millisecond
    // would tie and sort by name), and before anyone who joins later.
    const joinedAt = new Date(seededAt + i * 1000);
    await db
      .insert(memberships)
      .values({ groupId: DEMO_GROUP_ID, userId: m.id, role: i === 0 ? "owner" : "member", joinedAt });

    const rows = Object.entries(m.weekly).map(([d, cells]) => ({ userId: m.id, key: `w${d}`, cells }));
    if (m.wfh) rows.push({ userId: m.id, key: "wfh", cells: m.wfh });
    await db.insert(dayPatterns).values(rows);

    if (m.hybrid) {
      await db.insert(hybridDays).values(
        Object.entries(m.hybrid).map(([d, mode]) => ({ userId: m.id, weekday: Number(d), mode })),
      );
    }
  }
  await db.insert(memberGames).values(
    Object.entries(DEMO_PLAYERS).flatMap(([slug, ids]) =>
      ids.map((userId) => ({ userId, gameId: defaultGameId(slug, DEMO_GROUP_ID) })),
    ),
  );

  // One-off: Dev is out until 9pm CT this coming Friday.
  const now = DateTime.now().setZone(HOME_ZONE);
  const friday = now.plus({ days: (5 - now.weekday + 7) % 7 }).toISODate()!;
  await db.insert(dayPatterns).values({
    userId: "demo-dev",
    key: `d:${friday}`,
    cells: pattern({ F: [["21:00", "00:30"]] }),
  });

  // Next week's WFH vote is open, and Kai already picked Thursday.
  const nextMonday = now.startOf("week").plus({ weeks: 1 }).toISODate()!;
  const [vote] = await db
    .insert(wfhVotes)
    .values({ groupId: DEMO_GROUP_ID, weekStart: nextMonday })
    .returning({ id: wfhVotes.id });
  await db.insert(wfhBallots).values({ voteId: vote.id, userId: "demo-kai", days: [4] });

  // Late-check history, plus a session that started 1.5–2h ago so its late check is open right away
  // (Maya already reported Sam; one more report would make it count).
  const pacific = DateTime.now().setZone("America/Los_Angeles");
  for (const { daysAgo, late } of LATE_HISTORY) {
    const start = pacific.minus({ days: daysAgo }).set({ hour: 18, minute: 30, second: 0, millisecond: 0 });
    await seedSession(db, start.toMillis(), 150, "ended", late);
  }
  const halfHour = 30 * 60_000;
  const recentStart = Math.floor((Date.now() - 90 * 60_000) / halfHour) * halfHour;
  await seedSession(db, recentStart, 180, "active", { "demo-sam": ["demo-maya"] });
}
