import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { nextOccurrence, parseClockTime, planAway } from "./away";
import { pattern } from "./patterns";
import { EMPTY_PATTERN, cellInstant } from "./time";
import type { MemberInput } from "./types";

const NY = "America/New_York";
const at = (iso: string) => DateTime.fromISO(iso, { zone: NY }).toMillis();
const next = (text: string, nowIso: string) => nextOccurrence(parseClockTime(text)!, at(nowIso), NY);
/** Someone with the same day every day (2026-10-15 is a Thursday). */
const member = (day: string, extra: Partial<MemberInput> = {}): MemberInput => ({
  id: "m",
  name: "M",
  timezone: NY,
  weekly: { 1: day, 2: day, 3: day, 4: day, 5: day, 6: day, 7: day },
  ...extra,
});

describe("reading a typed time", () => {
  it("understands the usual ways of writing a time", () => {
    expect(parseClockTime("9pm")).toEqual([{ hour: 21, minute: 0 }]);
    expect(parseClockTime("9:30 PM")).toEqual([{ hour: 21, minute: 30 }]);
    expect(parseClockTime("930pm")).toEqual([{ hour: 21, minute: 30 }]);
    expect(parseClockTime("9 p.m.")).toEqual([{ hour: 21, minute: 0 }]);
    expect(parseClockTime("21:30")).toEqual([{ hour: 21, minute: 30 }]);
    expect(parseClockTime("0:30")).toEqual([{ hour: 0, minute: 30 }]);
    expect(parseClockTime("09:30")).toEqual([{ hour: 9, minute: 30 }]);
    expect(parseClockTime("12am")).toEqual([{ hour: 0, minute: 0 }]);
    expect(parseClockTime("12pm")).toEqual([{ hour: 12, minute: 0 }]);
    expect(parseClockTime("noon")).toEqual([{ hour: 12, minute: 0 }]);
    expect(parseClockTime("Midnight")).toEqual([{ hour: 0, minute: 0 }]);
  });

  it("keeps both readings of a bare hour", () => {
    expect(parseClockTime("9")).toEqual([
      { hour: 9, minute: 0 },
      { hour: 21, minute: 0 },
    ]);
    expect(parseClockTime("12")).toEqual([
      { hour: 0, minute: 0 },
      { hour: 12, minute: 0 },
    ]);
  });

  it("rejects things that aren't times", () => {
    for (const bad of ["", "soon", "25:00", "9:75", "13pm", "0am", "9:5"]) expect(parseClockTime(bad)).toBeNull();
  });
});

describe("when a time comes round next", () => {
  it("picks the next one tonight, after midnight included", () => {
    expect(next("9", "2026-10-15T18:10")).toBe(at("2026-10-15T21:00"));
    expect(next("1am", "2026-10-15T18:10")).toBe(at("2026-10-16T01:00"));
  });

  it("returns null once it has passed, and never matches 4–8am", () => {
    expect(next("5pm", "2026-10-15T18:10")).toBeNull();
    expect(next("6:30am", "2026-10-15T18:10")).toBeNull();
  });

  it("after midnight, an evening time means this evening", () => {
    expect(next("9pm", "2026-10-16T01:00")).toBe(at("2026-10-16T21:00"));
    expect(next("2am", "2026-10-16T01:00")).toBe(at("2026-10-16T02:00"));
  });

  it("before the day starts, a bare hour can still be this morning", () => {
    expect(next("9", "2026-10-15T06:00")).toBe(at("2026-10-15T09:00"));
  });

  it("turns cell boundaries back into instants", () => {
    expect(cellInstant("2026-10-15", 0, NY)).toBe(at("2026-10-15T08:00"));
    expect(cellInstant("2026-10-15", 32, NY)).toBe(at("2026-10-16T00:00"));
    expect(cellInstant("2026-10-15", 40, NY)).toBe(at("2026-10-16T04:00"));
  });
});

