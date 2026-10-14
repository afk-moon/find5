import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// Throwaway embedded database (seeded with the demo group on first use).
process.env.PGLITE_DIR = mkdtempSync(path.join(tmpdir(), "fivestack-flows-"));

const { loadGroupContext } = await import("./context");
const { upcomingWindows } = await import("./windows");
const { lockInWindow, upcomingPlanned, startLive, setPlayerStatus, goToDinner, getSession, summarizeLive, endSession, activeLive } =
  await import("./sessions");
const { getWfhState, toggleBallotDay, closeVote, reopenVote, weekStartOf } = await import("./wfh");
const { saveProfile, saveDateOverride, createMember } = await import("./availability");
const { lobbyMessage, wfhVoteMessage, plannedSessionMessage, windowsMessage } = await import("@/discord/messages");
const { DEMO_GROUP_ID } = await import("@/db/seed");
const { pattern } = await import("@/engine");

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
