import { describe, expect, it } from "vitest";
import { extendEvening, resolvePattern } from "./availability";
import { pattern } from "./patterns";
import { CHI, LA, NY, PHX, everyDay, settings, span } from "./test-helpers";
import type { MemberInput } from "./types";
import { decideWfhVote, planWfhWeek } from "./wfh";

describe("resolvePattern", () => {
  const office = pattern({ F: [["19:00", "23:00"]] });
  const wfh = pattern({ F: [["17:00", "23:00"]] });
  const kai: MemberInput = {
    id: "kai",
    name: "Kai",
    timezone: LA,
    weekly: { 1: office, 2: office, 3: office, 4: office, 5: office },
    wfhPattern: wfh,
    hybridDays: { 1: "office", 2: "flex", 3: "office", 4: "flex", 5: "wfh" },
    wfhDates: new Set(["2026-10-22"]), // voted WFH on Thursday
    nightBeforeWfhUntil: "01:00",
  };

  it("uses the WFH pattern on voted and fixed WFH days", () => {
    expect(resolvePattern(kai, "2026-10-23")).toBe(wfh); // Friday is always WFH
    expect(resolvePattern(kai, "2026-10-20")).toBe(office); // flexible Tuesday, not picked
  });

  it("lets them stay up later the night before a WFH day", () => {
    expect(resolvePattern(kai, "2026-10-21")).toBe(pattern({ F: [["19:00", "01:00"]] })); // Wed → Thu WFH
    expect(resolvePattern(kai, "2026-10-22")).toBe(pattern({ F: [["17:00", "01:00"]] })); // Thu WFH → Fri WFH
  });

  it("lets date overrides beat everything", () => {
    const busy = pattern({});
    expect(resolvePattern({ ...kai, overrides: { "2026-10-22": busy } }, "2026-10-22")).toBe(busy);
  });

  it("only extends evenings that already have availability, and only over busy time", () => {
    expect(extendEvening(pattern({}), "01:00")).toBe(pattern({}));
    const lateDinner = pattern({ F: [["19:00", "22:00"]], L: [["23:00", "23:30"]] });
    expect(extendEvening(lateDinner, "01:00")).toBe(pattern({ F: [["19:00", "23:00"]], L: [["23:00", "23:30"]] }));
  });
});

describe("WFH planning", () => {
  const members: MemberInput[] = [
    {
      id: "maya",
      name: "Maya",
      timezone: NY,
      weekly: everyDay(pattern({ F: [["18:30", "00:00"]] })),
      wfhPattern: pattern({ F: [["17:00", "00:00"]] }),
      nightBeforeWfhUntil: "01:00",
      hybridDays: { 1: "flex", 2: "office", 3: "office", 4: "flex", 5: "flex" },
    },
    { id: "dev", name: "Dev", timezone: CHI, weekly: everyDay(pattern({ F: [["18:00", "23:30"]] })) },
    { id: "rosa", name: "Rosa", timezone: PHX, weekly: everyDay(pattern({ F: [["17:00", "23:00"]] })) },
    {
      id: "kai",
      name: "Kai",
      timezone: LA,
      weekly: everyDay(pattern({ F: [["18:00", "23:30"]] })),
      wfhPattern: pattern({ F: [["16:30", "23:30"]] }),
      hybridDays: { 1: "office", 2: "flex", 3: "office", 4: "flex", 5: "wfh" },
    },
    { id: "sam", name: "Sam", timezone: LA, weekly: everyDay(pattern({ F: [["15:00", "01:00"]] })) },
  ];
  const week = { members, settings: settings(), weekStart: "2026-10-19", homeZone: CHI };

  it("projects each day's gain and recommends the shared day", () => {
    const plan = planWfhWeek(week);
    const day = Object.fromEntries(plan.options.map((o) => [o.weekday, o]));
    expect(plan.projected).toBe(true);
    expect(day[3].votable).toEqual([]); // both are in the office on Wednesdays
    // Thursday: Kai starts at 5pm PT instead of 6pm (+60), and Maya can stay up later Wednesday (+30).
    expect(day[4]).toMatchObject({ approvers: ["maya", "kai"], together: 2, gainMinutes: 90 });
    expect(day[5]).toMatchObject({ approvers: ["maya"], fixed: ["kai"], together: 2, gainMinutes: 30 });
    expect(day[2]).toMatchObject({ approvers: ["kai"], together: 1, gainMinutes: 60 });
    expect(plan.recommended).toEqual([4]);
    expect(span(day[4].best!, LA)).toBe("17:00-21:00");
    expect(span(day[4].baseline!, LA)).toBe("18:00-21:00");
  });

  it("prefers the day the most people can actually be home together", () => {
    const plan = planWfhWeek({ ...week, ballots: { maya: [5], kai: [2] } });
    expect(plan.recommended).toEqual([5]); // Maya joins Kai's fixed Friday
  });

  it("assigns WFH dates to everyone who approved the winning day", () => {
    const result = decideWfhVote({ ...week, ballots: { maya: [4], kai: [4] } });
    expect(result.recommended).toEqual([4]);
    expect(result.assignments).toEqual([
      { memberId: "maya", date: "2026-10-22" },
      { memberId: "kai", date: "2026-10-22" },
    ]);
  });
});
