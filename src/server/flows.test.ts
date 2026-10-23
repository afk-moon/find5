import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Throwaway embedded database (seeded with the demo group on first use).
process.env.PGLITE_DIR = mkdtempSync(path.join(tmpdir(), "receptionist-flows-"));

const { loadGroupContext, toEngineInput, mainGame, forGame, gamesOf, findGame, sessionGame } = await import("./context");
const { setMemberGames, addGame, updateGame, removeGame } = await import("./games");
const { upcomingWindows } = await import("./windows");
const {
  lockInWindow,
  upcomingPlanned,
  startLive,
  setPlayerStatus,
  goToDinner,
  getSession,
  summarizeLive,
  endSession,
  activeLive,
  lobbyCutoff,
  gamesInLobby,
  progressText,
  fullStacks,
  startFreshLive,
} = await import("./sessions");
const { getWfhState, toggleBallotDay, closeVote, reopenVote, weekStartOf } = await import("./wfh");
const { saveProfile, saveDateOverride, createMember, saveWfhWeek, addVacation, removeVacation } = await import("./availability");
const { openLateVotes, toggleLateReport, getLateTally, toggleNoShowReport, addPlayer, attendanceOf } = await import("./lateness");
const { setAwayUntil, resolveBackTime } = await import("./away");
const { freeNowNotInLobby, stackDms } = await import("./notify");
const { getParty, toggleDropOut, toggleKickVote, kickVotesNeeded, partyOf, joinSession } = await import("./party");
const { rate, reportOffense, addFeedback, feedbackAbout, FEEDBACK_MAX_CHARS } = await import("./reputation");
const { offensesFrom } = await import("@/engine/reputation");
const { runAutoPosts, tickDue, autoPostGames } = await import("./autopost");
const {
  lobbyMessage,
  lobbyReplacedMessage,
  stackReadyDm,
  ratePanelMessage,
  wfhVoteMessage,
  plannedSessionMessage,
  windowsMessage,
  storedPlannedMessage,
  mention,
  awayMessage,
  playerReportMessages,
} = await import("@/discord/messages");
const { handleInteraction, handleAutocomplete } = await import("@/discord/handlers");
const { getDb } = await import("@/db");
const { memberProfiles, playSessions, playSessionPlayers, playerFeedback, groups } = await import("@/db/schema");
const { DEMO_GROUP_ID } = await import("@/db/seed");
const { pattern, lateVotingState, resolvePattern, currentGamingDay, EMPTY_PATTERN } = await import("@/engine");
const { and, eq } = await import("drizzle-orm");
const { DateTime } = await import("luxon");

type Ctx = Awaited<ReturnType<typeof loadGroupContext>>;
let ctx: Ctx;
const fresh = () => loadGroupContext(DEMO_GROUP_ID);
/** The demo group narrowed to Valorant, the game all five play. */
const val = () => mainGame(ctx);

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
    const windows = upcomingWindows(val());
    expect(windows.length).toBeGreaterThan(0);
    assertDiscordLimits(windowsMessage([{ game: val().game, windows }], "http://localhost:3000"));
  });
});

