import { describe, expect, it } from "vitest";
import { makeHorizon } from "./availability";
import { findWindows, sessionTimeline } from "./match";
import { pattern } from "./patterns";
import { LA, NY, PHX, clock, gamingDay, member, settings, span } from "./test-helpers";
import type { MemberInput } from "./types";

const EVENING = pattern({ F: [["18:00", "22:00"]] });
const TUE = "2026-10-20"; // well before DST ends
const withDinner = (kind: "Q" | "L", from: string, to: string) =>
  pattern({ F: [["18:00", "22:00"]], [kind]: [[from, to]] });
const five = (overrides: Record<string, string> = {}) =>
  ["A", "B", "C", "D", "E"].map((id) => member(id, NY, overrides[id] ?? EVENING));

describe("quorum windows", () => {
  it("finds the evening when all five overlap", () => {
    const ws = findWindows(five(), gamingDay(TUE), settings());
    expect(ws.map((w) => span(w))).toEqual(["18:00-22:00"]);
    expect(ws[0]).toMatchObject({ playMinutes: 240, subs: 0, pauses: [], ifNeeded: [] });
  });

  it("requires the SAME five people, not just five people per slot", () => {
    const members = [
      member("A", NY, pattern({ F: [["18:00", "20:00"]] })),
      ...["B", "C", "D", "E"].map((id) => member(id, NY, EVENING)),
      member("F", NY, pattern({ F: [["20:00", "22:00"]] })),
    ];
    // Every slot has five people free, but no group of five lasts longer than two hours.
    expect(findWindows(members, gamingDay(TUE), settings({ minSessionMinutes: 150 }))).toEqual([]);
    const ws = findWindows(members, gamingDay(TUE), settings({ minSessionMinutes: 120 }));
    expect(ws.map((w) => [span(w), w.party.join("")])).toEqual([
      ["18:00-20:00", "ABCDE"],
      ["20:00-22:00", "BCDEF"],
    ]);
  });

  it("works across time zones and past midnight", () => {
    // 10pm–2am in New York is 7–11pm in Los Angeles.
    const members = [
      member("ny", NY, pattern({ F: [["22:00", "02:00"]] })),
      member("la", LA, pattern({ F: [["19:00", "23:00"]] })),
    ];
    const ws = findWindows(members, gamingDay(TUE), settings({ partySize: 2 }));
    expect(ws.map((w) => [span(w, NY), span(w, LA)])).toEqual([["22:00-02:00", "19:00-23:00"]]);
  });
});

describe("dinner", () => {
  it("bridges a quick dinner as a pause", () => {
    const ws = findWindows(five({ A: withDinner("Q", "19:00", "19:30") }), gamingDay(TUE), settings());
    expect(ws.map((w) => span(w))).toEqual(["18:00-22:00"]);
    expect(ws[0].playMinutes).toBe(210);
    expect(ws[0].pauses.map((p) => [span(p), p.who])).toEqual([["19:00-19:30", ["A"]]]);
  });

  it("splits the session around a long dinner", () => {
    const members = five({ A: withDinner("L", "19:00", "20:00") });
    // 6–7pm alone is shorter than the 90-minute minimum.
    expect(findWindows(members, gamingDay(TUE), settings()).map((w) => span(w))).toEqual(["20:00-22:00"]);
    expect(
      findWindows(members, gamingDay(TUE), settings({ minSessionMinutes: 60 })).map((w) => span(w)),
    ).toEqual(["18:00-19:00", "20:00-22:00"]);
  });

  it("treats a quick dinner longer than the pause limit as a long one", () => {
    const members = five({ A: withDinner("Q", "19:00", "20:00") });
    expect(findWindows(members, gamingDay(TUE), settings()).map((w) => span(w))).toEqual(["20:00-22:00"]);
    const patient = findWindows(members, gamingDay(TUE), settings({ maxPauseMinutes: 60 }));
    expect(patient.map((w) => [span(w), w.pauses.length, w.playMinutes])).toEqual([["18:00-22:00", 1, 180]]);
  });

  it("splits when back-to-back dinners add up past the limit", () => {
    const members = five({ A: withDinner("Q", "19:00", "19:30"), B: withDinner("Q", "19:30", "20:00") });
    expect(
      findWindows(members, gamingDay(TUE), settings({ minSessionMinutes: 60 })).map((w) => span(w)),
    ).toEqual(["18:00-19:00", "20:00-22:00"]);
  });

  it("merges simultaneous dinners into one pause", () => {
    const members = five({ A: withDinner("Q", "19:00", "19:30"), B: withDinner("Q", "19:00", "19:30") });
    const [w] = findWindows(members, gamingDay(TUE), settings());
    expect(w.pauses.map((p) => [span(p), p.who])).toEqual([["19:00-19:30", ["A", "B"]]]);
  });

  it("never starts or ends a session on a pause", () => {
    const members = five({ A: withDinner("Q", "18:00", "18:30"), B: withDinner("Q", "21:30", "22:00") });
    expect(findWindows(members, gamingDay(TUE), settings()).map((w) => span(w))).toEqual(["18:30-21:30"]);
  });

  it("lets a sub cover someone's dinner, so there's no pause", () => {
    const six = [...five({ A: withDinner("Q", "19:00", "19:30") }), member("F", NY, EVENING)];
    const [w] = findWindows(six, gamingDay(TUE), settings());
    expect(span(w)).toBe("18:00-22:00");
    expect(w).toMatchObject({ subs: 1, pauses: [], playMinutes: 240 });
    expect(w.party).toHaveLength(6);
  });

  it("re-checks earlier slots when someone leaves (the cover disappears)", () => {
    const members = [
      ...["A", "B", "C", "D"].map((id) => member(id, NY, EVENING)),
      member("E", NY, pattern({ F: [["18:00", "20:00"]] })),
      member("F", NY, withDinner("Q", "18:30", "19:00")),
    ];
    const ws = findWindows(members, gamingDay(TUE), settings());
    // E covered F's dinner, but E leaves at 8pm, so that slot becomes a pause for the lasting party.
    expect(ws.map((w) => [span(w), w.party.join(""), w.pauses.map((p) => span(p))])).toEqual([
      ["18:00-22:00", "ABCDF", ["18:30-19:00"]],
    ]);
  });

  it("drops a start that turns into a pause once someone leaves", () => {
    const late = pattern({ F: [["18:30", "22:00"]] });
    const members = [
      ...["A", "B", "C", "D"].map((id) => member(id, NY, late)),
      member("E", NY, pattern({ F: [["18:30", "20:00"]] })),
      member("F", NY, pattern({ F: [["18:30", "22:00"]], Q: [["18:30", "19:00"]] })),
    ];
    const ws = findWindows(members, gamingDay(TUE), settings());
    expect(ws.map((w) => [span(w), w.party.join(""), w.pauses.length])).toEqual([["19:00-22:00", "ABCDF", 0]]);
  });
});

