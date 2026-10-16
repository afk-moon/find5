import { DateTime } from "luxon";
import { CELLS_PER_DAY, DAY_START_HOUR, EMPTY_PATTERN, SLOT_MS, cellStart } from "./cells";
import type { CellState, Weekday } from "./types";

export {
  CELLS_PER_DAY,
  DAY_START_HOUR,
  EMPTY_PATTERN,
  SLOT_MINUTES,
  SLOT_MS,
  cellLabel,
  cellStart,
  setCell,
} from "./cells";

const VALID_CELLS = new Set<string>([".", "F", "M", "Q", "L"]);

/** Cell index (0–39) for a local wall-clock time, or -1 for 04:00–07:59 (outside every gaming day). */
export function cellIndexForWallTime(hour: number, minute: number): number {
  const idx = ((hour - DAY_START_HOUR + 24) % 24) * 2 + (minute >= 30 ? 1 : 0);
  return idx < CELLS_PER_DAY ? idx : -1;
}

/**
 * Index of an "HH:mm" time used as a range edge: "08:00" → 0, "00:00" (or "24:00") → 32, "04:00" → 40.
 * Times between 04:00 and 08:00 clamp to 40 (the end of the gaming day).
 */
export function boundaryIndex(hhmm: string): number {
  const [h, m = 0] = hhmm.split(":").map(Number);
  const hour = h % 24;
  if (hour >= 4 && hour < DAY_START_HOUR) return CELLS_PER_DAY;
  const idx = ((hour - DAY_START_HOUR + 24) % 24) * 2 + Math.round(m / 30);
  return Math.min(idx, CELLS_PER_DAY);
}

export function floorToSlot(ms: number): number {
  return Math.floor(ms / SLOT_MS) * SLOT_MS;
}

/** Coerce anything pattern-ish into exactly 40 valid cells. */
export function normalizePattern(p: string | null | undefined): string {
  if (!p) return EMPTY_PATTERN;
  let out = "";
  for (let i = 0; i < CELLS_PER_DAY; i++) {
    const c = p[i];
    out += c && VALID_CELLS.has(c) ? c : ".";
  }
  return out;
}

/** Weekday of a calendar date ("YYYY-MM-DD"); the same in every time zone. */
export function weekdayOf(date: string): Weekday {
  return DateTime.fromISO(date, { zone: "utc" }).weekday as Weekday;
}

export function addDays(date: string, days: number): string {
  return DateTime.fromISO(date, { zone: "utc" }).plus({ days }).toISODate()!;
}

/** UTC bounds [startMs, endMs) of the local gaming day that begins on `date`. */
export function gamingDayBounds(date: string, zone: string): { startMs: number; endMs: number } {
  const day = DateTime.fromISO(date, { zone });
  if (!day.isValid) throw new Error(`Invalid date or time zone: ${date} / ${zone}`);
  const start = day.set({ hour: DAY_START_HOUR });
  const end = day.plus({ days: 1 }).set({ hour: 4 });
  return { startMs: start.toMillis(), endMs: end.toMillis() };
}

/** The local gaming day an instant belongs to ("YYYY-MM-DD"), or null between 04:00 and 08:00. */
export function gamingDayOf(ms: number, zone: string): string | null {
  const local = DateTime.fromMillis(ms, { zone });
  if (local.hour >= 4 && local.hour < DAY_START_HOUR) return null;
  return (local.hour < 4 ? local.minus({ days: 1 }) : local).toISODate();
}

/** "Today" as a gaming day: the one that's on now (at 1am, still last night), or between 4am and 8am the one about to start. */
export function currentGamingDay(ms: number, zone: string): string {
  return gamingDayOf(ms, zone) ?? DateTime.fromMillis(ms, { zone }).toISODate()!;
}

/** The instant a cell boundary (0–40) happens on a local gaming day: 0 → 08:00, 32 → midnight, 40 → 04:00 next day. */
export function cellInstant(date: string, idx: number, zone: string): number {
  const { hour, minute } = cellStart(idx);
  const afterMidnight = idx >= (24 - DAY_START_HOUR) * 2;
  return DateTime.fromISO(date, { zone })
    .plus({ days: afterMidnight ? 1 : 0 })
    .set({ hour, minute })
    .toMillis();
}

/**
 * Expand one gaming day's local pattern into UTC slots by walking real time and looking up each
 * slot's wall-clock cell. The night clocks fall back, 1–2am happens twice and both get the 1–2am
 * cells; the night they spring forward, 2–3am never happens and is skipped. Nothing is lost or doubled.
 */
export function expandGamingDay(date: string, zone: string, pattern: string): Array<[number, CellState]> {
  const { startMs, endMs } = gamingDayBounds(date, zone);
  const out: Array<[number, CellState]> = [];
  for (let t = floorToSlot(startMs); t < endMs; t += SLOT_MS) {
    const local = DateTime.fromMillis(t, { zone });
    const idx = cellIndexForWallTime(local.hour, local.minute);
    if (idx < 0) continue;
    const state = pattern[idx] as CellState | undefined;
    if (state && state !== ".") out.push([t, state]);
  }
  return out;
}
