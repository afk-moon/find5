import { DateTime } from "luxon";
import {
  CELLS_PER_DAY,
  EMPTY_PATTERN,
  SLOT_MS,
  addDays,
  boundaryIndex,
  expandGamingDay,
  normalizePattern,
  weekdayOf,
} from "./time";
import type { CellState, Horizon, MemberInput } from "./types";

/** WFH if the date was picked (vote/manual) or the weekday is a fixed WFH day. */
export function isWfhDate(member: MemberInput, date: string): boolean {
  if (member.wfhDates?.has(date)) return true;
  return member.hybridDays?.[weekdayOf(date)] === "wfh";
}

/**
 * Which pattern applies on a local gaming day:
 *   date override  >  that weekday's WFH pattern  >  general WFH pattern (on WFH dates)  >  typical weekday.
 * The night before a WFH day, the evening is extended to `nightBeforeWfhUntil`.
 */
export function resolvePattern(member: MemberInput, date: string): string {
  const override = member.overrides?.[date];
  if (override != null) return normalizePattern(override);

  const weekday = weekdayOf(date);
  const wfh = isWfhDate(member, date) ? member.wfhWeekly?.[weekday] || member.wfhPattern : null;
  const base = wfh || member.weekly[weekday] || EMPTY_PATTERN;
  let p = normalizePattern(base);
  if (member.nightBeforeWfhUntil && isWfhDate(member, addDays(date, 1))) {
    p = extendEvening(p, member.nightBeforeWfhUntil);
  }
  return p;
}

/**
 * Stretch the end of the evening's availability to `until` (exclusive), only over busy cells.
 * Days with no availability stay empty: staying up later doesn't mean they planned to play.
 */
export function extendEvening(p: string, until: string): string {
  const end = boundaryIndex(until);
  const cells = p.split("");
  let last = -1;
  for (let i = CELLS_PER_DAY - 1; i >= 0; i--) {
    if (cells[i] === "F" || cells[i] === "M") {
      last = i;
      break;
    }
  }
  if (last < 0) return p;
  for (let i = last + 1; i < end && cells[i] === "."; i++) cells[i] = cells[last];
  return cells.join("");
}

/** Slot-aligned horizon covering [startMs, endMs). */
export function makeHorizon(startMs: number, endMs: number): Horizon {
  const start = Math.floor(startMs / SLOT_MS) * SLOT_MS;
  return { startMs: start, slots: Math.max(0, Math.ceil((endMs - start) / SLOT_MS)) };
}

/** Each member's state in every 30-minute UTC slot of the horizon. */
export function buildTimelines(members: readonly MemberInput[], horizon: Horizon): CellState[][] {
  const endMs = horizon.startMs + horizon.slots * SLOT_MS;
  return members.map((m) => {
    const row = new Array<CellState>(horizon.slots).fill(".");
    // The gaming day that started yesterday can still be running (it ends at 04:00).
    let day = DateTime.fromMillis(horizon.startMs, { zone: m.timezone }).startOf("day").minus({ days: 1 });
    const lastDay = DateTime.fromMillis(endMs, { zone: m.timezone }).startOf("day");
    while (day <= lastDay) {
      const date = day.toISODate()!;
      for (const [t, state] of expandGamingDay(date, m.timezone, resolvePattern(m, date))) {
        const k = (t - horizon.startMs) / SLOT_MS;
        if (Number.isInteger(k) && k >= 0 && k < horizon.slots) row[k] = state;
      }
      day = day.plus({ days: 1 });
    }
    return row;
  });
}
