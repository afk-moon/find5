import { DateTime } from "luxon";
import { resolvePattern } from "./availability";
import { CELLS_PER_DAY, DAY_START_HOUR, cellIndexForWallTime, cellInstant, gamingDayBounds, gamingDayOf } from "./time";
import type { MemberInput } from "./types";

/** A local wall-clock time on the 24-hour clock. */
export interface ClockTime {
  hour: number;
  minute: number;
}

/** Cell index of midnight, where "tonight" usually ends. */
const MIDNIGHT = (24 - DAY_START_HOUR) * 2;
/** With nothing planned after they're back, they're free for at least 2 hours. */
const MIN_FREE_CELLS = 4;

/**
 * Read a typed time: "9pm", "9:30 pm", "930pm", "9 p.m.", "21:30", "noon" or "midnight".
 * A bare "9" or "9:30" could be morning or evening, so both readings come back and the caller picks
 * whichever comes next. Returns null if it isn't a time.
 */
export function parseClockTime(input: string): ClockTime[] | null {
  const s = input.toLowerCase().replace(/[\s.]/g, "");
  if (s === "noon") return [{ hour: 12, minute: 0 }];
  if (s === "midnight") return [{ hour: 0, minute: 0 }];
  const m = /^(\d{1,2})(?::?(\d{2}))?(am|pm|a|p)?$/.exec(s);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2] ?? 0);
  if (minute > 59) return null;
  if (m[3]) {
    if (hour < 1 || hour > 12) return null;
    return [{ hour: (hour % 12) + (m[3].startsWith("p") ? 12 : 0), minute }];
  }
  if (hour > 23) return null;
  // 24-hour clock: "21:30", "0:30", "09:30".
  if (hour === 0 || hour > 12 || m[1].startsWith("0")) return [{ hour, minute }];
  return [
    { hour: hour % 12, minute },
    { hour: (hour % 12) + 12, minute },
  ];
}

/**
 * The next time one of `times` comes round in `zone`, no later than the end of today's gaming day
 * (4am tomorrow). At 6pm, "9pm" is tonight and "1am" is after midnight; after midnight, "9pm" is this
 * evening. Null if it already passed. Times between 4am and 8am are outside every gaming day.
 */
export function nextOccurrence(times: readonly ClockTime[], nowMs: number, zone: string): number | null {
  const today = DateTime.fromMillis(nowMs, { zone }).startOf("day");
  const limit = gamingDayBounds(today.toISODate()!, zone).endMs;
  let best: number | null = null;
  for (const days of [0, 1]) {
    for (const { hour, minute } of times) {
      if (cellIndexForWallTime(hour, minute) < 0) continue;
      const ms = today.plus({ days }).set({ hour, minute }).toMillis();
      if (ms > nowMs && ms < limit && (best === null || ms < best)) best = ms;
    }
  }
  return best;
}

export interface AwayPlan {
  /** Date overrides to save: the day they're back, plus the rest of tonight when that's a later day. */
  overrides: Array<{ date: string; cells: string }>;
  /** The gaming day they're back on. */
  date: string;
  /** True when they're back on a later gaming day than the one that's on now (e.g. it's 1am, back at 9pm). */
  laterDay: boolean;
  /** They're free from here (when they're back, rounded up to the half hour)… */
  freeFromMs: number;
  /** …until here. */
  freeUntilMs: number;
}

/**
 * Turn "away until `backMs`" into date overrides for `member`:
 * - From now until they're back, they're busy (dinners in that stretch are dropped too).
 * - From the half hour they're back (rounded up), they're free. If they planned to play later that day,
 *   the busy stretch right before it is filled in so it joins up; otherwise they're free until midnight,
 *   or for 2 hours if that's later (4am at the latest).
 * - Hours that are already over, and plans after the free stretch, are left alone.
 * For "back now", pass the start of the current half hour as `backMs`.
 */
export function planAway(member: MemberInput, nowMs: number, backMs: number): AwayPlan {
  const zone = member.timezone;
  const date = gamingDayOf(backMs, zone);
  if (!date) throw new Error("Pick a time between 8am and 4am.");
  const back = DateTime.fromMillis(backMs, { zone });
  const onTheDot = back.minute % 30 === 0 && back.second === 0 && back.millisecond === 0;
  const backIdx = cellIndexForWallTime(back.hour, back.minute) + (onTheDot ? 0 : 1);
  if (backIdx >= CELLS_PER_DAY) throw new Error("That's too late. The day ends at 4am.");

  const nowDate = gamingDayOf(nowMs, zone);
  const now = DateTime.fromMillis(nowMs, { zone });
  const nowIdx = nowDate ? cellIndexForWallTime(now.hour, now.minute) : 0;
  const laterDay = nowDate !== null && nowDate !== date;
  const overrides: AwayPlan["overrides"] = [];

  if (laterDay) {
    // Away for the rest of tonight too.
    const tonight = resolvePattern(member, nowDate);
    const cells = tonight.slice(0, nowIdx) + ".".repeat(CELLS_PER_DAY - nowIdx);
    if (cells !== tonight) overrides.push({ date: nowDate, cells });
  }

  const base = resolvePattern(member, date);
  const cells = base.split("");
  for (let i = laterDay ? 0 : nowIdx; i < backIdx; i++) cells[i] = ".";
  if (cells.slice(backIdx).some((c) => c === "F" || c === "M")) {
    for (let i = backIdx; i < CELLS_PER_DAY && cells[i] === "."; i++) cells[i] = "F";
  } else {
    const end = Math.min(CELLS_PER_DAY, Math.max(MIDNIGHT, backIdx + MIN_FREE_CELLS));
    for (let i = backIdx; i < end; i++) if (cells[i] === ".") cells[i] = "F";
  }
  const result = cells.join("");
  if (result !== base) overrides.push({ date, cells: result });

  let end = backIdx;
  while (end < CELLS_PER_DAY && cells[end] !== ".") end++;
  return {
    overrides,
    date,
    laterDay,
    freeFromMs: cellInstant(date, backIdx, zone),
    freeUntilMs: cellInstant(date, end, zone),
  };
}