describe("away until a time", () => {
  it("is busy until then (dinner included) and joins the evening they'd planned", () => {
    const day = pattern({ F: [["12:00", "14:00"], ["18:00", "23:00"]], Q: [["19:00", "19:30"]] });
    const plan = planAway(member(day), at("2026-10-15T17:10"), at("2026-10-15T20:00"));
    // The afternoon is already over, so it stays as it was.
    expect(plan.overrides).toEqual([{ date: "2026-10-15", cells: pattern({ F: [["12:00", "14:00"], ["20:00", "23:00"]] }) }]);
    expect(plan).toMatchObject({
      date: "2026-10-15",
      laterDay: false,
      freeFromMs: at("2026-10-15T20:00"),
      freeUntilMs: at("2026-10-15T23:00"),
    });
  });

  it("fills the gap up to their next plans and leaves later plans alone", () => {
    const day = pattern({ F: [["18:00", "20:00"], ["22:00", "23:00"]], M: [["23:30", "00:30"]] });
    const plan = planAway(member(day), at("2026-10-15T17:00"), at("2026-10-15T21:00"));
    expect(plan.overrides[0].cells).toBe(pattern({ F: [["21:00", "23:00"]], M: [["23:30", "00:30"]] }));
    expect(plan.freeUntilMs).toBe(at("2026-10-15T23:00"));
  });

  it("with nothing planned later, is free until midnight, or for 2 hours if that's later", () => {
    const day = pattern({ F: [["18:00", "20:00"]] });
    const evening = planAway(member(day), at("2026-10-15T17:00"), at("2026-10-15T20:30"));
    expect(evening.overrides[0].cells).toBe(pattern({ F: [["20:30", "00:00"]] }));
    expect(evening.freeUntilMs).toBe(at("2026-10-16T00:00"));

    const late = planAway(member(day), at("2026-10-15T17:00"), at("2026-10-15T23:30"));
    expect(late.overrides[0].cells).toBe(pattern({ F: [["23:30", "01:30"]] }));
    expect(late.freeUntilMs).toBe(at("2026-10-16T01:30"));
  });

  it("rounds up to the next half hour", () => {
    const plan = planAway(member(EMPTY_PATTERN), at("2026-10-15T17:00"), at("2026-10-15T21:10"));
    expect(plan.freeFromMs).toBe(at("2026-10-15T21:30"));
    expect(plan.overrides[0].cells).toBe(pattern({ F: [["21:30", "00:00"]] }));
  });

  it("back on a later day (after midnight) clears the rest of tonight too", () => {
    const day = pattern({ F: [["18:00", "02:00"]] });
    const plan = planAway(member(day), at("2026-10-16T01:00"), at("2026-10-16T21:00"));
    expect(plan.overrides).toEqual([
      { date: "2026-10-15", cells: pattern({ F: [["18:00", "01:00"]] }) },
      { date: "2026-10-16", cells: pattern({ F: [["21:00", "02:00"]] }) },
    ]);
    expect(plan).toMatchObject({ date: "2026-10-16", laterDay: true, freeUntilMs: at("2026-10-17T02:00") });
  });

  it("'back now' frees them from the current half hour", () => {
    const day = pattern({ F: [["21:00", "23:00"]] });
    const plan = planAway(member(day), at("2026-10-15T19:40"), at("2026-10-15T19:30"));
    expect(plan.overrides[0].cells).toBe(pattern({ F: [["19:30", "23:00"]] }));
    expect(plan.freeFromMs).toBe(at("2026-10-15T19:30"));
  });

  it("starts from a one-off day they already set", () => {
    const m = member(EMPTY_PATTERN, { overrides: { "2026-10-15": pattern({ F: [["21:00", "00:00"]] }) } });
    const plan = planAway(m, at("2026-10-15T17:00"), at("2026-10-15T22:00"));
    expect(plan.overrides[0].cells).toBe(pattern({ F: [["22:00", "00:00"]] }));
  });

  it("saves nothing when the day already looks like that", () => {
    const plan = planAway(member(pattern({ F: [["21:00", "23:00"]] })), at("2026-10-15T17:00"), at("2026-10-15T21:00"));
    expect(plan.overrides).toEqual([]);
    expect(plan.freeUntilMs).toBe(at("2026-10-15T23:00"));
  });

  it("refuses times after the day ends", () => {
    expect(() => planAway(member(EMPTY_PATTERN), at("2026-10-15T17:00"), at("2026-10-16T03:45"))).toThrow(/ends at 4am/);
    expect(() => planAway(member(EMPTY_PATTERN), at("2026-10-15T17:00"), at("2026-10-16T05:00"))).toThrow(/8am and 4am/);
  });
});
