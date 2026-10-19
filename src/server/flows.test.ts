import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

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
  readyGames,
  gamesInLobby,
  progressText,
} = await import("./sessions");
const { getWfhState, toggleBallotDay, closeVote, reopenVote, weekStartOf } = await import("./wfh");
const { saveProfile, saveDateOverride, createMember, saveWfhWeek, addVacation, removeVacation } = await import("./availability");
const { openLateVotes, toggleLateReport, getLateTally } = await import("./lateness");
const { setAwayUntil, resolveBackTime } = await import("./away");
const { gameReadyMessage } = await import("@/discord/messages");
const { freeNowNotInLobby } = await import("./notify");
const {
  lobbyMessage,
  lobbyMovedMessage,
  wfhVoteMessage,
  plannedSessionMessage,
  windowsMessage,
  storedPlannedMessage,
  mention,
  awayMessage,
} = await import("@/discord/messages");
const { handleInteraction, handleAutocomplete } = await import("@/discord/handlers");
const { getDb } = await import("@/db");
const { memberProfiles, playSessions, playSessionPlayers } = await import("@/db/schema");
const { DEMO_GROUP_ID } = await import("@/db/seed");
const { pattern, lateVotingState, resolvePattern, currentGamingDay, EMPTY_PATTERN } = await import("@/engine");
const { eq } = await import("drizzle-orm");
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
      expect(away.lobby).toEqual({ sessionId: lobby.id, before: [] });
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

  it("an older post of a re-posted lobby points to the new one", () => {
    const moved = lobbyMovedMessage("chan:new-msg", "guild");
    expect(moved.content).toBe("↪️ This lobby moved to a newer post: https://discord.com/channels/guild/chan/new-msg");
    expect(moved.components).toEqual([]);
    expect(lobbyMovedMessage("chan:new-msg").content).toBe("↪️ This lobby moved to a newer post below.");
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
      expect(readyGames(two)).toEqual([byName("TFT").id]);
      expect(gamesInLobby(two).map(progressText)).toEqual(["✅ TFT 2/2", "Valorant 2/5", "Aion 2 1/4", "League of Legends 1/5"]);
      const msg = lobbyMessage(ctx, s.session, two, []);
      expect(msg.content).toContain("✅ **Ready to play:** TFT. Queue up!");
      expect(msg.content).toContain("🎯 ✅ TFT 2/2 · Valorant 2/5 · Aion 2 1/4 · League of Legends 1/5");
      assertDiscordLimits(msg);

      // Everyone joins: Valorant and Aion 2 fill up, and only they get a "ready" ping (TFT already had one).
      for (const id of ["demo-dev", "demo-kai", "demo-sam"]) await setPlayerStatus(ctx, sessionId, id, "in");
      s = (await getSession(ctx.group.id, sessionId))!;
      const all = summarizeLive(ctx.games, s.players);
      const newly = readyGames(all).filter((id) => !readyGames(two).includes(id));
      expect(newly).toEqual([byName("Valorant").id, byName("Aion 2").id]);
      const ping = gameReadyMessage(ctx, all, newly).content;
      expect(ping).toContain("✅ **Valorant** is ready (5-stack): ");
      expect(ping).toContain("✅ **Aion 2** is ready (4-stack): ");
      expect(ping).not.toContain("TFT");

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

  it("/lfg opens that one lobby, whatever the game", async () => {
    const opened = await handleInteraction({ ...base, type: 2, data: { name: "lfg" } }, () => {});
    try {
      expect(opened.type).toBe(4);
      expect(opened.data!.flags).toBeUndefined(); // a public post
      // Kai alone: Aion 2 (a 4-stack) is the closest to a full party.
      expect(opened.data!.content).toMatch(/^🎮 \*\*Who's on\?\*\* 1 in, Aion 2 needs 3 more\n/);
      expect(opened.data!.content).toContain("🎯 Aion 2 1/4 · Valorant 1/5 · League of Legends 1/5");
      assertDiscordLimits(opened.data!);
      // A game sent by an older copy of the command doesn't matter: it's still the same lobby.
      const again = await handleInteraction({ ...base, type: 2, data: { name: "lfg", options: [{ name: "game", value: "tft" }] } }, () => {});
      expect(again.data!.content).toContain("1 in");
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
