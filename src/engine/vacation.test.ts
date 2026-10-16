import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { resolvePattern, vacationOn } from "./availability";
import { planAway } from "./away";
import { pattern } from "./patterns";
import { EMPTY_PATTERN } from "./time";
import type { MemberInput } from "./types";

const NY = "America/New_York";
const evening = pattern({ F: [["18:00", "23:00"]] });
/** Free every evening, away Oct 20–27 (inclusive). */
const member = (extra: Partial<MemberInput> = {}): MemberInput => ({
  id: "m",
  name: "M",
  timezone: NY,
  weekly: { 1: evening, 2: evening, 3: evening, 4: evening, 5: evening, 6: evening, 7: evening },
  vacations: [{ start: "2026-10-20", end: "2026-10-27" }],
  ...extra,
});

describe("vacation", () => {
  it("is busy on every day from the first to the last, and normal around it", () => {
    const m = member();
    expect(resolvePattern(m, "2026-10-19")).toBe(evening);
    for (const day of ["2026-10-20", "2026-10-23", "2026-10-27"]) expect(resolvePattern(m, day)).toBe(EMPTY_PATTERN);
    expect(resolvePattern(m, "2026-10-28")).toBe(evening);
    expect(vacationOn(m, "2026-10-23")).toEqual({ start: "2026-10-20", end: "2026-10-27" });
    expect(vacationOn(m, "2026-10-28")).toBeNull();
  });

  it("beats one-off days and WFH days", () => {
    const m = member({
      overrides: { "2026-10-21": pattern({ F: [["12:00", "23:00"]] }) },
      wfhPattern: pattern({ F: [["15:00", "23:00"]] }),
      hybridDays: { 4: "wfh" },
    });
    expect(resolvePattern(m, "2026-10-21")).toBe(EMPTY_PATTERN); // one-off day
    expect(resolvePattern(m, "2026-10-22")).toBe(EMPTY_PATTERN); // Thursday, always WFH
  });

  it("refuses /back with a time while away", () => {
    const at = (iso: string) => DateTime.fromISO(iso, { zone: NY }).toMillis();
    expect(() => planAway(member(), at("2026-10-22T17:00"), at("2026-10-22T21:00"))).toThrow(/on vacation until Oct 27/);
  });
});
