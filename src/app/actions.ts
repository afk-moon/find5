"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { groups } from "@/db/schema";
import type { Weekday } from "@/engine";
import { actionError, type ActionResult } from "@/lib/action-result";
import { WEEKDAY_LONG, isValidZone } from "@/lib/format";
import { DEV_USER_COOKIE, devLoginEnabled } from "@/server/auth";
import {
  createMember,
  saveDateOverride,
  saveProfile,
  saveWeekPatterns,
  saveWfhPattern,
  setWfhDate,
  type ProfileInput,
} from "@/server/availability";
import { loadGroupContext, requireViewer } from "@/server/context";
import { announceLockIn, announceWfhDecision, syncLobby, syncWfhVote } from "@/server/notify";
import { SESSION_COOKIE } from "@/server/session-cookie";
import {
  cancelSession,
  endSession,
  getSession,
  goToDinner,
  lockInWindow,
  setPlayerStatus,
  startLive,
  summarizeLive,
} from "@/server/sessions";
import { clearBallot, closeVote, ensureVote, reopenVote, toggleBallotDay } from "@/server/wfh";

const devCookie = { path: "/", httpOnly: true, sameSite: "lax" as const, maxAge: 60 * 60 * 24 * 30 };
const refreshAll = () => revalidatePath("/", "layout");

// ─── Sign-in ───────────────────────────────────────────────────────────────────────────────

export async function loginAsAction(userId: string) {
  if (!devLoginEnabled()) throw new Error("Demo login is disabled.");
  (await cookies()).set(DEV_USER_COOKIE, userId, devCookie);
  redirect("/");
}

export async function joinAsNewMemberAction(formData: FormData) {
  if (!devLoginEnabled()) throw new Error("Demo login is disabled.");
  const name = String(formData.get("name") ?? "").trim();
  const timezone = String(formData.get("timezone") ?? "");
  if (!name) redirect("/login?error=name");
  const id = await createMember({ name, timezone: isValidZone(timezone) ? timezone : "America/Chicago" });
  (await cookies()).set(DEV_USER_COOKIE, id, devCookie);
  redirect("/availability");
}

export async function logoutAction() {
  const jar = await cookies();
  jar.delete(DEV_USER_COOKIE);
  jar.delete(SESSION_COOKIE);
  redirect("/login");
}

// ─── Availability & profile ────────────────────────────────────────────────────────────────

export async function saveWeekAction(weekly: Record<string, string>): Promise<ActionResult> {
  const { userId } = await requireViewer();
  try {
    await saveWeekPatterns(userId, weekly);
    refreshAll();
    return { ok: true, message: "Typical week saved" };
  } catch (e) {
    return actionError(e);
  }
}

export async function saveWfhPatternAction(cells: string): Promise<ActionResult> {
  const { userId } = await requireViewer();
  try {
    await saveWfhPattern(userId, cells);
    refreshAll();
    return { ok: true, message: "WFH day saved" };
  } catch (e) {
    return actionError(e);
  }
}

export async function saveOverrideAction(date: string, cells: string | null): Promise<ActionResult> {
  const { userId } = await requireViewer();
  try {
    await saveDateOverride(userId, date, cells);
    refreshAll();
    return { ok: true, message: cells === null ? "Back to your normal day" : "Saved for that day" };
  } catch (e) {
    return actionError(e);
  }
}

export async function toggleWfhDateAction(date: string, on: boolean): Promise<ActionResult> {
  const { userId, me } = await requireViewer();
  try {
    if (me.workStyle !== "hybrid") throw new Error("Switch your work style to hybrid first.");
    await setWfhDate(userId, date, on);
    refreshAll();
    return { ok: true, message: on ? "Marked as a WFH day" : "Back to an office day" };
  } catch (e) {
    return actionError(e);
  }
}

export async function saveProfileAction(input: ProfileInput): Promise<ActionResult> {
  const { userId } = await requireViewer();
  try {
    await saveProfile(userId, input);
    refreshAll();
    return { ok: true, message: "Profile saved" };
  } catch (e) {
    return actionError(e);
  }
}

// ─── Planned sessions ──────────────────────────────────────────────────────────────────────

export async function lockInAction(startMs: number, endMs: number): Promise<ActionResult> {
  const { ctx, userId } = await requireViewer();
  try {
    const { session, window, created } = await lockInWindow(ctx, userId, startMs, endMs);
    if (created) await announceLockIn(ctx, session, window);
    refreshAll();
    return { ok: true, message: created ? "Locked in 🔒" : "Already locked in" };
  } catch (e) {
    return actionError(e);
  }
}

export async function cancelSessionAction(sessionId: string): Promise<ActionResult> {
  const { ctx } = await requireViewer();
  try {
    await cancelSession(ctx.group.id, sessionId);
    refreshAll();
    return { ok: true, message: "Cancelled" };
  } catch (e) {
    return actionError(e);
  }
}

// ─── Live lobby ────────────────────────────────────────────────────────────────────────────

export async function startLfgAction(): Promise<ActionResult> {
  const { ctx, userId } = await requireViewer();
  try {
    const { sessionId, created } = await startLive(ctx, userId);
    await syncLobby(ctx, sessionId);
    refreshAll();
    return { ok: true, message: created ? "Lobby open" : "Joined the lobby" };
  } catch (e) {
    return actionError(e);
  }
}