describe("if needed", () => {
  it("flags 'if needed' players the party relies on and ranks them lower", () => {
    const [w] = findWindows(five({ E: pattern({ M: [["18:00", "22:00"]] }) }), gamingDay(TUE), settings());
    const [allFree] = findWindows(five(), gamingDay(TUE), settings());
    expect(w.ifNeeded).toEqual(["E"]);
    expect(w.score).toBeLessThan(allFree.score);
  });

  it("doesn't rely on an 'if needed' sub when five free players are enough", () => {
    const six = [...five(), member("F", NY, pattern({ M: [["18:00", "22:00"]] }))];
    const [w] = findWindows(six, gamingDay(TUE), settings());
    expect(w).toMatchObject({ ifNeeded: [], subs: 1 });
  });
});

describe("time zones and daylight saving", () => {
  it("keeps weekly availability in local time across the DST change", () => {
    const maya: MemberInput = { id: "maya", name: "Maya", timezone: NY, weekly: { 2: pattern({ F: [["20:00", "23:00"]] }) } };
    const horizon = makeHorizon(Date.parse("2026-10-26T00:00:00Z"), Date.parse("2026-11-09T00:00:00Z"));
    const ws = findWindows([maya], horizon, settings({ partySize: 1, minSessionMinutes: 60 }));
    expect(ws.map((w) => new Date(w.startMs).toISOString())).toEqual([
      "2026-10-28T00:00:00.000Z", // 8pm EDT
      "2026-11-04T01:00:00.000Z", // 8pm EST
    ]);
    expect(ws.map((w) => span(w, NY))).toEqual(["20:00-23:00", "20:00-23:00"]);
  });

  it("handles Arizona, which never changes its clocks", () => {
    const evening = pattern({ F: [["18:00", "22:00"]] });
    const members = [member("rosa", PHX, evening), member("kai", LA, evening)];
    const s = settings({ partySize: 2, minSessionMinutes: 60 });
    expect(findWindows(members, gamingDay("2026-10-27", LA), s).map((w) => span(w, LA))).toEqual(["18:00-22:00"]);
    // After Nov 1, Arizona is an hour ahead of California.
    expect(findWindows(members, gamingDay("2026-11-03", LA), s).map((w) => span(w, LA))).toEqual(["18:00-21:00"]);
  });
});

describe("session timeline", () => {
  it("adds last-queue heads-ups before pauses and the end", () => {
    const [w] = findWindows(five({ A: withDinner("Q", "19:00", "19:30") }), gamingDay(TUE), settings());
    expect(sessionTimeline(w, 40).map((e) => `${e.kind}@${clock(e.atMs)}`)).toEqual([
      "start@18:00",
      "last-queue@18:20",
      "pause@19:00",
      "resume@19:30",
      "last-queue@21:20",
      "end@22:00",
    ]);
  });
});
