/**
 * Core types for the scheduling engine. The engine is pure TypeScript (no DB, no framework)
 * so it can be unit-tested and shared by the web app and the Discord bot.
 */

/** One 30-minute cell in a member's day pattern. */
export type CellState =
  | "." // busy / unavailable (default)
  | "F" // free
  | "M" // "if needed": would play, but would rather not
  | "Q" // quick dinner: the party pauses and waits, then continues
  | "L"; // long dinner: the player leaves, so the session splits

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** How a hybrid worker treats a weekday. */
export type HybridMode = "office" | "wfh" | "flex";

export interface MemberInput {
  id: string;
  name: string;
  /** IANA time zone, e.g. "America/Chicago". Never a fixed offset or "EST" (those break across DST). */
  timezone: string;
  /** Typical week: weekday → 40-cell local pattern (08:00 → 04:00 next morning). Missing = busy. */
  weekly: Partial<Record<Weekday, string>>;
  /** Pattern used on WFH dates (hybrid members). Falls back to the weekday pattern. */
  wfhPattern?: string | null;
  /** WFH pattern for a specific weekday (WFH Mondays can differ from WFH Fridays). Beats `wfhPattern`. */
  wfhWeekly?: Partial<Record<Weekday, string>>;
  /** One-off patterns keyed by local gaming-day date "YYYY-MM-DD". Highest priority. */
  overrides?: Readonly<Record<string, string>>;
  /** Hybrid schedule for Mon–Fri. "wfh" days are always WFH; "flex" days can be voted on. */
  hybridDays?: Partial<Record<Weekday, HybridMode>>;
  /** Confirmed WFH dates ("YYYY-MM-DD"), from votes or manual picks. */
  wfhDates?: ReadonlySet<string>;
  /** "HH:mm" local. The night before a WFH day, the evening's availability extends to this time. */
  nightBeforeWfhUntil?: string | null;
  /** Time away: busy on every gaming day from `start` to `end` ("YYYY-MM-DD", inclusive). Beats everything. */
  vacations?: ReadonlyArray<{ start: string; end: string }>;
}

export interface MatchSettings {
  /** Players needed for a party (5 for a Valorant stack). */
  partySize: number;
  /** Minimum *play* time for a session to be worth suggesting (pauses don't count). */
  minSessionMinutes: number;
  /** Longest pause the party will wait out (quick dinners longer than this count as long). */
  maxPauseMinutes: number;
}

/** A run of 30-minute UTC slots starting at a slot-aligned instant. */
export interface Horizon {
  startMs: number;
  slots: number;
}