export type LiveAction = "in" | "soon" | "declined" | "left" | "quick" | "long" | "back" | "end";

export async function liveAction(sessionId: string, action: LiveAction): Promise<ActionResult> {
  const { ctx, userId } = await requireViewer();
  try {
    const s = await getSession(ctx.group.id, sessionId);
    if (!s || s.session.status !== "active") throw new Error("That lobby is closed.");
    const before = summarizeLive(ctx.group.partySize, s.players).state;
    switch (action) {
      case "in":
      case "back":
        await setPlayerStatus(ctx, sessionId, userId, "in");
        break;
      case "soon":
        await setPlayerStatus(ctx, sessionId, userId, "soon", new Date(Date.now() + 15 * 60_000));
        break;
      case "declined":
      case "left":
        await setPlayerStatus(ctx, sessionId, userId, action);
        break;
      case "quick":
      case "long":
        await goToDinner(ctx, sessionId, userId, action);
        break;
      case "end":
        await endSession(ctx, sessionId);
        break;
    }
    await syncLobby(ctx, sessionId, before);
    refreshAll();
    return { ok: true };
  } catch (e) {
    return actionError(e);
  }
}

// ─── WFH vote ──────────────────────────────────────────────────────────────────────────────

export async function toggleBallotAction(weekStart: string, day: number): Promise<ActionResult> {
  const { ctx, userId } = await requireViewer();
  try {
    await toggleBallotDay(ctx, weekStart, userId, day as Weekday);
    await syncWfhVote(ctx, weekStart);
    refreshAll();
    return { ok: true };
  } catch (e) {
    return actionError(e);
  }
}

export async function clearBallotAction(weekStart: string): Promise<ActionResult> {
  const { ctx, userId } = await requireViewer();
  try {
    await clearBallot(ctx, weekStart, userId);
    await syncWfhVote(ctx, weekStart);
    refreshAll();
    return { ok: true, message: "Got it, no WFH days for you this week" };
  } catch (e) {
    return actionError(e);
  }
}

export async function closeVoteAction(weekStart: string): Promise<ActionResult> {
  const { ctx } = await requireViewer();
  try {
    const result = await closeVote(ctx, weekStart);
    const fresh = await loadGroupContext(ctx.group.id);
    await announceWfhDecision(fresh, weekStart, result);
    await syncWfhVote(fresh, weekStart);
    refreshAll();
    return {
      ok: true,
      message: result.recommended.length
        ? `Decided: ${result.recommended.map((d) => WEEKDAY_LONG[d]).join(" & ")}`
        : "No shared WFH day this week",
    };
  } catch (e) {
    return actionError(e);
  }
}

export async function reopenVoteAction(weekStart: string): Promise<ActionResult> {
  const { ctx } = await requireViewer();
  try {
    await reopenVote(ctx, weekStart);
    await syncWfhVote(await loadGroupContext(ctx.group.id), weekStart);
    refreshAll();
    return { ok: true, message: "Vote reopened" };
  } catch (e) {
    return actionError(e);
  }
}

export async function postVoteToDiscordAction(weekStart: string): Promise<ActionResult> {
  const { ctx } = await requireViewer();
  try {
    if (!ctx.group.discordChannelId) throw new Error("Set a Discord channel in Settings first.");
    await ensureVote(ctx.group.id, weekStart);
    await syncWfhVote(ctx, weekStart, true);
    return { ok: true, message: "Posted to Discord" };
  } catch (e) {
    return actionError(e);
  }
}

// ─── Group settings ────────────────────────────────────────────────────────────────────────

export async function saveSettingsAction(formData: FormData) {
  const { ctx } = await requireViewer();
  const int = (name: string, min: number, max: number, fallback: number) => {
    const n = Math.round(Number(formData.get(name)));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  const snowflake = (name: string) => {
    const v = String(formData.get(name) ?? "").trim();
    return /^\d{5,25}$/.test(v) ? v : null;
  };
  const g = ctx.group;
  const homeTimezone = String(formData.get("homeTimezone") ?? g.homeTimezone);
  const db = await getDb();
  await db
    .update(groups)
    .set({
      name: String(formData.get("name") ?? g.name).trim().slice(0, 60) || g.name,
      homeTimezone: isValidZone(homeTimezone) ? homeTimezone : g.homeTimezone,
      partySize: int("partySize", 2, 10, g.partySize),
      minSessionMinutes: int("minSessionMinutes", 30, 360, g.minSessionMinutes),
      maxPauseMinutes: int("maxPauseMinutes", 0, 120, g.maxPauseMinutes),
      matchLengthMinutes: int("matchLengthMinutes", 15, 90, g.matchLengthMinutes),
      wfhSharedDays: int("wfhSharedDays", 1, 3, g.wfhSharedDays),
      wfhVoteOpenWeekday: int("wfhVoteOpenWeekday", 1, 7, g.wfhVoteOpenWeekday),
      wfhVoteCloseWeekday: int("wfhVoteCloseWeekday", 1, 7, g.wfhVoteCloseWeekday),
      discordGuildId: snowflake("discordGuildId"),
      discordChannelId: snowflake("discordChannelId"),
      discordVoiceChannelId: snowflake("discordVoiceChannelId"),
    })
    .where(eq(groups.id, g.id));
  refreshAll();
  redirect("/settings?saved=1");
}
