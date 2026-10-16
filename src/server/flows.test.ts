import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

// Throwaway embedded database (seeded with the demo group on first use).
process.env.PGLITE_DIR = mkdtempSync(path.join(tmpdir(), "receptionist-flows-"));

const { loadGroupContext, toEngineInput } = await import("./context");
const { upcomingWindows } = await import("./windows");
const { lockInWindow, upcomingPlanned, startLive, setPlayerStatus, goToDinner, getSession, summarizeLive, endSession, activeLive } =
  await import("./sessions");
const { getWfhState, toggleBallotDay, closeVote, reopenVote, weekStartOf } = await import("./wfh");
const { saveProfile, saveDateOverride, createMember, saveWfhWeek, addVacation, removeVacation } = await import("./availability");
const { openLateVotes, toggleLateReport, getLateTally } = await import("./lateness");
const { setAwayUntil, resolveBackTime } = await import("./away");
const { freeNowNotInLobby } = await import("./notify");
const { lobbyMessage, wfhVoteMessage, plannedSessionMessage, windowsMessage, storedPlannedMessage, mention, awayMessage } =
  await import("@/discord/messages");
const { handleInteraction } = await import("@/discord/handlers");
const { getDb } = await import("@/db");
const { memberProfiles, playSessions, playSessionPlayers } = await import("@/db/schema");
const { DEMO_GROUP_ID } = await import("@/db/seed");
const { pattern, lateVotingState, resolvePattern, currentGamingDay, EMPTY_PATTERN } = await import("@/engine");
const { eq } = await import("drizzle-orm");
const { DateTime } = await import("luxon");

type Ctx = Awaited<ReturnType<typeof loadGroupContext>>;
let ctx: Ctx;
const fresh = () => loadGroupContext(DEMO_GROUP_ID);

function assertDiscordLimits(msg: { content: string; components?: Array<{ components: Array<{ custom_id?: string }> }> }) {
  expect(msg.content.length).toBeLessThanOrEqual(2000);
  for (const row of msg.components ?? []) {
    expect(row.components.length).toBeLessThanOrEqual(5);
    for (const b of row.components) if (b.custom_id) expect(b.custom_id.length).toBeLessThanOrEqual(100);
  }
}

beforeAll(async () => {
  ctx = await fresh();
}, 60_000);

describe("demo group", () => {
  it("is seeded with five members across four zones", () => {
    expect(ctx.members.map((m) => m.name)).toEqual(["Maya", "Dev", "Rosa", "Kai", "Sam"]);
    expect(new Set(ctx.members.map((m) => m.timezone)).size).toBe(4);
    expect(ctx.members.filter((m) => m.workStyle === "hybrid").map((m) => m.name)).toEqual(["Maya", "Kai"]);
  });

  it("finds windows and renders a Discord summary", () => {
    const windows = upcomingWindows(ctx);
    expect(windows.length).toBeGreaterThan(0);
    assertDiscordLimits(windowsMessage(ctx, windows, "http://localhost:3000"));
  });
});