describe("planned sessions", () => {
  it("locks in a window once and lists it", async () => {
    const [w] = upcomingWindows(val());
    const first = await lockInWindow(val(), "demo-kai", w.startMs, w.endMs);
    const again = await lockInWindow(val(), "demo-kai", w.startMs, w.endMs);
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    const planned = await upcomingPlanned(ctx.group.id);
    expect(planned.map((p) => p.session.id)).toContain(first.session.id);
    expect(planned[0].players).toHaveLength(5);
    expect(first.session.gameId).toBe(val().game.id);
    const msg = plannedSessionMessage(val(), w);
    expect(msg.content).toContain("🔒 **Locked in: Valorant**");
    assertDiscordLimits(msg);
  });

  it("refuses a window that doesn't exist", async () => {
    await expect(lockInWindow(val(), "demo-kai", 0, 1)).rejects.toThrow(/isn't available/);
  });
});

describe("live lobby", () => {
  it("fills up, pauses for a quick dinner, and resumes", async () => {
    const { sessionId, created } = await startLive(ctx, "demo-kai");
    expect(created).toBe(true);
    expect((await startLive(ctx, "demo-sam")).sessionId).toBe(sessionId); // joins the same lobby

    for (const id of ["demo-maya", "demo-dev", "demo-rosa"]) await setPlayerStatus(ctx, sessionId, id, "in");
    let s = (await getSession(ctx.group.id, sessionId))!;
    expect(summarizeLive(ctx.games, s.players).state).toBe("full");

    await goToDinner(ctx, sessionId, "demo-rosa", "quick");
    s = (await getSession(ctx.group.id, sessionId))!;
    const paused = summarizeLive(ctx.games, s.players);
    expect(paused.state).toBe("paused");
    expect(paused.eating[0]).toMatchObject({ id: "demo-rosa", kind: "quick" });
    assertDiscordLimits(lobbyMessage(ctx, s.session, paused, []));

    await goToDinner(ctx, sessionId, "demo-dev", "long");
    s = (await getSession(ctx.group.id, sessionId))!;
    const split = summarizeLive(ctx.games, s.players);
    expect(split.games.find((g) => g.game.name === "Valorant")).toMatchObject({ ready: false, needed: 1 });
    expect(split.state).toBe("paused"); // Maya and Rosa's TFT duo still waits on Rosa's quick dinner

    await setPlayerStatus(ctx, sessionId, "demo-dev", "in");
    await setPlayerStatus(ctx, sessionId, "demo-rosa", "in");
    s = (await getSession(ctx.group.id, sessionId))!;
    expect(summarizeLive(ctx.games, s.players).state).toBe("full");

    await endSession(ctx, sessionId);
    expect(await activeLive(ctx.group)).toBeNull();
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
    const w = upcomingWindows(val()).find((x) => x.startMs > Date.now())!;
    return (await lockInWindow(val(), "demo-kai", w.startMs, w.endMs)).session.id;
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
    const msg = storedPlannedMessage(ctx, found.session, found.tally, (await getParty(ctx, open.sessionId))!.party);
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
    expect(closed.data!.content).toContain("Attendance check closed");
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
      expect(away.lobby).toEqual({ sessionId: lobby.id, before: [] }); // no full 5-stack before (for DMs)
      let s = (await getSession(ctx.group.id, lobby.id))!;
      const summary = summarizeLive(ctx.games, s.players);
      expect(summary.soon).toEqual([{ id: "demo-rosa", backAt: at("2031-03-04T22:30") }]);
      const msg = lobbyMessage(ctx, s.session, summary, []);
      expect(msg.content).toContain(`back <t:${at("2031-03-04T22:30") / 1000}:t>`);
      assertDiscordLimits(msg);

      ctx = await fresh();
      const back = await setAwayUntil(ctx, "demo-rosa", "now", at("2031-03-04T20:10"));
      expect(back.now).toBe(true);
      expect(awayMessage(back, zone(), "http://localhost:3000")).toContain("You're in the lobby");
      s = (await getSession(ctx.group.id, lobby.id))!;
      expect(summarizeLive(ctx.games, s.players).playing).toEqual(["demo-rosa"]);

      // By 5am last evening's lobby has expired (lobbies close at 4am, group time), so open one that morning.
      // 4–8am is outside every gaming day, so "now" only touches the lobby.
      const [dawn] = await db
        .insert(playSessions)
        .values({ groupId: ctx.group.id, kind: "live", startAt: new Date(at("2031-03-05T04:30")), createdBy: "demo-kai" })
        .returning();
      try {
        const early = await setAwayUntil(ctx, "demo-rosa", "now", at("2031-03-05T05:00"));
        expect(early).toMatchObject({ plan: null, lobby: { sessionId: dawn.id } });
        expect(awayMessage(early, zone(), "http://localhost:3000")).toBe("✅ Welcome back!\n🎮 You're in the lobby.");
      } finally {
        await endSession(ctx, dawn.id);
      }
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
      expect(opened.data!.content).toMatch(/\n-# Opened <t:\d+:R> by Kai$/);
      sessionId = (await activeLive(ctx.group))!.session.id;

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
    const closed = lobbyMessage(ctx, ended.session, summarizeLive(ctx.games, ended.players), ["demo-maya"]);
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
    expect(upcomingWindows(val()).some((w) => w.party.includes("demo-kai"))).toBe(true);

    const trip = await addVacation("demo-kai", today, lastDay, today);
    try {
      ctx = await fresh();
      const kai = ctx.byId.get("demo-kai")!;
      expect(kai.vacations).toEqual([{ id: trip.id, start: today, end: lastDay }]);
      expect(resolvePattern(toEngineInput(kai), today)).toBe(EMPTY_PATTERN);
      expect(upcomingWindows(val()).some((w) => w.party.includes("demo-kai"))).toBe(false);

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

describe("old lobbies", () => {
  const CT = "America/Chicago"; // the demo group's home zone
  const ct = (iso: string) => DateTime.fromISO(iso, { zone: CT }).toMillis();

  it("close at 4am (group time) or after 12 hours, whichever comes first", () => {
    expect(lobbyCutoff(ct("2031-03-21T21:00"), CT)).toBe(ct("2031-03-21T09:00")); // 12 hours
    expect(lobbyCutoff(ct("2031-03-21T02:00"), CT)).toBe(ct("2031-03-20T14:00")); // still last night
    expect(lobbyCutoff(ct("2031-03-21T05:00"), CT)).toBe(ct("2031-03-21T04:00")); // a new day
  });

  it("/lfg on a new day closes last night's lobby and opens a fresh one", async () => {
    const db = await getDb();
    const [old] = await db
      .insert(playSessions)
      .values({ groupId: ctx.group.id, kind: "live", startAt: new Date(ct("2031-03-21T03:00")), createdBy: "demo-kai" })
      .returning();
    const { sessionId, created, closed } = await startLive(ctx, "demo-sam", ct("2031-03-21T09:00"));
    try {
      expect(created).toBe(true);
      expect(closed).toEqual([old.id]);
      expect((await activeLive(ctx.group, ct("2031-03-21T09:00")))!.session.id).toBe(sessionId);
      const was = (await getSession(ctx.group.id, old.id))!;
      expect(was.session.status).toBe("ended");
      const post = lobbyMessage(ctx, was.session, summarizeLive(ctx.games, was.players), []);
      expect(post.content).toContain("🏁 **Lobby closed.** Start a new one with /lfg.");
      expect(post.content).toContain(`-# Opened <t:${ct("2031-03-21T03:00") / 1000}:f> by Kai`);
      expect(post.components).toEqual([]);
    } finally {
      await endSession(ctx, sessionId);
    }
  });

  it("tapping an old lobby's button closes it and removes the buttons", async () => {
    const db = await getDb();
    await db.update(memberProfiles).set({ discordId: "1001" }).where(eq(memberProfiles.userId, "demo-kai"));
    ctx = await fresh();
    const [old] = await db
      .insert(playSessions)
      .values({ groupId: ctx.group.id, kind: "live", startAt: new Date(Date.now() - 13 * 3_600_000), createdBy: "demo-kai" })
      .returning();
    const tasks: Array<() => Promise<unknown>> = [];
    const res = await handleInteraction(
      {
        id: "1",
        application_id: "app",
        type: 3,
        token: "t",
        channel_id: "chan",
        member: { user: { id: "1001", username: "kai" } },
        data: { custom_id: `lfg:in:${old.id}` },
        message: { id: "msg", channel_id: "chan" },
      },
      (task) => tasks.push(task),
    );
    expect(res.type).toBe(7); // redraws the old post
    expect(res.data!.content).toContain("Lobby closed");
    expect(res.data!.components).toEqual([]);
    expect(tasks).toHaveLength(1); // the private "that lobby is closed" note
    expect((await getSession(ctx.group.id, old.id))!.session.status).toBe("ended");
  });

  it("a lobby closed by a new /lfg points to the new one", () => {
    const replaced = lobbyReplacedMessage("chan:new-msg", "guild");
    expect(replaced.content).toBe("🏁 Lobby closed. A new one was opened: https://discord.com/channels/guild/chan/new-msg");
    expect(replaced.components).toEqual([]);
    expect(lobbyReplacedMessage("chan:new-msg").content).toBe("🏁 Lobby closed. A new one was opened below.");
  });
});

describe("games", () => {
  const byName = (name: string) => ctx.games.find((g) => g.name === name)!;
  const game = (name: string) => forGame(ctx, byName(name));
  const kai = { user: { id: "1001", username: "kai" } };
  const base = { id: "1", application_id: "app", token: "t", channel_id: "chan", member: kai };

  beforeAll(async () => {
    const db = await getDb();
    await db.update(memberProfiles).set({ discordId: "1001" }).where(eq(memberProfiles.userId, "demo-kai"));
    ctx = await fresh();
  });

  it("start with four, most players first, and each member plays some of them", () => {
    expect(ctx.games.map((g) => [g.name, g.partySize, g.players.length])).toEqual([
      ["Valorant", 5, 5],
      ["League of Legends", 5, 4],
      ["Aion 2", 4, 4],
      ["TFT", 2, 2],
    ]);
    expect(gamesOf(ctx, "demo-maya").map((g) => g.name)).toEqual(["Valorant", "League of Legends", "TFT"]);
    expect(ctx.members.find((m) => m.name === "Jordan")!.games).toEqual([]); // joined later, hasn't picked yet
    expect(findGame(ctx, "league")?.name).toBe("League of Legends");
    expect(findGame(ctx, "TFT")?.name).toBe("TFT");
    expect(findGame(ctx, "a")).toBeNull(); // matches several
  });

  it("finds each game's windows among the people who play it", () => {
    const tft = upcomingWindows(game("TFT"));
    expect(tft.length).toBeGreaterThan(0);
    for (const w of tft) expect(w.party.every((id) => ["demo-maya", "demo-rosa"].includes(id))).toBe(true);
    for (const w of upcomingWindows(game("Aion 2"))) {
      expect(w.party.length).toBeGreaterThanOrEqual(4);
      expect(w.party).not.toContain("demo-maya");
    }
    expect(upcomingWindows(game("League of Legends"))).toEqual([]); // needs 5, only 4 play it
    const msg = windowsMessage(
      ctx.games.map((g) => ({ game: g, windows: upcomingWindows(forGame(ctx, g)) })),
      "http://localhost:3000",
    );
    expect(msg.content).toContain("**League of Legends** (5-stack): needs 5 players, and 4 play it so far.");
    expect(msg.content).toContain("**TFT** (duo)\n• ");
    assertDiscordLimits(msg);

    // Lots of games with lots of windows still fit in one Discord post.
    const windows = upcomingWindows(val());
    const many = Array.from({ length: 8 }, (_, i) => ({ game: { ...val().game, name: `Game ${i}` }, windows: [...windows, ...windows] }));
    assertDiscordLimits(windowsMessage(many, "http://localhost:3000"));
  });

  it("can be picked, added, edited and removed", async () => {
    const jordan = ctx.members.find((m) => m.name === "Jordan")!.id;
    expect(await setMemberGames(ctx, jordan, [byName("TFT").id, "not-a-game"])).toEqual([byName("TFT").id]);
    ctx = await fresh();
    expect(byName("TFT").players).toContain(jordan);

    await expect(addGame(ctx, jordan, { name: "  valorant ", partySize: 5 })).rejects.toThrow(/already on the list/);
    await expect(addGame(ctx, jordan, { name: "   ", partySize: 5 })).rejects.toThrow(/name/);
    const added = await addGame(ctx, jordan, { name: "Overwatch   2", partySize: 99 });
    ctx = await fresh();
    expect(byName("Overwatch 2")).toMatchObject({ partySize: 10, matchMinutes: 40, players: [jordan] });

    await expect(updateGame(ctx, added.id, { name: "tft", partySize: 5, matchMinutes: 20 })).rejects.toThrow(/already/);
    await updateGame(ctx, added.id, { name: "Overwatch", partySize: 5, matchMinutes: 20 });
    ctx = await fresh();
    expect(ctx.gameById.get(added.id)).toMatchObject({ name: "Overwatch", partySize: 5, matchMinutes: 20 });

    // A locked-in session for a game that's removed stays, without a game.
    const db = await getDb();
    const soon = Date.now() + 48 * 3_600_000;
    const [planned] = await db
      .insert(playSessions)
      .values({ groupId: ctx.group.id, gameId: added.id, kind: "planned", startAt: new Date(soon), endAt: new Date(soon + 7_200_000), createdBy: jordan })
      .returning();
    await expect(removeGame({ ...ctx, games: [ctx.gameById.get(added.id)!] }, added.id)).rejects.toThrow(/at least one/);
    await removeGame(ctx, added.id);
    await setMemberGames(ctx, jordan, []);
    ctx = await fresh();
    expect(ctx.gameById.has(added.id)).toBe(false);
    expect(ctx.members.find((m) => m.id === jordan)!.games).toEqual([]);
    const orphan = (await getSession(ctx.group.id, planned.id))!;
    expect(orphan.session.gameId).toBeNull();
    expect(sessionGame(ctx, orphan.session).game.name).toBe("Game");
    await db.update(playSessions).set({ status: "cancelled" }).where(eq(playSessions.id, planned.id));
  });

  it("share one lobby, which shows what the people in it can play", async () => {
    const at = DateTime.fromISO("2031-06-10T20:00", { zone: "America/Chicago" }).toMillis();
    const { sessionId } = await startLive(ctx, "demo-maya", at);
    try {
      expect((await startLive(ctx, "demo-rosa", at)).sessionId).toBe(sessionId); // same lobby, whatever they play
      let s = (await getSession(ctx.group.id, sessionId))!;
      const two = summarizeLive(ctx.games, s.players);
      // Maya and Rosa make a TFT duo; Valorant still needs three more.
      expect(two.games.filter((g) => g.ready).map((g) => g.game.name)).toEqual(["TFT"]);
      expect(gamesInLobby(two).map(progressText)).toEqual(["✅ TFT 2/2", "Valorant 2/5", "Aion 2 1/4", "League of Legends 1/5"]);
      const msg = lobbyMessage(ctx, s.session, two, []);
      expect(msg.content).toContain("✅ **Ready to play:** TFT. Queue up!");
      expect(msg.content).toContain("🎯 ✅ TFT 2/2 · Valorant 2/5 · Aion 2 1/4 · League of Legends 1/5");
      assertDiscordLimits(msg);

      // Everyone joins: the post lists every game with a full party, readiest first.
      for (const id of ["demo-dev", "demo-kai", "demo-sam"]) await setPlayerStatus(ctx, sessionId, id, "in");
      s = (await getSession(ctx.group.id, sessionId))!;
      const all = summarizeLive(ctx.games, s.players);
      expect(lobbyMessage(ctx, s.session, all, []).content).toContain("✅ **Ready to play:** Valorant, Aion 2, TFT. Queue up!");

      // A quick dinner pauses the games that need that person.
      await goToDinner(ctx, sessionId, "demo-rosa", "quick");
      s = (await getSession(ctx.group.id, sessionId))!;
      const dinner = summarizeLive(ctx.games, s.players);
      expect(dinner.state).toBe("paused");
      expect(gamesInLobby(dinner).map(progressText)).toContain("Valorant 4/5 (+1 at dinner)");
      expect(lobbyMessage(ctx, s.session, dinner, []).content).toContain("⏸️ **Paused,** waiting on dinner.");
    } finally {
      await endSession(ctx, sessionId);
    }
  });

  it("doesn't ping anyone when a game fills: the lobby post just updates", async () => {
    const { sessionId } = await startLive(ctx, "demo-dev");
    try {
      for (const id of ["demo-rosa", "demo-sam"]) await setPlayerStatus(ctx, sessionId, id, "in");
      const tasks: Array<() => Promise<unknown>> = [];
      // Kai taps I'm in, which fills Aion 2 (a 4-stack).
      const res = await handleInteraction({ ...base, type: 3, data: { custom_id: `lfg:in:${sessionId}` } }, (t) => tasks.push(t));
      expect(res.type).toBe(7); // edits the post in place
      expect(res.data!.content).toContain("✅ **Ready to play:** Aion 2. Queue up!");
      expect(tasks).toHaveLength(0); // no follow-up message
    } finally {
      await endSession(ctx, sessionId);
    }
  });

  it("/lfg always opens a new lobby for every game, and the old one closes", async () => {
    const opened = await handleInteraction({ ...base, type: 2, data: { name: "lfg" } }, () => {});
    try {
      expect(opened.type).toBe(4);
      expect(opened.data!.flags).toBeUndefined(); // a public post
      // Kai alone: Aion 2 (a 4-stack) is the closest to a full party.
      expect(opened.data!.content).toMatch(/^🎮 \*\*Who's on\?\*\* 1 in, Aion 2 needs 3 more\n/);
      expect(opened.data!.content).toContain("🎯 Aion 2 1/4 · Valorant 1/5 · League of Legends 1/5");
      assertDiscordLimits(opened.data!);
      const first = (await activeLive(ctx.group))!.session.id;
      await setPlayerStatus(ctx, first, "demo-sam", "in");

      // Again (even with a game from an older copy of the command): a new lobby with just Kai, and the old one closes.
      const tasks: Array<() => Promise<unknown>> = [];
      const again = await handleInteraction(
        { ...base, type: 2, data: { name: "lfg", options: [{ name: "game", value: "tft" }] } },
        (t) => tasks.push(t),
      );
      expect(again.data!.content).toContain("1 in");
      const live = (await activeLive(ctx.group))!;
      expect(live.session.id).not.toBe(first);
      expect(live.players.map((p) => p.userId)).toEqual(["demo-kai"]);
      expect((await getSession(ctx.group.id, first))!.session.status).toBe("ended");
      expect(tasks).toHaveLength(1); // remember the new post, and point the old one to it
    } finally {
      const live = await activeLive(ctx.group);
      if (live) await endSession(ctx, live.session.id);
    }
  });

  it("/windows shows your games, or the one you name", async () => {
    const mine = await handleInteraction({ ...base, type: 2, data: { name: "windows" } }, () => {});
    for (const g of gamesOf(ctx, "demo-kai")) expect(mine.data!.content).toContain(`**${g.name}**`);
    expect(mine.data!.content).not.toContain("**TFT**");
    assertDiscordLimits(mine.data!);
    const one = await handleInteraction({ ...base, type: 2, data: { name: "windows", options: [{ name: "game", value: "tft" }] } }, () => {});
    expect(one.data!.content).toContain("**TFT** (duo)");
    expect(one.data!.content).not.toContain("**Valorant**");
  });

  it("are suggested as you type, yours first", async () => {
    const ask = (value: string) =>
      handleAutocomplete({ ...base, type: 4, data: { name: "windows", options: [{ name: "game", value, focused: true }] } });
    const all = await ask("");
    expect(all.type).toBe(8);
    const theirs = gamesOf(ctx, "demo-kai");
    expect(all.data.choices.map((c) => c.value)).toEqual([...theirs, ...ctx.games.filter((g) => !theirs.includes(g))].map((g) => g.id));
    expect((await ask("LEG")).data.choices).toEqual([
      { name: "League of Legends (5-stack) · 4 players", value: byName("League of Legends").id },
    ]);
  });
});

describe("locked-in party", () => {
  const ALL = ["demo-maya", "demo-dev", "demo-rosa", "demo-kai", "demo-sam"];
  const made: string[] = [];
  /** A Valorant session for the five, starting at `startMs`. */
  async function plannedSession(startMs: number, minutes = 180) {
    const db = await getDb();
    const [session] = await db
      .insert(playSessions)
      .values({
        groupId: ctx.group.id,
        gameId: val().game.id,
        kind: "planned",
        startAt: new Date(startMs),
        endAt: new Date(startMs + minutes * 60_000),
        plan: { playMinutes: minutes, subs: 0, pauses: [] },
        createdBy: "demo-kai",
      })
      .returning();
    await db.insert(playSessionPlayers).values(ALL.map((userId) => ({ sessionId: session.id, userId, status: "in" as const })));
    made.push(session.id);
    return session;
  }

  beforeAll(async () => {
    const db = await getDb();
    for (const [userId, discordId] of [["demo-kai", "1001"], ["demo-sam", "1002"], ["demo-dev", "1003"]]) {
      await db.update(memberProfiles).set({ discordId }).where(eq(memberProfiles.userId, userId));
    }
    ctx = await fresh();
  });
  afterAll(async () => {
    // Cancelled sessions leave the lists and the late history.
    const db = await getDb();
    for (const id of made) await db.update(playSessions).set({ status: "cancelled" }).where(eq(playSessions.id, id));
    await db.update(memberProfiles).set({ discordId: null }).where(eq(memberProfiles.userId, "demo-dev"));
    ctx = await fresh();
  });

  it("needs 2 votes to remove someone, or 1 in a duo", () => {
    expect([1, 2, 3, 4, 5, 6, 10].map(kickVotesNeeded)).toEqual([1, 1, 2, 2, 2, 3, 5]);
  });

  it("lets anyone drop out (and rejoin), and two teammates' votes remove someone", async () => {
    const s = await plannedSession(Date.now() + 26 * 3_600_000);
    const party = async (viewer: string | null = null) => (await getParty(ctx, s.id, viewer))!.party;
    expect(await party()).toMatchObject({ party: ALL, dropped: [], removed: [], needed: 2, open: true });

    // Kai can't make it, then can after all.
    expect(await toggleDropOut(ctx, s.id, "demo-kai")).toMatchObject({ dropped: true, party: { dropped: ["demo-kai"] } });
    expect((await party()).party).not.toContain("demo-kai");
    expect(await toggleDropOut(ctx, s.id, "demo-kai")).toMatchObject({ dropped: false, party: { party: ALL, dropped: [] } });

    // Only players vote, and only on other players.
    const jordan = ctx.members.find((m) => m.name === "Jordan")!.id;
    await expect(toggleKickVote(ctx, s.id, "demo-sam", "demo-sam")).rejects.toThrow(/yourself/);
    await expect(toggleKickVote(ctx, s.id, jordan, "demo-sam")).rejects.toThrow(/Only players/);
    await expect(toggleKickVote(ctx, s.id, "demo-maya", jordan)).rejects.toThrow(/not in the party/);
    await expect(toggleDropOut(ctx, s.id, jordan)).rejects.toThrow(/not in this session/);

    // One vote isn't enough and can be taken back; only the voter sees it was theirs.
    const one = await toggleKickVote(ctx, s.id, "demo-maya", "demo-sam");
    expect(one).toMatchObject({ voted: true, removed: false, party: { mine: ["demo-sam"] } });
    expect(one.party.votes).toEqual({ "demo-sam": 1 });
    expect((await party("demo-dev")).mine).toEqual([]);
    const undo = await toggleKickVote(ctx, s.id, "demo-maya", "demo-sam");
    expect(undo).toMatchObject({ voted: false, removed: false });
    expect(undo.party.votes).toEqual({});

    // A vote stops counting while its voter is out of the party.
    await toggleKickVote(ctx, s.id, "demo-rosa", "demo-sam");
    await toggleDropOut(ctx, s.id, "demo-rosa");
    expect((await party()).votes).toEqual({});
    await toggleDropOut(ctx, s.id, "demo-rosa");
    expect((await party()).votes).toEqual({ "demo-sam": 1 });

    // The second vote removes Sam, for good.
    const out = await toggleKickVote(ctx, s.id, "demo-dev", "demo-sam");
    expect(out).toMatchObject({ voted: true, removed: true, party: { party: ALL.filter((id) => id !== "demo-sam"), removed: ["demo-sam"] } });
    expect(out.party.votes).toEqual({});
    await expect(toggleDropOut(ctx, s.id, "demo-sam")).rejects.toThrow(/voted out/);
    await expect(toggleKickVote(ctx, s.id, "demo-sam", "demo-kai")).rejects.toThrow(/Only players/);

    // Nothing changes once it's over.
    const after = s.endAt!.getTime() + 60_000;
    expect((await getParty(ctx, s.id, null, after))!.party.open).toBe(false);
    await expect(toggleDropOut(ctx, s.id, "demo-maya", after)).rejects.toThrow(/over/);
    await expect(toggleKickVote(ctx, s.id, "demo-maya", "demo-kai", after)).rejects.toThrow(/over/);
  });

  it("keeps the bar from the party that locked in, so drop-outs don't lower it", async () => {
    const s = await plannedSession(Date.now() + 27 * 3_600_000);
    const p = (userId: string, status: "in" | "declined") => ({ sessionId: s.id, userId, status, backAt: null, updatedAt: new Date() });
    const trio = partyOf(ctx, s, [p("demo-rosa", "declined"), p("demo-dev", "in"), p("demo-maya", "in")], [{ voterId: "demo-maya", targetId: "demo-dev" }], null);
    expect(trio).toMatchObject({ party: ["demo-maya", "demo-dev"], dropped: ["demo-rosa"], needed: 2 }); // member order
    expect(trio.votes).toEqual({ "demo-dev": 1 });
  });

  it("shows the party on the post: who's out, open votes, and buttons until it ends", async () => {
    const s = await plannedSession(Date.now() + 74 * 3_600_000);
    await toggleDropOut(ctx, s.id, "demo-kai");
    await toggleKickVote(ctx, s.id, "demo-maya", "demo-sam");
    await toggleKickVote(ctx, s.id, "demo-dev", "demo-sam");
    await toggleKickVote(ctx, s.id, "demo-maya", "demo-rosa");
    const late = (await getLateTally(ctx.group.id, s.id))!;
    const msg = storedPlannedMessage(ctx, late.session, late.tally, (await getParty(ctx, s.id))!.party);
    expect(msg.content).toContain("(3/5, need 2 more)");
    expect(msg.content).toContain(`🙅 Can't make it: ${mention(ctx.byId.get("demo-kai"))}`);
    expect(msg.content).toContain(`🚪 Voted out: ${mention(ctx.byId.get("demo-sam"))}`);
    expect(msg.content).toContain("🗳️ Votes to remove: **Rosa** 1/2");
    expect(msg.components!.at(-1)!.components.map((b) => b.custom_id)).toEqual([`join:${s.id}`, `drop:${s.id}`, `kickmenu:${s.id}`]);
    assertDiscordLimits(msg);

    const over = (await getParty(ctx, s.id, null, s.endAt!.getTime() + 1))!.party;
    const ended = storedPlannedMessage(ctx, late.session, late.tally, over);
    expect(ended.components!.flatMap((r) => r.components.map((b) => b.custom_id))).not.toContain(`drop:${s.id}`);
    expect(ended.content).not.toContain("Votes to remove");
  });

  it("late check: dropping out before the start takes you out of it, after the start doesn't", async () => {
    const start = Date.now() - 30 * 60_000;
    const s = await plannedSession(start);
    await toggleDropOut(ctx, s.id, "demo-dev", start - 10 * 60_000); // said so before it started
    await toggleDropOut(ctx, s.id, "demo-rosa", start + 10 * 60_000); // bailed after the start
    const { tally } = (await getLateTally(ctx.group.id, s.id))!;
    expect(tally.voting).toBe("open");
    expect([...tally.players].sort()).toEqual(["demo-kai", "demo-maya", "demo-rosa", "demo-sam"]);
    expect((await toggleLateReport(ctx, s.id, "demo-maya", "demo-rosa")).reported).toBe(true);
    await expect(toggleLateReport(ctx, s.id, "demo-maya", "demo-dev")).rejects.toThrow(/weren't in/);
  });

  it("works from Discord: Can't make it, and a private picker to vote someone out", async () => {
    const s = await plannedSession(Date.now() + 50 * 3_600_000);
    const click = async (customId: string, discordId = "1001") => {
      const tasks: Array<() => Promise<unknown>> = [];
      const res = await handleInteraction(
        {
          id: "1",
          application_id: "app",
          type: 3,
          token: "t",
          channel_id: "chan",
          member: { user: { id: discordId, username: discordId } },
          data: { custom_id: customId },
          message: { id: "msg", channel_id: "chan" },
        },
        (t) => tasks.push(t),
      );
      return { ...res, tasks };
    };
    const ids = (msg: { components?: Array<{ components: Array<{ custom_id?: string }> }> }) =>
      (msg.components ?? []).flatMap((r) => r.components.map((b) => b.custom_id));

    const out = await click(`drop:${s.id}`);
    expect(out.type).toBe(7); // edits the post in place
    expect(out.data!.content).toContain(`🙅 Can't make it: ${mention(ctx.byId.get("demo-kai"))}`);
    expect(out.data!.content).toContain("(4/5, need 1 more)");
    expect(out.tasks).toHaveLength(1); // the private "you're out" note
    assertDiscordLimits(out.data!);

    const outsider = await click(`kickmenu:${s.id}`);
    expect(outsider).toMatchObject({ type: 4, data: { flags: 64 } });
    expect(outsider.data!.content).toMatch(/Only players/);
    expect((await click(`drop:${s.id}`)).data!.content).not.toContain("Can't make it:"); // back in

    const menu = await click(`kickmenu:${s.id}`);
    expect(menu).toMatchObject({ type: 4, data: { flags: 64 } }); // only Kai sees it
    expect(ids(menu.data!)).toEqual(["demo-maya", "demo-dev", "demo-rosa", "demo-sam"].map((id) => `kick:${s.id}:${id}`));
    assertDiscordLimits(menu.data!);

    const vote = await click(`kick:${s.id}:demo-sam`);
    expect(vote.type).toBe(7); // updates the private picker
    expect(vote.data!.flags).toBeUndefined();
    expect(vote.data!.content).toContain("You voted to remove **Sam** (1 of 2)");
    expect(vote.data!.components![0].components.find((b) => b.custom_id === `kick:${s.id}:demo-sam`)!.label).toBe("✓ Sam · 1/2");
    expect(vote.tasks).toHaveLength(1); // refresh the shared post

    const self = await click(`kick:${s.id}:demo-sam`, "1002");
    expect(self).toMatchObject({ type: 4, data: { flags: 64 } });
    expect(self.data!.content).toMatch(/yourself/);

    const second = await click(`kick:${s.id}:demo-sam`, "1003"); // Dev
    expect(second.data!.content).toContain("🚪 **Sam** was voted out.");
    expect(ids(second.data!)).not.toContain(`kick:${s.id}:demo-sam`);
  });
});

describe("locked-in attendance: ✋ Join, the change log, and who showed up", () => {
  const FOUR = ["demo-maya", "demo-dev", "demo-kai", "demo-sam"];
  const made: string[] = [];
  const user = (id: string) => ({ user: { id, username: id } });
  const base = { id: "1", application_id: "app", token: "t", channel_id: "chan" };
  const click = async (customId: string, discordId: string) => {
    const tasks: Array<() => Promise<unknown>> = [];
    const res = await handleInteraction(
      { ...base, type: 3, member: user(discordId), data: { custom_id: customId }, message: { id: "msg", channel_id: "chan" } },
      (t) => tasks.push(t),
    );
    return { ...res, tasks };
  };
  const ids = (msg: { components?: Array<{ components: Array<{ custom_id?: string }> }> }) =>
    (msg.components ?? []).flatMap((r) => r.components.map((b) => b.custom_id));
  const jordan = () => ctx.members.find((m) => m.name === "Jordan")!.id;

  /** A Valorant session for `party`, starting at `startMs`. */
  async function lockedIn(startMs: number, party = FOUR, minutes = 180) {
    const db = await getDb();
    const [session] = await db
      .insert(playSessions)
      .values({
        groupId: ctx.group.id,
        gameId: val().game.id,
        kind: "planned",
        startAt: new Date(startMs),
        endAt: new Date(startMs + minutes * 60_000),
        plan: { playMinutes: minutes, subs: 0, pauses: [] },
        createdBy: "demo-kai",
      })
      .returning();
    await db.insert(playSessionPlayers).values(party.map((userId) => ({ sessionId: session.id, userId, status: "in" as const })));
    made.push(session.id);
    return session;
  }
  /** The session's Discord post as it would be rendered now. */
  const post = async (sessionId: string, c = ctx) => {
    const [late, found] = await Promise.all([getLateTally(c.group.id, sessionId), getParty(c, sessionId)]);
    return storedPlannedMessage(c, late!.session, late!.tally, found!.party);
  };

  beforeAll(async () => {
    const db = await getDb();
    for (const [userId, discordId] of [["demo-kai", "1001"], ["demo-sam", "1002"], ["demo-dev", "1003"]]) {
      await db.update(memberProfiles).set({ discordId }).where(eq(memberProfiles.userId, userId));
    }
    // Earlier tests' lobbies ran moments ago, so everyone in them would count as seen during these sessions.
    // Move them a month back.
    const month = 30 * 24 * 3_600_000;
    for (const l of await db.select().from(playSessions).where(eq(playSessions.kind, "live"))) {
      await db
        .update(playSessions)
        .set({ status: "ended", startAt: new Date(l.startAt.getTime() - month), endAt: new Date((l.endAt ?? l.startAt).getTime() - month) })
        .where(eq(playSessions.id, l.id));
    }
    ctx = await fresh();
  });
  afterAll(async () => {
    const db = await getDb();
    for (const id of made) await db.update(playSessions).set({ status: "cancelled" }).where(eq(playSessions.id, id));
    await db.update(memberProfiles).set({ discordId: null }).where(eq(memberProfiles.userId, "demo-dev"));
    ctx = await fresh();
  });

  it("lets anyone join before or after the start, and logs every change to the party", async () => {
    const start = Date.now() + 3 * 3_600_000;
    const at = (min: number) => start + min * 60_000;
    const s = await lockedIn(start);
    expect(await joinSession(ctx, s.id, "demo-rosa", at(-60))).toMatchObject({ rejoined: false, party: { joined: ["demo-rosa"] } });
    await expect(joinSession(ctx, s.id, "demo-rosa")).rejects.toThrow(/already in/);
    await toggleDropOut(ctx, s.id, "demo-kai", at(-30));
    expect(await joinSession(ctx, s.id, "demo-kai", at(-20))).toMatchObject({ rejoined: true }); // Join works for drop-outs too
    await toggleKickVote(ctx, s.id, "demo-maya", "demo-sam", at(-10));
    expect((await toggleKickVote(ctx, s.id, "demo-dev", "demo-sam", at(-10))).removed).toBe(true);
    await expect(joinSession(ctx, s.id, "demo-sam")).rejects.toThrow(/voted out/);
    // After the start too (someone running late, or free for only the second half), until it ends.
    expect([...(await joinSession(ctx, s.id, jordan(), at(40))).party.joined].sort()).toEqual(["demo-rosa", jordan()].sort());
    await expect(joinSession(ctx, s.id, "demo-sam", s.endAt!.getTime() + 1)).rejects.toThrow(/over/);

    const { party } = (await getParty(ctx, s.id))!;
    expect(party.log.map((e) => `${e.userId} ${e.kind}`)).toEqual([
      "demo-rosa joined",
      "demo-kai left",
      "demo-kai rejoined",
      "demo-sam removed",
      `${jordan()} joined`,
    ]);
    const msg = await post(s.id);
    expect(msg.content).toContain(
      "🔁 **Rosa** joined 1h before · **Kai** left 30m before · **Kai** rejoined 20m before · **Sam** was voted out 10m before · **Jordan** joined 40m in",
    );
    expect(ids(msg)).toEqual([`join:${s.id}`, `drop:${s.id}`, `kickmenu:${s.id}`]); // no attendance check before the start
    assertDiscordLimits(msg);
  });

  it("lists who else is free for some or all of it, so they can join", async () => {
    const zone = ctx.byId.get("demo-rosa")!.timezone;
    const day = DateTime.now().setZone(zone).plus({ days: 2 }).set({ hour: 20, minute: 0, second: 0, millisecond: 0 });
    const s = await lockedIn(day.toMillis()); // 8–11 PM in Rosa's zone, without her
    const date = day.toISODate()!;
    /** The group with Rosa's schedule for that day set to `pattern` (40 half hours from 8 AM). */
    const withRosa = (pattern: string) => ({
      ...ctx,
      inputs: ctx.inputs.map((m) => (m.id === "demo-rosa" ? { ...m, overrides: { ...m.overrides, [date]: pattern } } : m)),
    });
    const found = (await getSession(ctx.group.id, s.id))!;
    const rosa = (c: typeof ctx) =>
      partyOf(c, found.session, found.players, found.votes, null, Date.now(), found.events).alsoFree.find((f) => f.id === "demo-rosa");
    const secondHalf = withRosa(".".repeat(26) + "F".repeat(4) + ".".repeat(10)); // free 9–11 PM
    expect(rosa(secondHalf)).toEqual({
      id: "demo-rosa",
      fromMs: day.plus({ hours: 1 }).toMillis(),
      untilMs: day.plus({ hours: 3 }).toMillis(),
      whole: false,
    });
    expect(rosa(withRosa("F".repeat(40)))).toMatchObject({ whole: true });
    expect(rosa(withRosa(".".repeat(40)))).toBeUndefined();

    const msg = await post(s.id, secondHalf);
    expect(msg.content).toContain(`**Rosa** (<t:${day.plus({ hours: 1 }).toSeconds()}:t>–<t:${day.plus({ hours: 3 }).toSeconds()}:t>)`);
    expect(msg.content).toContain("Tap ✋ Join to play, even for part of it.");
  });

  it("takes late and no-show reports (one or the other), and adds people who played without joining", async () => {
    const start = Date.now() - 30 * 60_000;
    const s = await lockedIn(start);
    expect(await toggleNoShowReport(ctx, s.id, "demo-maya", "demo-sam")).toMatchObject({
      reported: true,
      tally: { noShows: { "demo-sam": 1 }, mineNoShow: ["demo-sam"] },
    });
    const changed = await toggleLateReport(ctx, s.id, "demo-maya", "demo-sam"); // Maya makes it "late" instead
    expect(changed.tally).toMatchObject({ counts: { "demo-sam": 1 }, mine: ["demo-sam"], mineNoShow: [] });
    expect(changed.tally.noShows).toEqual({});
    await toggleNoShowReport(ctx, s.id, "demo-dev", "demo-sam");
    expect((await toggleNoShowReport(ctx, s.id, "demo-kai", "demo-sam")).tally).toMatchObject({ needed: 2, noShows: { "demo-sam": 2 } });
    await expect(toggleNoShowReport(ctx, s.id, "demo-sam", "demo-sam")).rejects.toThrow(/yourself/);
    await expect(toggleNoShowReport(ctx, s.id, "demo-rosa", "demo-sam")).rejects.toThrow(/Only players/);

    // ➕ Rosa played without being in the party: a teammate adds her.
    await expect(addPlayer(ctx, s.id, "demo-rosa", "demo-rosa")).rejects.toThrow(/Only players/);
    expect((await addPlayer(ctx, s.id, "demo-maya", "demo-rosa")).tally.players).toContain("demo-rosa");
    await expect(addPlayer(ctx, s.id, "demo-maya", "demo-rosa")).rejects.toThrow(/already/);
    expect((await getParty(ctx, s.id))!.party.log.map((e) => `${e.userId} ${e.kind}`)).toEqual(["demo-rosa added"]);

    const { noShow, played } = attendanceOf((await getLateTally(ctx.group.id, s.id))!.tally);
    expect(noShow).toEqual(["demo-sam"]);
    expect([...played].sort()).toEqual(["demo-dev", "demo-kai", "demo-maya", "demo-rosa"]);
    const msg = await post(s.id);
    expect(msg.content).toContain("📋 **Attendance check is open**");
    expect(msg.content).toContain("👻 No-show: **Sam** ×2 (counts as a no-show)");
    expect(msg.content).toContain("**Rosa** played (added by a teammate) 30m in");
    expect(ids(msg)).toEqual([`check:${s.id}`, `join:${s.id}`, `drop:${s.id}`, `kickmenu:${s.id}`]);
    assertDiscordLimits(msg);

    // A day later the check closes with the result, and the buttons go.
    const later = start + 25 * 3_600_000;
    const closed = (await getLateTally(ctx.group.id, s.id, null, later))!;
    const done = storedPlannedMessage(ctx, closed.session, closed.tally, (await getParty(ctx, s.id, null, later))!.party);
    expect(done.content).toContain("📋 Attendance check closed. ✅ Played: **Maya**, **Dev**, **Rosa**, **Kai** · 👻 No-show: **Sam**");
    expect(done.components).toEqual([]);
  });

  it("works from Discord: a private panel to report, ➕ to add someone, and ✅ for anyone seen in a lobby", async () => {
    const start = Date.now() - 60 * 60_000;
    const s = await lockedIn(start);
    const lobby = await startFreshLive(ctx, "demo-maya", start - 30 * 60_000);
    await setPlayerStatus(ctx, lobby.sessionId, "demo-sam", "in"); // Sam tapped I'm in during the session
    try {
      const panel = await click(`check:${s.id}`, "1001"); // Kai
      expect(panel).toMatchObject({ type: 4, data: { flags: 64 } });
      const rows = panel.data!.components!;
      expect(rows.map((r) => r.components[0].custom_id)).toEqual([...FOUR.map((id) => `chkl:${s.id}:${id}`), `chka:${s.id}`]);
      expect(rows[2].components.every((b) => b.disabled)).toBe(true); // Kai's own row
      expect(rows[3].components[1]).toMatchObject({ label: "In the lobby", disabled: true }); // Sam
      assertDiscordLimits(panel.data!);
      await expect(toggleNoShowReport(ctx, s.id, "demo-maya", "demo-sam")).rejects.toThrow(/in the lobby/);

      const tap = await click(`chkn:${s.id}:demo-dev`, "1001");
      expect(tap.type).toBe(7); // updates the panel
      expect(tap.data!.content).toContain("👻 You reported **Dev** as a no-show (1 of 2 reports)");
      expect(tap.tasks).toHaveLength(1); // and refreshes the shared post
      expect((await click(`chkl:${s.id}:demo-dev`, "1001")).data!.content).toContain("⏰ You reported **Dev** as late");

      const picker = await click(`chka:${s.id}`, "1001");
      expect(ids(picker.data!)).toContain(`chkadd:${s.id}:${jordan()}`);
      expect((await click(`chkadd:${s.id}:${jordan()}`, "1001")).data!.content).toContain("➕ Added **Jordan**");

      // Before the start, the panel only says when it opens; ✋ Join is on the post.
      const soon = await lockedIn(Date.now() + 5 * 3_600_000, ["demo-maya", "demo-dev", "demo-kai"]);
      expect((await click(`check:${soon.id}`, "1001")).data!.content).toMatch(/opens when the session starts/);
      const joined = await click(`join:${soon.id}`, "1002"); // Sam
      expect(joined.type).toBe(7);
      expect(joined.data!.content).toContain("🔁 **Sam** joined 5h before");
      expect(joined.tasks).toHaveLength(1); // the private "you're in"
    } finally {
      await endSession(ctx, lobby.sessionId);
    }
  });
});

describe("opt-in DMs when a 5-stack fills", () => {
  const OPTED = ["demo-maya", "demo-kai", "demo-sam"]; // Maya hasn't logged in with Discord
  const optIn = async (on: boolean) => {
    const db = await getDb();
    for (const id of OPTED) await db.update(memberProfiles).set({ dmWhenFull: on }).where(eq(memberProfiles.userId, id));
    ctx = await fresh();
  };
  beforeAll(async () => {
    const db = await getDb();
    await db.update(memberProfiles).set({ discordId: "1001" }).where(eq(memberProfiles.userId, "demo-kai"));
    await db.update(memberProfiles).set({ discordId: "1002" }).where(eq(memberProfiles.userId, "demo-sam"));
    await optIn(true);
  });
  afterAll(() => optIn(false));

  it("go to people in the lobby who play that game and asked for one, but not whoever tapped", async () => {
    const { sessionId } = await startFreshLive(ctx, "demo-maya");
    try {
      for (const id of ["demo-dev", "demo-rosa", "demo-kai"]) await setPlayerStatus(ctx, sessionId, id, "in");
      let s = (await getSession(ctx.group.id, sessionId))!;
      const before = fullStacks(summarizeLive(ctx.games, s.players));
      expect(before).toEqual([]); // TFT's ready, but duos don't count
      await setPlayerStatus(ctx, sessionId, "demo-sam", "in"); // the fifth Valorant player
      s = (await getSession(ctx.group.id, sessionId))!;

      const dms = stackDms(ctx, s.players, { before, actorId: "demo-sam" });
      expect(dms.map((d) => [d.userId, d.discordId, d.game.game.name])).toEqual([["demo-kai", "1001", "Valorant"]]);
      expect(stackDms(ctx, s.players, { before }).map((d) => d.userId).sort()).toEqual(["demo-kai", "demo-sam"]);
      expect(stackDms(ctx, s.players, { before: fullStacks(summarizeLive(ctx.games, s.players)) })).toEqual([]); // nothing new

      const dm = stackReadyDm(ctx, dms[0].game, "https://discord.com/channels/g/c/m");
      expect(dm.content).toContain("🎮 **Valorant 5-stack is ready:** Maya, Dev, Rosa, Kai, Sam. Hop in voice!");
      expect(dm.content).toContain("Lobby: https://discord.com/channels/g/c/m");
      expect(dm.allowed_mentions).toEqual({ parse: [] });
    } finally {
      await endSession(ctx, sessionId);
    }
  });

  it("are queued by the tap that fills a 5-stack, and only that one", async () => {
    const { sessionId } = await startFreshLive(ctx, "demo-maya");
    const tap = async (discordId: string) => {
      const tasks: Array<() => Promise<unknown>> = [];
      const res = await handleInteraction(
        {
          id: "1",
          application_id: "app",
          type: 3,
          token: "t",
          channel_id: "chan",
          member: { user: { id: discordId, username: discordId } },
          data: { custom_id: `lfg:in:${sessionId}` },
        },
        (t) => tasks.push(t),
      );
      expect(res.type).toBe(7);
      return tasks;
    };
    try {
      for (const id of ["demo-dev", "demo-rosa"]) await setPlayerStatus(ctx, sessionId, id, "in");
      expect(await tap("1001")).toHaveLength(0); // Kai: Valorant 4/5
      expect(await tap("1002")).toHaveLength(1); // Sam fills it: Kai gets a DM
      expect(await tap("1002")).toHaveLength(0); // already full
    } finally {
      await endSession(ctx, sessionId);
    }
  });

  it("are switched on in the profile, and saving without the box keeps the choice", async () => {
    const dev = { timezone: "America/Denver", workStyle: "hybrid" as const, nightBeforeWfhUntil: "00:30", hybridDays: { 1: "flex" as const, 5: "wfh" as const } };
    const dmOf = async () => (await fresh()).byId.get("demo-dev")!.dmWhenFull;
    expect(await dmOf()).toBe(false);
    await saveProfile("demo-dev", { ...dev, dmWhenFull: true });
    expect(await dmOf()).toBe(true);
    await saveProfile("demo-dev", dev);
    expect(await dmOf()).toBe(true);
    await saveProfile("demo-dev", { ...dev, dmWhenFull: false });
    expect(await dmOf()).toBe(false);
  });
});

describe("lobby vote-out and /votekick", () => {
  const ALL = ["demo-maya", "demo-dev", "demo-rosa", "demo-kai", "demo-sam"];
  const made: string[] = [];
  const user = (id: string) => ({ user: { id, username: id } });
  const base = { id: "1", application_id: "app", token: "t", channel_id: "chan" };
  /** A tap on a button, as the Discord user `discordId`; also returns the work queued after the reply. */
  const click = async (customId: string, discordId: string) => {
    const tasks: Array<() => Promise<unknown>> = [];
    const res = await handleInteraction(
      { ...base, type: 3, member: user(discordId), data: { custom_id: customId }, message: { id: "msg", channel_id: "chan" } },
      (t) => tasks.push(t),
    );
    return { ...res, tasks };
  };
  const votekick = async (discordId: string, target: string) => {
    const tasks: Array<() => Promise<unknown>> = [];
    const res = await handleInteraction(
      { ...base, type: 2, member: user(discordId), data: { name: "votekick", options: [{ name: "user", value: target }] } },
      (t) => tasks.push(t),
    );
    expect(res).toMatchObject({ type: 4, data: { flags: 64 } }); // always private
    return { ...res, tasks };
  };
  const ids = (msg: { components?: Array<{ components: Array<{ custom_id?: string }> }> }) =>
    (msg.components ?? []).flatMap((r) => r.components.map((b) => b.custom_id));
  const soon = () => new Date(Date.now() + 15 * 60_000);

  beforeAll(async () => {
    const db = await getDb();
    for (const [userId, discordId] of [["demo-kai", "1001"], ["demo-sam", "1002"], ["demo-dev", "1003"]]) {
      await db.update(memberProfiles).set({ discordId }).where(eq(memberProfiles.userId, userId));
    }
    // A clean slate: no locked-in sessions left over from earlier tests.
    await db
      .update(playSessions)
      .set({ status: "cancelled" })
      .where(and(eq(playSessions.groupId, ctx.group.id), eq(playSessions.kind, "planned"), eq(playSessions.status, "active")));
    ctx = await fresh();
  });
  afterAll(async () => {
    const db = await getDb();
    for (const id of made) await db.update(playSessions).set({ status: "cancelled" }).where(eq(playSessions.id, id));
    await db.update(memberProfiles).set({ discordId: null }).where(eq(memberProfiles.userId, "demo-dev"));
    const live = await activeLive(ctx.group);
    if (live) await endSession(ctx, live.session.id);
    ctx = await fresh();
  });

  it("lets the people who are in vote out someone who isn't around, who can tap I'm in to come back", async () => {
    const { sessionId } = await startFreshLive(ctx, "demo-maya");
    try {
      for (const id of ["demo-dev", "demo-rosa", "demo-kai"]) await setPlayerStatus(ctx, sessionId, id, "in");
      await setPlayerStatus(ctx, sessionId, "demo-sam", "soon", soon());
      const lobby = async () => (await getParty(ctx, sessionId))!.party;
      expect(await lobby()).toMatchObject({ kind: "live", party: ALL, voters: ALL.filter((id) => id !== "demo-sam"), needed: 2, open: true });

      const jordan = ctx.members.find((m) => m.name === "Jordan")!.id;
      await expect(toggleKickVote(ctx, sessionId, "demo-sam", "demo-kai")).rejects.toThrow(/Tap I'm in first/); // on the way: can't vote
      await expect(toggleKickVote(ctx, sessionId, "demo-kai", "demo-kai")).rejects.toThrow(/Leaving/);
      await expect(toggleKickVote(ctx, sessionId, "demo-maya", jordan)).rejects.toThrow(/not in the lobby/);
      await expect(toggleDropOut(ctx, sessionId, "demo-maya")).rejects.toThrow(/Leaving/);

      // Sam said "in 15 min" and never showed: two votes and he's out.
      expect(await toggleKickVote(ctx, sessionId, "demo-maya", "demo-sam")).toMatchObject({ voted: true, removed: false });
      const out = await toggleKickVote(ctx, sessionId, "demo-dev", "demo-sam");
      expect(out).toMatchObject({ removed: true, party: { removed: ["demo-sam"] } });
      expect(out.party.party).not.toContain("demo-sam");
      let s = (await getSession(ctx.group.id, sessionId))!;
      expect(summarizeLive(ctx.games, s.players).kicked).toEqual(["demo-sam"]);
      expect(s.votes.filter((v) => v.targetId === "demo-sam")).toEqual([]); // a fresh start if he comes back

      await toggleKickVote(ctx, sessionId, "demo-maya", "demo-kai");
      s = (await getSession(ctx.group.id, sessionId))!;
      const msg = lobbyMessage(ctx, s.session, summarizeLive(ctx.games, s.players), [], partyOf(ctx, s.session, s.players, s.votes, null));
      expect(msg.content).toContain(`🚪 Voted out: ${mention(ctx.byId.get("demo-sam"))} (tap I'm in to come back)`);
      expect(msg.content).toContain("🗳️ Votes to remove: **Kai** 1/2");
      expect(msg.components!.at(-1)!.components.map((b) => b.custom_id)).toEqual([`kickmenu:${sessionId}`, `rate:${sessionId}`]);
      assertDiscordLimits(msg);

      // Here after all: I'm in puts Sam back, with no votes against him.
      await setPlayerStatus(ctx, sessionId, "demo-sam", "in");
      const back = await lobby();
      expect(back.party).toContain("demo-sam");
      expect(back.removed).toEqual([]);
      expect(back.votes["demo-sam"]).toBeUndefined();
    } finally {
      await endSession(ctx, sessionId);
    }
    await expect(toggleKickVote(ctx, sessionId, "demo-maya", "demo-kai")).rejects.toThrow(/closed/);
  });

  it("works from the lobby post: a private picker for people who are in", async () => {
    const { sessionId } = await startFreshLive(ctx, "demo-maya");
    try {
      for (const id of ["demo-kai", "demo-dev"]) await setPlayerStatus(ctx, sessionId, id, "in");
      await setPlayerStatus(ctx, sessionId, "demo-sam", "soon", soon());

      const early = await click(`kickmenu:${sessionId}`, "1002"); // Sam's on the way
      expect(early).toMatchObject({ type: 4, data: { flags: 64 } });
      expect(early.data!.content).toMatch(/Tap I'm in first/);

      const menu = await click(`kickmenu:${sessionId}`, "1001"); // Kai
      expect(menu).toMatchObject({ type: 4, data: { flags: 64 } });
      expect(menu.data!.content).toContain("Vote someone out of the lobby");
      expect(ids(menu.data!)).toEqual(["demo-maya", "demo-dev", "demo-sam"].map((id) => `kick:${sessionId}:${id}`));
      assertDiscordLimits(menu.data!);

      const vote = await click(`kick:${sessionId}:demo-sam`, "1001");
      expect(vote.type).toBe(7); // updates the picker
      expect(vote.data!.content).toContain("You voted to remove **Sam** (1 of 2)");
      expect(vote.tasks).toHaveLength(1); // refresh the lobby post
      const second = await click(`kick:${sessionId}:demo-sam`, "1003"); // Dev
      expect(second.data!.content).toContain("🚪 **Sam** was voted out of the lobby.");

      const back = await click(`lfg:in:${sessionId}`, "1002");
      expect(back.type).toBe(7);
      expect(back.data!.content).not.toContain("Voted out");
    } finally {
      await endSession(ctx, sessionId);
    }
  });

  it("/votekick votes someone out where they are, and asks which when it's more than one place", async () => {
    expect((await votekick("1001", "999")).data!.content).toMatch(/I don't know them yet/);
    expect((await votekick("1001", "1001")).data!.content).toMatch(/can't vote yourself out/);
    expect((await votekick("1001", "1002")).data!.content).toMatch(/isn't in the open lobby or an upcoming locked-in session/);

    const { sessionId } = await startFreshLive(ctx, "demo-maya");
    try {
      await setPlayerStatus(ctx, sessionId, "demo-sam", "in");
      expect((await votekick("1001", "1002")).data!.content).toMatch(/Tap I'm in on the lobby post first/); // Kai isn't in

      await setPlayerStatus(ctx, sessionId, "demo-kai", "in");
      const first = await votekick("1001", "1002");
      expect(first.data!.content).toContain("🗳️ You voted to remove **Sam** (1 of 2)");
      expect(ids(first.data!)).toEqual(["demo-maya", "demo-sam"].map((id) => `kick:${sessionId}:${id}`)); // the picker, to undo
      expect(first.tasks).toHaveLength(1); // refresh the lobby post
      const again = await votekick("1001", "1002");
      expect(again.data!.content).toContain("You already voted to remove **Sam** (1 of 2)");
      expect(again.tasks).toHaveLength(0);

      // Sam's also in a locked-in session with Kai: Kai picks where.
      const db = await getDb();
      const start = Date.now() + 30 * 3_600_000;
      const [planned] = await db
        .insert(playSessions)
        .values({ groupId: ctx.group.id, gameId: val().game.id, kind: "planned", startAt: new Date(start), endAt: new Date(start + 7_200_000), createdBy: "demo-kai" })
        .returning();
      made.push(planned.id);
      await db.insert(playSessionPlayers).values(ALL.map((userId) => ({ sessionId: planned.id, userId, status: "in" as const })));
      const choice = await votekick("1001", "1002");
      expect(choice.data!.content).toContain("**Sam** is in more than one");
      expect(ids(choice.data!)).toEqual([`kick:${sessionId}:demo-sam`, `kick:${planned.id}:demo-sam`]);
      const labels = choice.data!.components![0].components.map((b) => b.label);
      expect(labels[0]).toBe("✓ The lobby · 1/2");
      expect(labels[1]).toMatch(/^Valorant .+ · 0\/2$/);
      assertDiscordLimits(choice.data!);
      const picked = await click(`kick:${planned.id}:demo-sam`, "1001");
      expect(picked.type).toBe(7);
      expect(picked.data!.content).toContain("You voted to remove **Sam** (1 of 2)");

      // Dev isn't in the lobby, so his /votekick goes to the session, and it's the second vote there.
      const second = await votekick("1003", "1002");
      expect(second.data!.content).toContain("🚪 **Sam** was voted out.");
      expect((await getParty(ctx, planned.id))!.party.removed).toEqual(["demo-sam"]);
    } finally {
      await endSession(ctx, sessionId);
    }
  });
});

describe("lobby ratings, bannable offenses and /summary", () => {
  const user = (id: string) => ({ user: { id, username: id } });
  const base = { id: "1", application_id: "app", token: "t", channel_id: "chan" };
  const message = { id: "msg", channel_id: "chan" };
  const click = async (customId: string, discordId: string) => {
    const tasks: Array<() => Promise<unknown>> = [];
    const res = await handleInteraction({ ...base, type: 3, member: user(discordId), data: { custom_id: customId }, message }, (t) => tasks.push(t));
    return { ...res, tasks };
  };
  const ids = (msg: { components?: Array<{ components: Array<{ custom_id?: string }> }> }) =>
    (msg.components ?? []).flatMap((r) => r.components.map((b) => b.custom_id));

  beforeAll(async () => {
    const db = await getDb();
    for (const [userId, discordId] of [["demo-kai", "1001"], ["demo-sam", "1002"], ["demo-dev", "1003"]]) {
      await db.update(memberProfiles).set({ discordId }).where(eq(memberProfiles.userId, userId));
    }
    ctx = await fresh();
  });
  afterAll(async () => {
    const db = await getDb();
    await db.update(memberProfiles).set({ discordId: null }).where(eq(memberProfiles.userId, "demo-dev"));
    ctx = await fresh();
  });

  it("takes 👍/👎 as often as every 2 minutes per person, and totals count every lobby", async () => {
    const t0 = Date.now();
    const at = (min: number) => t0 + min * 60_000;
    const { sessionId } = await startFreshLive(ctx, "demo-maya");
    try {
      for (const id of ["demo-dev", "demo-kai"]) await setPlayerStatus(ctx, sessionId, id, "in");
      await setPlayerStatus(ctx, sessionId, "demo-sam", "declined");
      await expect(rate(ctx, sessionId, "demo-kai", "demo-sam", 1)).rejects.toThrow(/not in this lobby/); // "Not tonight"
      await expect(rate(ctx, sessionId, "demo-sam", "demo-kai", 1)).rejects.toThrow(/Join the lobby first/);
      await expect(rate(ctx, sessionId, "demo-kai", "demo-kai", 1)).rejects.toThrow(/yourself/);

      expect(await rate(ctx, sessionId, "demo-kai", "demo-maya", 1, at(0))).toMatchObject({ added: true, readyAt: at(2) });
      // Within 2 minutes nothing more from Kai counts for Maya, 👍 or 👎…
      expect(await rate(ctx, sessionId, "demo-kai", "demo-maya", 1, at(1))).toMatchObject({ added: false, readyAt: at(2) });
      expect(await rate(ctx, sessionId, "demo-kai", "demo-maya", -1, at(1.5))).toMatchObject({ added: false });
      // …but he can rate someone else, and Maya again once the wait is over.
      expect((await rate(ctx, sessionId, "demo-kai", "demo-dev", 1, at(1))).added).toBe(true);
      expect((await rate(ctx, sessionId, "demo-kai", "demo-maya", 1, at(2))).added).toBe(true);
      const down = await rate(ctx, sessionId, "demo-kai", "demo-maya", -1, at(4));
      expect(down.ratings.lastVote).toEqual({ "demo-maya": -1, "demo-dev": 1 });
      expect(down.ratings.voteReadyAt).toEqual({ "demo-maya": at(6) }); // Dev's wait is over
      expect(down.ratings.totals["demo-maya"]).toMatchObject({ up: 2, down: 1 });
    } finally {
      await endSession(ctx, sessionId);
    }
    await expect(rate(ctx, sessionId, "demo-kai", "demo-dev", 1)).rejects.toThrow(/closed/);

    const next = await startFreshLive(ctx, "demo-kai");
    try {
      await setPlayerStatus(ctx, next.sessionId, "demo-maya", "in");
      expect((await rate(ctx, next.sessionId, "demo-kai", "demo-maya", 1, at(5))).added).toBe(true); // a new lobby starts fresh
      ctx = await fresh();
      expect(ctx.byId.get("demo-maya")!.rep).toMatchObject({ up: 3, down: 1, offenses: 0, menace: false });
    } finally {
      await endSession(ctx, next.sessionId);
    }
  });

  it("needs 3 different people for each bannable offense", () => {
    const cases = [[3], [1, 1], [1, 1, 1], [2, 2, 1], [2, 2, 2], [5, 1, 1], [2, 2, 2, 1], [4, 4], [3, 3, 3]];
    expect(cases.map((reportsPerReporter) => offensesFrom(reportsPerReporter))).toEqual([0, 0, 1, 1, 2, 1, 2, 0, 3]);
  });

  it("takes repeat reports every 2 minutes, counts offenses in a lobby, and tags someone with 3", async () => {
    const t0 = Date.now();
    const at = (min: number) => t0 + min * 60_000;
    const report = (who: string, min: number) => reportOffense(ctx, sessionId, who, "demo-sam", at(min));
    const { sessionId } = await startFreshLive(ctx, "demo-maya");
    try {
      for (const id of ["demo-dev", "demo-rosa", "demo-kai", "demo-sam"]) await setPlayerStatus(ctx, sessionId, id, "in");
      // Maya alone, over and over: never an offense.
      expect((await report("demo-maya", 0)).added).toBe(true);
      expect(await report("demo-maya", 1)).toMatchObject({ added: false, readyAt: at(2) });
      await report("demo-maya", 2);
      const alone = await report("demo-maya", 4);
      expect(alone.ratings).toMatchObject({ reports: { "demo-sam": 3 }, reporters: { "demo-sam": 1 }, myReports: { "demo-sam": 3 } });
      expect(alone.ratings.offenses["demo-sam"] ?? 0).toBe(0);
      // Dev and Rosa too: three different people, one offense.
      await report("demo-dev", 4);
      const one = await report("demo-rosa", 4);
      expect(one).toMatchObject({ added: true, changed: true });
      expect(one.ratings.offenses["demo-sam"]).toBe(1);
      expect(one.ratings.totals["demo-sam"].offenses).toBe(1);
      // Two more incidents, each reported by Dev and Rosa (Maya's earlier reports make the third).
      await report("demo-dev", 6);
      expect((await report("demo-rosa", 6)).ratings.offenses["demo-sam"]).toBe(2);
      await report("demo-dev", 8);
      expect((await report("demo-rosa", 8)).ratings.offenses["demo-sam"]).toBe(3);
      await expect(reportOffense(ctx, sessionId, "demo-sam", "demo-sam", at(8))).rejects.toThrow(/report yourself/);
    } finally {
      await endSession(ctx, sessionId);
    }
    ctx = await fresh();
    const sam = ctx.byId.get("demo-sam")!;
    expect(sam.rep).toMatchObject({ offenses: 3, menace: true });
    expect(mention(sam)).toContain("(🚨 Certified Menace)");
    expect(mention(ctx.byId.get("demo-kai"))).not.toContain("Menace");
  });

  it("stores anonymous feedback, checks it, and caps notes per lobby", async () => {
    const { sessionId } = await startFreshLive(ctx, "demo-maya");
    try {
      for (const id of ["demo-kai", "demo-sam"]) await setPlayerStatus(ctx, sessionId, id, "in");
      await expect(addFeedback(ctx, sessionId, "demo-kai", "demo-sam", "   ")).rejects.toThrow(/Write something/);
      await expect(addFeedback(ctx, sessionId, "demo-kai", "demo-sam", "x".repeat(FEEDBACK_MAX_CHARS + 1))).rejects.toThrow(/under 500/);
      await expect(addFeedback(ctx, sessionId, "demo-dev", "demo-sam", "hi")).rejects.toThrow(/Join the lobby first/);
      for (const n of [1, 2, 3, 4, 5]) await addFeedback(ctx, sessionId, "demo-kai", "demo-sam", `Note ${n}: great comms`);
      await expect(addFeedback(ctx, sessionId, "demo-kai", "demo-sam", "one more")).rejects.toThrow(/5 notes/);
      await addFeedback(ctx, sessionId, "demo-maya", "demo-sam", "Clutched the last round  \n\n\n\n but tilted after losses");
      const notes = await feedbackAbout(ctx.group.id, "demo-sam");
      expect(notes).toHaveLength(6);
      expect(notes).toContain("Clutched the last round \n\n but tilted after losses");
    } finally {
      await endSession(ctx, sessionId);
    }
  });

  it("/summary posts every note about them, word for word, newest first", async () => {
    const summary = async (target: string) => {
      const tasks: Array<() => Promise<unknown>> = [];
      const res = await handleInteraction(
        { ...base, type: 2, member: user("1001"), data: { name: "summary", options: [{ name: "player", value: target }] } },
        (t) => tasks.push(t),
      );
      return { ...res, tasks };
    };
    const unknown = await summary("999");
    expect(unknown).toMatchObject({ type: 4, data: { flags: 64 } });
    expect(unknown.data!.content).toMatch(/I don't know them yet/);

    const sam = await summary("1002");
    expect(sam.type).toBe(4);
    expect(sam.data!.flags).toBe(4); // in the channel for everyone (64 is private), no link previews
    expect(sam.data!.allowed_mentions).toEqual({ parse: [] });
    const text = sam.data!.content;
    expect(text).toContain("📋 **Player report: Sam** · 🚨 Certified Menace");
    expect(text).toContain("👍 0 · 👎 0 · 🚫 3 bannable offenses");
    expect(text).toContain("📝 **Feedback** (6 notes, newest first):");
    expect(text).toContain("\n- Clutched the last round but tilted after losses");
    for (const n of [1, 2, 3, 4, 5]) expect(text).toContain(`\n- Note ${n}: great comms`);
    expect(text.indexOf("Clutched")).toBeLessThan(text.indexOf("Note 5")); // newest first
    expect(text.indexOf("Note 5")).toBeLessThan(text.indexOf("Note 1"));
    expect(sam.tasks).toHaveLength(0); // it all fits in one post
    expect((await summary("1003")).data!.content).toContain("No written feedback yet"); // Dev, so far

    // A long history continues in follow-up messages, in order, every note once.
    const lobby = await startFreshLive(ctx, "demo-maya");
    await endSession(ctx, lobby.sessionId);
    const db = await getDb();
    const t0 = Date.now();
    for (let n = 0; n < 30; n++) {
      const note = `Note ${n}: ${"so many words ".repeat(10).trim()}`;
      await db.insert(playerFeedback).values({ sessionId: lobby.sessionId, authorId: "demo-maya", targetId: "demo-dev", text: note, createdAt: new Date(t0 + n) });
    }
    const followUps: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/webhooks/app/t")) followUps.push(JSON.parse(String(init!.body)).content);
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      const dev = await summary("1003");
      expect(dev.tasks).toHaveLength(1);
      for (const task of dev.tasks) await task();
      const posts = [dev.data!.content, ...followUps];
      expect(posts.length).toBeGreaterThan(1);
      for (const p of posts) expect(p.length).toBeLessThanOrEqual(2000);
      const all = posts.join("\n");
      for (let n = 0; n < 30; n++) expect(all.split(`- Note ${n}: `).length - 1).toBe(1);
      expect(all.indexOf("- Note 29: ")).toBeLessThan(all.indexOf("- Note 0: "));
    } finally {
      globalThis.fetch = realFetch;
    }

    // Notes show exactly as typed: no formatting, links or mentions sneak in. A huge history stops at 10 posts.
    const kai = ctx.byId.get("demo-kai")!;
    expect(playerReportMessages(kai, ["**wow** <@1> [x](y) _hi_"])[0].content).toContain(
      String.raw`- \*\*wow\*\* \<@1> \[x\]\(y\) \_hi\_`,
    );
    const huge = playerReportMessages(kai, Array.from({ length: 300 }, (_, n) => `${n} ${"x".repeat(190)}`));
    expect(huge).toHaveLength(10);
    for (const msg of huge) expect(msg.content.length).toBeLessThanOrEqual(2000);
    expect(huge.at(-1)!.content).toMatch(/…and \d+ older notes \(too many to post\)\.$/);
  });

  it("works from Discord: a private panel, and a pop-up form for feedback", async () => {
    const { sessionId } = await startFreshLive(ctx, "demo-maya");
    try {
      for (const id of ["demo-kai", "demo-sam"]) await setPlayerStatus(ctx, sessionId, id, "in");
      const s = (await getSession(ctx.group.id, sessionId))!;
      expect(ids(lobbyMessage(ctx, s.session, summarizeLive(ctx.games, s.players), []))).toContain(`rate:${sessionId}`);

      const outsider = await click(`rate:${sessionId}`, "1003"); // Dev isn't in this lobby
      expect(outsider).toMatchObject({ type: 4, data: { flags: 64 } });
      expect(outsider.data!.content).toMatch(/Join the lobby first/);

      const panel = await click(`rate:${sessionId}`, "1001"); // Kai
      expect(panel).toMatchObject({ type: 4, data: { flags: 64 } });
      const row = (id: string) => [`up:${sessionId}:${id}`, `down:${sessionId}:${id}`, `ban:${sessionId}:${id}`, `fbopen:${sessionId}:${id}`];
      expect(panel.data!.components!.map((r) => r.components.map((b) => b.custom_id))).toEqual([
        row("demo-maya"),
        row("demo-kai").slice(0, 3), // Kai sees himself too: his numbers, no feedback button
        row("demo-sam"),
      ]);
      const mine = panel.data!.components![1].components;
      expect(mine[0].label).toBe("Kai (you) · 0");
      expect(panel.data!.components!.map((r) => r.components.every((b) => b.disabled))).toEqual([false, true, false]); // only his is grayed out
      assertDiscordLimits(panel.data!);

      const up = await click(`up:${sessionId}:demo-maya`, "1001");
      expect(up.type).toBe(7); // updates the panel
      expect(up.data!.content).toContain("👍 for **Maya**");
      expect(up.data!.components![0].components[0]).toMatchObject({ style: 3, label: "Maya · 4" }); // her 4th 👍 overall
      const tooSoon = await click(`down:${sessionId}:demo-maya`, "1001");
      expect(tooSoon.data!.content).toMatch(/⏳ You can rate \*\*Maya\*\* again <t:\d+:R>/);
      expect(tooSoon.data!.components![0].components[1].label).toBe("1"); // her 👎 total didn't change

      const ban = await click(`ban:${sessionId}:demo-sam`, "1001");
      expect(ban.data!.content).toContain("1 report from 1 person in this lobby");
      expect(ban.data!.components![2].components[0].label).toBe("Sam 🚨 · 0");
      expect(ban.data!.components![2].components[2]).toMatchObject({ style: 4, label: "1" });
      expect((await click(`ban:${sessionId}:demo-sam`, "1001")).data!.content).toMatch(/⏳ You can report \*\*Sam\*\* again/);
      expect(ban.tasks).toHaveLength(0); // doesn't count yet: the lobby post stays as it is

      const form = await click(`fbopen:${sessionId}:demo-sam`, "1001");
      expect(form.type).toBe(9);
      expect(form.data as unknown).toMatchObject({ custom_id: `fb:${sessionId}:demo-sam`, title: "Feedback for Sam" });
      const sent = await handleInteraction(
        {
          ...base,
          type: 5,
          member: user("1001"),
          data: { custom_id: `fb:${sessionId}:demo-sam`, components: [{ components: [{ custom_id: "text", value: "Called every rotation" }] }] },
          message,
        },
        () => {},
      );
      expect(sent.type).toBe(7);
      expect(sent.data!.content).toContain("📝 Saved your note about **Sam**");
      expect(sent.data!.components![2].components[3].label).toBe("Feedback (1)");
      expect(await feedbackAbout(ctx.group.id, "demo-sam")).toContain("Called every rotation");
    } finally {
      await endSession(ctx, sessionId);
    }

    // Lots of people: pages of 4, opening on the page with whoever was just rated.
    const people = ["demo-maya", "demo-dev", "demo-rosa", "demo-kai", "demo-sam", "guest-1", "guest-2", "guest-3"];
    const blank = {
      sessionId: "s",
      open: true,
      people,
      lastVote: {},
      voteReadyAt: {},
      reportReadyAt: {},
      myReports: {},
      reports: {},
      reporters: {},
      offenses: {},
      myNotes: {},
      totals: {},
    };
    const firstPage = ratePanelMessage(ctx, blank, "demo-kai");
    expect(firstPage.components![3].components.map((b) => b.disabled)).toEqual([true, true, true]); // Kai's own row
    const paged = ratePanelMessage(ctx, blank, "demo-kai", { focus: "guest-2" });
    expect(paged.components).toHaveLength(5); // 4 people + Previous/Next
    expect(paged.components!.at(-1)!.components.map((b) => [b.label, b.disabled])).toEqual([
      ["◀ Previous", false],
      ["Next ▶ (2/2)", true],
    ]);
    assertDiscordLimits(paged);
  });
});

describe("the bot's own posts: the day's Valorant windows at 11 AM, and each lobby 5 minutes before", () => {
  const zone = "America/Los_Angeles";
  const posts: string[] = [];
  const made: string[] = [];
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    const db = await getDb();
    await db.update(groups).set({ discordChannelId: "chan" }).where(eq(groups.id, DEMO_GROUP_ID));
    process.env.DISCORD_BOT_TOKEN = "test-token";
    // Stand-in for Discord: keep what the bot posts in the channel.
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/channels/chan/messages") && init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)).content);
        return Response.json({ id: `m${posts.length}` });
      }
      return Response.json({});
    }) as typeof fetch;
    ctx = await fresh();
  });
  afterAll(async () => {
    globalThis.fetch = realFetch;
    delete process.env.DISCORD_BOT_TOKEN;
    const db = await getDb();
    await db.update(groups).set({ discordChannelId: null }).where(eq(groups.id, DEMO_GROUP_ID));
    for (const id of made) await db.update(playSessions).set({ status: "cancelled" }).where(eq(playSessions.id, id));
    ctx = await fresh();
  });

  it("knows which pings have work to do without asking the database", () => {
    const at = (iso: string) => DateTime.fromISO(iso, { zone }).toMillis();
    expect(tickDue(at("2031-03-04T11:00"))).toEqual({ daily: true, lobbies: false });
    expect(tickDue(at("2031-03-04T11:07"))).toEqual({ daily: false, lobbies: false });
    expect(tickDue(at("2031-03-04T18:25"))).toEqual({ daily: false, lobbies: true }); // for a 6:30 window
    expect(tickDue(at("2031-03-04T18:57"))).toEqual({ daily: false, lobbies: true }); // for a 7:00 window
    expect(tickDue(at("2031-03-04T18:40"))).toEqual({ daily: false, lobbies: false });
    expect(tickDue(at("2031-07-04T11:02"))).toMatchObject({ daily: true }); // daylight saving time too
  });

  it("posts the day's windows at 11 AM once, and locks in each window 5 minutes before it starts", async () => {
    expect(autoPostGames(ctx).map((g) => g.name)).toEqual(["Valorant"]);
    const taken = new Set((await upcomingPlanned(ctx.group.id)).map((p) => p.session.startAt.getTime()));
    const w = upcomingWindows(val()).find(
      (x) => x.startMs > Date.now() + 3_600_000 && !taken.has(x.startMs) && DateTime.fromMillis(x.startMs, { zone }).hour >= 12,
    )!;
    expect(w).toBeDefined();
    const eleven = DateTime.fromMillis(w.startMs, { zone }).set({ hour: 11, minute: 0, second: 0, millisecond: 0 }).toMillis();

    expect(await runAutoPosts(ctx, eleven - 60_000)).toEqual([]); // 10:59: not yet
    expect((await runAutoPosts(ctx, eleven))[0]).toMatch(/^posted \d+ Valorant windows?$/);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("🎮 **Valorant today**");
    expect(posts[0]).toContain(`<t:${w.startMs / 1000}:t>`);
    expect(posts[0]).toContain("I'll post the locked-in lobby 5 minutes before");
    expect(await runAutoPosts(ctx, eleven + 2 * 60_000)).toEqual([]); // once a day

    expect(await runAutoPosts(ctx, w.startMs - 10 * 60_000)).toEqual([]); // too early for the lobby
    expect(await runAutoPosts(ctx, w.startMs - 5 * 60_000)).toEqual([`locked in Valorant at ${new Date(w.startMs).toISOString()}`]);
    expect(posts).toHaveLength(2);
    expect(posts[1]).toContain("🔒 **Locked in: Valorant**");
    const planned = (await upcomingPlanned(ctx.group.id)).find((p) => p.session.startAt.getTime() === w.startMs)!;
    made.push(planned.session.id);
    expect(planned.session.createdBy).toBeNull(); // the bot locked it in
    expect(await runAutoPosts(ctx, w.startMs - 3 * 60_000)).toEqual([]); // once
    expect(posts.join("\n")).not.toMatch(/League of Legends|Aion/); // Valorant only
  });
});
