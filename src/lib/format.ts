import { DateTime } from "luxon";

export { US_TIMEZONES } from "./zones";

const ZONE_ABBR: Record<string, string> = {
  "America/New_York": "ET",
  "America/Detroit": "ET",
  "America/Indiana/Indianapolis": "ET",
  "America/Toronto": "ET",
  "America/Chicago": "CT",
  "America/Denver": "MT",
  "America/Boise": "MT",
  "America/Phoenix": "AZ",
  "America/Los_Angeles": "PT",
  "America/Anchorage": "AKT",
  "Pacific/Honolulu": "HT",
};

/** Friendly zone label: "ET", "PT", "AZ"… (falls back to the offset name). */
export function zoneAbbr(zone: string, atMs = Date.now()): string {
  return ZONE_ABBR[zone] ?? DateTime.fromMillis(atMs, { zone }).toFormat("ZZZZ");
}

export function isValidZone(zone: string): boolean {
  return DateTime.now().setZone(zone).isValid;
}

/** "6pm", "6:30pm" */
export function fmtTime(ms: number, zone: string): string {
  const d = DateTime.fromMillis(ms, { zone });
  return d.toFormat(d.minute ? "h:mma" : "ha").toLowerCase();
}

/** "6:30–9pm", "11am–1:30pm", "10pm–1am" */
export function fmtRange(startMs: number, endMs: number, zone: string): string {
  const a = DateTime.fromMillis(startMs, { zone });
  const b = DateTime.fromMillis(endMs, { zone });
  const left = fmtTime(startMs, zone);
  const right = fmtTime(endMs, zone);
  const sameHalf = a.hour < 12 === b.hour < 12 && endMs - startMs < 12 * 3_600_000 && b.day === a.day;
  return sameHalf ? `${left.replace(/[ap]m$/, "")}–${right}` : `${left}–${right}`;
}

/** "Thu Oct 15" */
export function fmtDay(ms: number, zone: string): string {
  return DateTime.fromMillis(ms, { zone }).toFormat("ccc LLL d");
}

/** "Thursday" */
export function fmtWeekdayLong(ms: number, zone: string): string {
  return DateTime.fromMillis(ms, { zone }).toFormat("cccc");
}

/** "Oct 19" for a "YYYY-MM-DD" date */
export function fmtDate(date: string): string {
  return DateTime.fromISO(date, { zone: "utc" }).toFormat("LLL d");
}

/** 90 → "1h 30m", 120 → "2h", 30 → "30m" */
export function fmtDuration(minutes: number): string {
  const sign = minutes < 0 ? "−" : "";
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return sign + (h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`);
}

/** "in 25 min", "in 2h 5m", "3 min ago" */
export function fmtRelative(ms: number, nowMs = Date.now()): string {
  const mins = Math.round((ms - nowMs) / 60_000);
  if (mins === 0) return "now";
  return mins > 0 ? `in ${fmtDuration(mins).replace(/m$/, " min")}` : `${fmtDuration(-mins).replace(/m$/, " min")} ago`;
}

/** Discord renders <t:unix:style> in each reader's own time zone. */
export function discordTs(ms: number, style: "t" | "T" | "d" | "D" | "f" | "F" | "R" = "t"): string {
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

export const WEEKDAY_SHORT = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
export const WEEKDAY_LONG = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
