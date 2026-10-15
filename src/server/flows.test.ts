import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// Throwaway embedded database (seeded with the demo group on first use).
process.env.PGLITE_DIR = mkdtempSync(path.join(tmpdir(), "receptionist-flows-"));

const { loadGroupContext, toEngineInput } = await import("./context");
const { upcomingWindows } = await import("./windows");
const { lockInWindow, upcomingPlanned, startLive, setPlayerStatus, goToDinner, getSession, summarizeLive, endSession, activeLive } =
  await import("./sessions");
const { getWfhState, toggleBallotDay, closeVote, reopenVote, weekStartOf } = await import("./wfh");
const { saveProfile, saveDateOverride, createMember, saveWfhWeek } = await import("./availability");
const { openLateVotes, toggleLateReport, getLateTally } = await import("./lateness");
const { lobbyMessage, wfhVoteMessage, plannedSessionMessage, windowsMessage, storedPlannedMessage, mention } =
  await import("@/discord/messages");
const { handleInteraction } = await import("@/discord/handlers");
const { getDb } = await import("@/db");
const { memberProfiles } = await import("@/db/schema");
const { DEMO_GROUP_ID } = await import("@/db/seed");
const { pattern, lateVotingState, resolvePattern } = await import("@/engine");
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
