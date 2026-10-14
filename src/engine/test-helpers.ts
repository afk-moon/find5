import { DateTime } from "luxon";
import type { MatchSettings, MemberInput, Weekday } from "./types";
import { makeHorizon } from "./availability";

export const NY = "America/New_York";
export const CHI = "America/Chicago";
export const PHX = "America/Phoenix";
export const LA = "America/Los_Angeles";

/** Same pattern every day of the week. */
export function everyDay(p: string): MemberInput["weekly"] {
  const weekly: MemberInput["weekly"] = {};
  for (let d = 1; d <= 7; d++) weekly[d as Weekday] = p;
  return weekly;
}

export function member(id: string, timezone: string, daily: string, extra: Partial<MemberInput> = {}): MemberInput {
  return { id, name: id, timezone, weekly: everyDay(daily), ...extra };
}

export function settings(over: Partial<MatchSettings> = {}): MatchSettings {
  return { partySize: 5, minSessionMinutes: 90, maxPauseMinutes: 30, ...over };
}

/** Horizon covering one local gaming day (8am → 4am) in `zone`. */
export function gamingDay(date: string, zone = NY) {
  const start = DateTime.fromISO(date, { zone }).set({ hour: 8 });
  return makeHorizon(start.toMillis(), start.plus({ hours: 20 }).toMillis());
}

export const clock = (ms: number, zone = NY) => DateTime.fromMillis(ms, { zone }).toFormat("HH:mm");
export const span = (w: { startMs: number; endMs: number }, zone = NY) =>
  `${clock(w.startMs, zone)}-${clock(w.endMs, zone)}`;