describe("planned sessions", () => {
  it("locks in a window once and lists it", async () => {
    const [w] = upcomingWindows(ctx);
    const first = await lockInWindow(ctx, "demo-kai", w.startMs, w.endMs);
    const again = await lockInWindow(ctx, "demo-kai", w.startMs, w.endMs);
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    const planned = await upcomingPlanned(ctx.group.id);
    expect(planned.map((p) => p.session.id)).toContain(first.session.id);
    expect(planned[0].players).toHaveLength(5);
    assertDiscordLimits(plannedSessionMessage(ctx, w));
  });

  it("refuses a window that doesn't exist", async () => {
    await expect(lockInWindow(ctx, "demo-kai", 0, 1)).rejects.toThrow(/isn't available/);
  });
});

describe("live lobby", () => {
  it("fills up, pauses for a quick dinner, and resumes", async () => {
    const { sessionId, created } = await startLive(ctx, "demo-kai");
    expect(created).toBe(true);
    expect((await startLive(ctx, "demo-sam")).sessionId).toBe(sessionId); // joins the same lobby

    for (const id of ["demo-maya", "demo-dev", "demo-rosa"]) await setPlayerStatus(ctx, sessionId, id, "in");
    let s = (await getSession(ctx.group.id, sessionId))!;
    expect(summarizeLive(5, s.players).state).toBe("full");

    await goToDinner(ctx, sessionId, "demo-rosa", "quick");
    s = (await getSession(ctx.group.id, sessionId))!;
    const paused = summarizeLive(5, s.players);
    expect(paused.state).toBe("paused");
    expect(paused.eating[0]).toMatchObject({ id: "demo-rosa", kind: "quick" });
    assertDiscordLimits(lobbyMessage(ctx, s.session, paused, []));

    await goToDinner(ctx, sessionId, "demo-dev", "long");
    s = (await getSession(ctx.group.id, sessionId))!;
    expect(summarizeLive(5, s.players)).toMatchObject({ state: "forming", needed: 1 });

    await setPlayerStatus(ctx, sessionId, "demo-dev", "in");
    await setPlayerStatus(ctx, sessionId, "demo-rosa", "in");
    s = (await getSession(ctx.group.id, sessionId))!;
    expect(summarizeLive(5, s.players).state).toBe("full");

    await endSession(ctx, sessionId);
    expect(await activeLive(ctx.group.id)).toBeNull();
    await expect(setPlayerStatus(ctx, sessionId, "demo-kai", "in")).rejects.toThrow(/ended/);
  });
});

describe("WFH vote", () => {
  it("decides the shared day from ballots, records WFH dates, and can be reopened", async () => {
    const week = weekStartOf(ctx.group.homeTimezone, 1);
    let state = await getWfhState(ctx, week);
    expect(state.ballots["demo-kai"]).toEqual([4]); // seeded: Kai picked Thursday
    assertDiscordLimits(wfhVoteMessage(ctx, state, "http://localhost:3000"));

    await expect(toggleBallotDay(ctx, week, "demo-dev", 4)).rejects.toThrow(/hybrid/);
    await expect(toggleBallotDay(ctx, week, "demo-maya", 2)).rejects.toThrow(/flexible/); // Maya is in the office Tuesdays
    expect(await toggleBallotDay(ctx, week, "demo-maya", 4)).toEqual([4]);

    const result = await closeVote(ctx, week);
    expect(result.recommended).toEqual([4]);
    ctx = await fresh();
    const thursday = result.options.find((o) => o.weekday === 4)!.date;
    expect(ctx.byId.get("demo-maya")!.wfhDates).toContain(thursday);
    expect(ctx.byId.get("demo-kai")!.wfhDates).toContain(thursday);
    state = await getWfhState(ctx, week);
    expect(state.vote?.status).toBe("closed");
    await expect(toggleBallotDay(ctx, week, "demo-maya", 1)).rejects.toThrow(/closed/);

    await reopenVote(ctx, week);
    ctx = await fresh();
    expect(ctx.byId.get("demo-kai")!.wfhDates).not.toContain(thursday);
  });
});

describe("profiles and members", () => {
  it("saves a profile, overrides a day, and adds a member with a starter week", async () => {
    await saveProfile("demo-dev", {
      timezone: "America/Denver",
      workStyle: "hybrid",
      nightBeforeWfhUntil: "00:30",
      hybridDays: { 1: "flex", 5: "wfh" },
    });
    await saveDateOverride("demo-dev", "2030-01-01", pattern({ F: [["20:00", "22:00"]] }));
    const id = await createMember({ name: "Jordan", timezone: "America/New_York" });
    ctx = await fresh();
    const dev = ctx.byId.get("demo-dev")!;
    expect(dev).toMatchObject({ timezone: "America/Denver", workStyle: "hybrid", nightBeforeWfhUntil: "00:30" });
    expect(dev.hybridDays).toEqual({ 1: "flex", 5: "wfh" });
    expect(dev.patterns["d:2030-01-01"]).toBe(pattern({ F: [["20:00", "22:00"]] }));
    expect(ctx.members).toHaveLength(6);
    expect(Object.keys(ctx.byId.get(id)!.patterns)).toHaveLength(7);
    await expect(saveProfile("demo-dev", { timezone: "Mars/Olympus", workStyle: "fixed", nightBeforeWfhUntil: null, hybridDays: {} })).rejects.toThrow(/time zone/);
  });
});

describe("late reports", () => {
  /** The seeded session that started a little while ago (Maya already reported Sam). */
  const seededOpen = () => openLateVotes(ctx, "demo-kai").find((t) => t.counts["demo-sam"] === 1)!;
  const closedSession = () => ctx.lateRecords.find((r) => lateVotingState(r.startMs, Date.now()) === "closed")!;
  async function futureSessionId() {
    const planned = await upcomingPlanned(ctx.group.id);
    const existing = planned.find((p) => p.session.startAt.getTime() > Date.now());
    if (existing) return existing.session.id;
    const w = upcomingWindows(ctx).find((x) => x.startMs > Date.now())!;
    return (await lockInWindow(ctx, "demo-kai", w.startMs, w.endMs)).session.id;
  }

  it("tags Sam as frequently late from the seeded history", () => {
    expect(ctx.byId.get("demo-sam")!.lateness).toEqual({ late: 6, sessions: 10, frequentlyLate: true });
    expect(ctx.byId.get("demo-dev")!.lateness).toEqual({ late: 1, sessions: 10, frequentlyLate: false });
    expect(mention(ctx.byId.get("demo-sam"))).toContain("frequently late");
    expect(mention(ctx.byId.get("demo-dev"))).not.toContain("frequently late");
  });

  it("counts a report toward late and lets the reporter take it back", async () => {
    const open = seededOpen();
    expect(open).toMatchObject({ voting: "open", needed: 2, counts: { "demo-sam": 1 }, mine: [] });

    const on = await toggleLateReport(ctx, open.sessionId, "demo-kai", "demo-sam");
    expect(on.reported).toBe(true);
    expect(on.tally.counts["demo-sam"]).toBe(2);
    expect(on.tally.mine).toEqual(["demo-sam"]);

    const found = (await getLateTally(ctx.group.id, open.sessionId))!;
    expect(found.tally.mine).toEqual([]); // nobody else can see who reported
    const msg = storedPlannedMessage(ctx, found.session, found.tally);
    assertDiscordLimits(msg);
    expect(msg.content).toContain("counts as late");

    const off = await toggleLateReport(ctx, open.sessionId, "demo-kai", "demo-sam");
    expect(off.reported).toBe(false);
    expect(off.tally.counts["demo-sam"]).toBe(1);
  });

  it("only takes reports from players, about other players, while voting is open", async () => {
    const open = seededOpen();
    await expect(toggleLateReport(ctx, open.sessionId, "demo-sam", "demo-sam")).rejects.toThrow(/yourself/);

    const outsider =
      ctx.members.find((m) => !open.players.includes(m.id))?.id ??
      (await createMember({ name: "Taylor", timezone: "America/Denver" }));
    ctx = await fresh();
    await expect(toggleLateReport(ctx, open.sessionId, outsider, "demo-sam")).rejects.toThrow(/Only players/);
    await expect(toggleLateReport(ctx, open.sessionId, "demo-kai", outsider)).rejects.toThrow(/weren't in/);

    await expect(toggleLateReport(ctx, closedSession().sessionId, "demo-kai", "demo-sam")).rejects.toThrow(/closed/);
    await expect(toggleLateReport(ctx, await futureSessionId(), "demo-kai", "demo-sam")).rejects.toThrow(
      /open when the session starts/,
    );
  });

  it("handles the Discord late buttons", async () => {
    const db = await getDb();
    await db.update(memberProfiles).set({ discordId: "1001" }).where(eq(memberProfiles.userId, "demo-kai"));
    ctx = await fresh();
    const click = async (customId: string) => {
      const tasks: Array<() => Promise<unknown>> = [];
      const res = await handleInteraction(
        {
          id: "1",
          application_id: "app",
          type: 3,
          token: "token",
          channel_id: "chan",
          member: { user: { id: "1001", username: "kai" } },
          data: { custom_id: customId },
          message: { id: "msg", channel_id: "chan" },
        },
        (task) => tasks.push(task),
      );
      return { ...res, tasks };
    };
    const open = seededOpen();

    const early = await click(`late:${await futureSessionId()}:demo-sam`);
    expect(early).toMatchObject({ type: 4, data: { flags: 64 } });
    expect(early.data!.content).toMatch(/open when the session starts/);

    const on = await click(`late:${open.sessionId}:demo-sam`);
    expect(on.type).toBe(7); // edits the shared message in place
    expect(on.data!.content).toContain("counts as late");
    expect(on.data!.components!.length).toBeGreaterThan(0);
    expect(on.tasks.length).toBe(2); // remember the message + private confirmation
    assertDiscordLimits(on.data!);

    const off = await click(`late:${open.sessionId}:demo-sam`);
    expect(off.type).toBe(7);
    expect(off.data!.content).not.toContain("counts as late");

    const self = await click(`late:${open.sessionId}:demo-kai`);
    expect(self).toMatchObject({ type: 4, data: { flags: 64 } });
    expect(self.data!.content).toMatch(/yourself/);

    const closed = await click(`late:${closedSession().sessionId}:demo-sam`);
    expect(closed.type).toBe(7);
    expect(closed.data!.content).toContain("Late check closed");
    expect(closed.data!.components).toEqual([]);
  });
});

describe("WFH patterns per weekday", () => {
  it("uses each weekday's own WFH pattern, and the shared one for days without their own", async () => {
    const friday = pattern({ F: [["15:00", "23:00"]] });
    await saveWfhWeek("demo-kai", { 5: friday });
    await expect(saveWfhWeek("demo-kai", { 6: friday })).rejects.toThrow(/Bad WFH weekday/);
    ctx = await fresh();
    const kai = toEngineInput(ctx.byId.get("demo-kai")!);
    expect(kai.wfhWeekly).toEqual({ 5: friday });

    // Kai always works from home on Fridays (seeded), so a Friday uses the new Friday pattern...
    const nextFriday = DateTime.now().setZone(kai.timezone).plus({ weeks: 1 }).set({ weekday: 5 }).toISODate()!;
    expect(resolvePattern(kai, nextFriday)).toBe(friday);
    // ...while a WFH Thursday still uses the shared WFH pattern from before.
    const thursday = DateTime.fromISO(nextFriday).minus({ days: 1 }).toISODate()!;
    expect(resolvePattern({ ...kai, wfhDates: new Set([thursday]) }, thursday)).toBe(kai.wfhPattern);
  });
});

describe("/back with a time", () => {
  // A fixed evening years ahead, in Rosa's zone, so nothing depends on when the tests run.
  const zone = () => ctx.byId.get("demo-rosa")!.timezone;
  const at = (iso: string) => DateTime.fromISO(iso, { zone: zone() }).toMillis();

  it("reads the time in the member's zone and explains what it can't use", () => {
    const now = at("2031-03-04T18:10");
    expect(resolveBackTime("9", now, zone())).toEqual({ backMs: at("2031-03-04T21:00"), now: false });
    expect(resolveBackTime("930", now, zone())).toEqual({ backMs: at("2031-03-04T21:30"), now: false });
    expect(resolveBackTime("10", at("2031-03-04T17:10"), zone())).toEqual({ backMs: at("2031-03-04T22:00"), now: false });
    expect(resolveBackTime("now", now, zone())).toEqual({ backMs: at("2031-03-04T18:00"), now: true });
    expect(resolveBackTime("now", at("2031-03-04T06:00"), zone())).toEqual({ backMs: at("2031-03-04T06:00"), now: true });
    expect(() => resolveBackTime("banana", now, zone())).toThrow(/couldn't read/);
    expect(() => resolveBackTime("5pm", now, zone())).toThrow(/already passed\. If you're back now, use \/back now/);
    expect(() => resolveBackTime("6am", now, zone())).toThrow(/between 8am and 4am/);
  });

  it("saves busy-until-then, free-from-then as a one-off day and warns about a locked-in session", async () => {
    const db = await getDb();
    await saveDateOverride("demo-rosa", "2031-03-04", pattern({ F: [["18:00", "23:00"]] }));
    const [planned] = await db
      .insert(playSessions)
      .values({
        groupId: ctx.group.id,
        kind: "planned",
        startAt: new Date(at("2031-03-04T20:00")),
        endAt: new Date(at("2031-03-04T23:00")),
        createdBy: "demo-kai",
      })
      .returning();
    await db.insert(playSessionPlayers).values({ sessionId: planned.id, userId: "demo-rosa", status: "in" });
    try {
      ctx = await fresh();
      const away = await setAwayUntil(ctx, "demo-rosa", "9pm", at("2031-03-04T17:10"));
      expect(away).toMatchObject({ backMs: at("2031-03-04T21:00"), now: false, lobby: null, clashMs: at("2031-03-04T20:00") });
      ctx = await fresh();
      expect(ctx.byId.get("demo-rosa")!.patterns["d:2031-03-04"]).toBe(pattern({ F: [["21:00", "23:00"]] }));
      const msg = awayMessage(away, zone(), "http://localhost:3000");
      expect(msg).toContain("Away until **9pm");
      expect(msg).toContain("free 9–11pm");
      expect(msg).toContain("locked in for 8pm");
      expect(msg).toContain("<http://localhost:3000/availability>");
    } finally {
      await db.update(playSessions).set({ status: "cancelled" }).where(eq(playSessions.id, planned.id));
    }
  });

  it("shows when they'll be back in an open lobby, and 'now' puts them in", async () => {
    const db = await getDb();
    const [lobby] = await db
      .insert(playSessions)
      .values({ groupId: ctx.group.id, kind: "live", startAt: new Date(at("2031-03-04T18:00")), createdBy: "demo-kai" })
      .returning();
    try {
      const away = await setAwayUntil(ctx, "demo-rosa", "10:30pm", at("2031-03-04T19:00"));
      expect(away.lobby).toEqual({ sessionId: lobby.id, before: "forming" });
      let s = (await getSession(ctx.group.id, lobby.id))!;
      const summary = summarizeLive(5, s.players);
      expect(summary.soon).toEqual([{ id: "demo-rosa", backAt: at("2031-03-04T22:30") }]);
      const msg = lobbyMessage(ctx, s.session, summary, []);
      expect(msg.content).toContain(`back <t:${at("2031-03-04T22:30") / 1000}:t>`);
      assertDiscordLimits(msg);

      ctx = await fresh();
      const back = await setAwayUntil(ctx, "demo-rosa", "now", at("2031-03-04T20:10"));
      expect(back.now).toBe(true);
      expect(awayMessage(back, zone(), "http://localhost:3000")).toContain("You're in the lobby");
      s = (await getSession(ctx.group.id, lobby.id))!;
      expect(summarizeLive(5, s.players).playing).toEqual(["demo-rosa"]);

      // 4–8am is outside every gaming day, so "now" only touches the lobby.
      const early = await setAwayUntil(ctx, "demo-rosa", "now", at("2031-03-05T05:00"));
      expect(early.plan).toBeNull();
      expect(awayMessage(early, zone(), "http://localhost:3000")).toBe("✅ Welcome back!\n🎮 You're in the lobby.");
    } finally {
      await endSession(ctx, lobby.id);
    }
  });

  it("answers /back in Discord", async () => {
    const db = await getDb();
    await db.update(memberProfiles).set({ discordId: "1001" }).where(eq(memberProfiles.userId, "demo-kai"));
    const back = async (value?: string, name = "at") => {
      const res = await handleInteraction(
        {
          id: "1",
          application_id: "app",
          type: 2,
          token: "token",
          channel_id: "chan",
          member: { user: { id: "1001", username: "kai" } },
          data: { name: "back", options: value === undefined ? [] : [{ name, value }] },
        },
        () => {},
      );
      expect(res).toMatchObject({ type: 4, data: { flags: 64 } });
      return res.data!.content;
    };
    expect(await back("banana")).toMatch(/couldn't read “banana”/);
    expect(await back("4:30am")).toMatch(/between 8am and 4am/);
    expect(await back("4:30am", "time")).toMatch(/between 8am and 4am/); // the option's old name still works
    expect(await back()).toMatch(/out of date[\s\S]*npm run discord:register/); // Discord's old /back dropped the time
  });
});

describe("lobby message in Discord", () => {
  it("keeps listing who's free (and hasn't answered) after someone taps a button", async () => {
    // Pin the clock (Date only, so database I/O is untouched) to an evening when Maya and Dev are free.
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    vi.setSystemTime(DateTime.fromISO("2031-03-11T20:00", { zone: "America/Chicago" }).toJSDate());
    const db = await getDb();
    let sessionId = "";
    try {
      for (const id of ["demo-maya", "demo-dev"]) await saveDateOverride(id, "2031-03-11", pattern({ F: [["12:00", "23:30"]] }));
      await db.update(memberProfiles).set({ discordId: "1001" }).where(eq(memberProfiles.userId, "demo-kai"));
      await db.update(memberProfiles).set({ discordId: "1002" }).where(eq(memberProfiles.userId, "demo-sam"));
      const user = (id: string) => ({ user: { id, username: id } });

      const opened = await handleInteraction(
        { id: "1", application_id: "app", type: 2, token: "t", channel_id: "chan", member: user("1001"), data: { name: "lfg" } },
        () => {},
      );
      expect(opened.data!.content).toContain("📣 Free right now");
      sessionId = (await activeLive(ctx.group.id))!.session.id;

      // Sam taps "I'm in": the message is edited in place and still lists who's free but hasn't answered.
      const tapped = await handleInteraction(
        {
          id: "2",
          application_id: "app",
          type: 3,
          token: "t",
          channel_id: "chan",
          member: user("1002"),
          data: { custom_id: `lfg:in:${sessionId}` },
          message: { id: "msg", channel_id: "chan" },
        },
        () => {},
      );
      expect(tapped.type).toBe(7);
      ctx = await fresh();
      const free = freeNowNotInLobby(ctx, ["demo-kai", "demo-sam"]);
      expect(free).toEqual(expect.arrayContaining(["demo-maya", "demo-dev"]));
      expect(tapped.data!.content).toContain(`📣 Free right now: ${free.map((id) => mention(ctx.byId.get(id))).join(", ")}`);
      assertDiscordLimits(tapped.data!);
    } finally {
      if (sessionId) await endSession(ctx, sessionId);
      vi.useRealTimers();
    }

    // A closed lobby doesn't list or mention anyone.
    const ended = (await getSession(ctx.group.id, sessionId))!;
    const closed = lobbyMessage(ctx, ended.session, summarizeLive(5, ended.players), ["demo-maya"]);
    expect(closed.content).not.toContain("Free right now");
    expect(closed.allowed_mentions).toEqual({ users: [] });
  });
});

describe("vacation", () => {
  it("checks the dates", async () => {
    await expect(addVacation("demo-kai", "2031-04-10", "2031-04-05", "2031-04-01")).rejects.toThrow(/before the first day/);
    await expect(addVacation("demo-kai", "2031-02-30", "2031-03-02", "2031-01-01")).rejects.toThrow(/first and last day/);
    await expect(addVacation("demo-kai", "2031-01-01", "2031-01-02", "2031-03-01")).rejects.toThrow(/already over/);
    await expect(addVacation("demo-kai", "2031-01-01", "2032-01-05", "2031-01-01")).rejects.toThrow(/more than a year/);
  });

  it("keeps someone out of every window while they're away, and only they can remove it", async () => {
    ctx = await fresh();
    const today = currentGamingDay(Date.now(), ctx.byId.get("demo-kai")!.timezone);
    const lastDay = DateTime.fromISO(today).plus({ days: 8 }).toISODate()!;
    expect(upcomingWindows(ctx).some((w) => w.party.includes("demo-kai"))).toBe(true);

    const trip = await addVacation("demo-kai", today, lastDay, today);
    try {
      ctx = await fresh();
      const kai = ctx.byId.get("demo-kai")!;
      expect(kai.vacations).toEqual([{ id: trip.id, start: today, end: lastDay }]);
      expect(resolvePattern(toEngineInput(kai), today)).toBe(EMPTY_PATTERN);
      expect(upcomingWindows(ctx).some((w) => w.party.includes("demo-kai"))).toBe(false);

      await removeVacation("demo-sam", trip.id); // not Sam's
      ctx = await fresh();
      expect(ctx.byId.get("demo-kai")!.vacations).toHaveLength(1);
    } finally {
      await removeVacation("demo-kai", trip.id);
    }
    ctx = await fresh();
    expect(ctx.byId.get("demo-kai")!.vacations).toEqual([]);
  });

  it("'/back' while away: a time is refused, 'now' leaves availability alone and says why", async () => {
    const zone = ctx.byId.get("demo-rosa")!.timezone;
    const at = (iso: string) => DateTime.fromISO(iso, { zone }).toMillis();
    const trip = await addVacation("demo-rosa", "2031-05-01", "2031-05-03", "2031-04-01");
    try {
      ctx = await fresh();
      await expect(setAwayUntil(ctx, "demo-rosa", "9pm", at("2031-05-02T17:00"))).rejects.toThrow(/on vacation until May 3/);
      const back = await setAwayUntil(ctx, "demo-rosa", "now", at("2031-05-02T19:10"));
      expect(back).toMatchObject({ plan: null, vacationUntil: "2031-05-03" });
      expect(awayMessage(back, zone, "http://localhost:3000")).toContain("on vacation until May 3");
    } finally {
      await removeVacation("demo-rosa", trip.id);
    }
  });
});
