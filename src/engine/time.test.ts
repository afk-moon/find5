import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { pattern } from "./patterns";
import {
  boundaryIndex,
  cellIndexForWallTime,
  cellLabel,
  expandGamingDay,
  gamingDayBounds,
  gamingDayOf,
} from "./time";

const NY = "America/New_York";
const iso = (ms: number) => new Date(ms).toISOString();

describe("gaming-day cells", () => {
  it("maps wall-clock times to 8am → 4am cells", () => {
    expect(cellIndexForWallTime(8, 0)).toBe(0);
    expect(cellIndexForWallTime(23, 30)).toBe(31);
    expect(cellIndexForWallTime(0, 0)).toBe(32);
    expect(cellIndexForWallTime(3, 30)).toBe(39);
    expect(cellIndexForWallTime(4, 0)).toBe(-1);
    expect(cellIndexForWallTime(7, 30)).toBe(-1);
  });

  it("parses range edges and labels cells", () => {
    expect(boundaryIndex("08:00")).toBe(0);
    expect(boundaryIndex("18:30")).toBe(21);
    expect(boundaryIndex("00:00")).toBe(32);
    expect(boundaryIndex("24:00")).toBe(32);
    expect(boundaryIndex("04:00")).toBe(40);
    expect(boundaryIndex("06:00")).toBe(40);
    expect(cellLabel(21)).toBe("6:30pm");
    expect(cellLabel(32)).toBe("12am");
  });
});

describe("DST-safe expansion", () => {
  it("fall-back night is 21 hours long and repeats 1–2am", () => {
    const { startMs, endMs } = gamingDayBounds("2026-10-31", NY);
    expect(iso(startMs)).toBe("2026-10-31T12:00:00.000Z"); // 8am EDT
    expect(iso(endMs)).toBe("2026-11-01T09:00:00.000Z"); // 4am EST
    const slots = expandGamingDay("2026-10-31", NY, pattern({ F: [["23:00", "02:00"]] }));
    expect(slots.map(([t]) => iso(t))).toEqual([
      "2026-11-01T03:00:00.000Z", // 11pm EDT
      "2026-11-01T03:30:00.000Z",
      "2026-11-01T04:00:00.000Z", // midnight EDT
      "2026-11-01T04:30:00.000Z",
      "2026-11-01T05:00:00.000Z", // 1am EDT
      "2026-11-01T05:30:00.000Z",
      "2026-11-01T06:00:00.000Z", // 1am EST, the second time around
      "2026-11-01T06:30:00.000Z",
    ]);
  });

  it("spring-forward night skips 2–3am", () => {
    const { startMs, endMs } = gamingDayBounds("2027-03-13", NY);
    expect((endMs - startMs) / 3_600_000).toBe(19);
    const slots = expandGamingDay("2027-03-13", NY, pattern({ F: [["01:00", "03:30"]] }));
    expect(slots.map(([t]) => iso(t))).toEqual([
      "2027-03-14T06:00:00.000Z", // 1am EST
      "2027-03-14T06:30:00.000Z",
      "2027-03-14T07:00:00.000Z", // 3am EDT (2am never happens)
    ]);
  });

  it("assigns after-midnight instants to the previous gaming day", () => {
    expect(gamingDayOf(DateTime.fromISO("2026-10-21T01:30", { zone: NY }).toMillis(), NY)).toBe("2026-10-20");
    expect(gamingDayOf(DateTime.fromISO("2026-10-21T05:00", { zone: NY }).toMillis(), NY)).toBeNull();
  });
});
