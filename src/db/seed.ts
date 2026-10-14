import { DateTime } from "luxon";
import { pattern } from "@/engine/patterns";
import type { HybridMode, Weekday } from "@/engine/types";
import type { DB } from "./index";
import {
  dayPatterns,
  groups,
  hybridDays,
  memberProfiles,
  memberships,
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

export async function seedDemo(db: DB) {
  await db.insert(groups).values({ id: DEMO_GROUP_ID, name: "Valorant Squad", homeTimezone: HOME_ZONE });

  for (const [i, m] of DEMO_MEMBERS.entries()) {
    await db.insert(user).values({ id: m.id, name: m.name, email: `${m.id}@demo.fivestack.local` });
    await db.insert(memberProfiles).values({
      userId: m.id,
      timezone: m.timezone,
      color: m.color,
      workStyle: m.hybrid ? "hybrid" : "fixed",
      nightBeforeWfhUntil: m.nightBeforeWfhUntil ?? null,
    });
    await db.insert(memberships).values({ groupId: DEMO_GROUP_ID, userId: m.id, role: i === 0 ? "owner" : "member" });

    const rows = Object.entries(m.weekly).map(([d, cells]) => ({ userId: m.id, key: `w${d}`, cells }));
    if (m.wfh) rows.push({ userId: m.id, key: "wfh", cells: m.wfh });
    await db.insert(dayPatterns).values(rows);

    if (m.hybrid) {
      await db.insert(hybridDays).values(
        Object.entries(m.hybrid).map(([d, mode]) => ({ userId: m.id, weekday: Number(d), mode })),
      );
    }
  }

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
}
