"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { groups } from "@/db/schema";
import { currentGamingDay, type Weekday } from "@/engine";
import { actionError, type ActionResult } from "@/lib/action-result";
import { WEEKDAY_LONG, isValidZone } from "@/lib/format";
import { DEV_USER_COOKIE, devLoginEnabled } from "@/server/auth";
import {
  addVacation,
  createMember,
  removeVacation,
  saveDateOverride,
  saveProfile,
  saveWeekPatterns,
  saveWfhWeek,
  setWfhDate,
  type ProfileInput,
} from "@/server/availability";
import { forGame, loadGroupContext, requireViewer, type GroupContext } from "@/server/context";
import { addGame, removeGame, setMemberGames, updateGame } from "@/server/games";
import { toggleLateReport } from "@/server/lateness";
import {
  announceLockIn,
  announceWfhDecision,
  syncLobby,
  syncPlannedMessage,
  syncSessionPost,
  syncWfhVote,
} from "@/server/notify";
import { toggleDropOut, toggleKickVote } from "@/server/party";
import { SESSION_COOKIE } from "@/server/session-cookie";
import {
  cancelSession,
  endSession,
  fullStacks,
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

export async function saveWfhWeekAction(days: Record<string, string>): Promise<ActionResult> {
  const { userId } = await requireViewer();
  try {
    await saveWfhWeek(userId, days);
    refreshAll();
    return { ok: true, message: "WFH days saved" };
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

export async function addVacationAction(startDate: string, endDate: string): Promise<ActionResult> {
  const { userId, me } = await requireViewer();
  try {
    await addVacation(userId, startDate, endDate, currentGamingDay(Date.now(), me.timezone));
    refreshAll();
    return { ok: true, message: "Vacation saved 🏖️" };
  } catch (e) {
    return actionError(e);
  }
}

export async function removeVacationAction(id: string): Promise<ActionResult> {
  const { userId } = await requireViewer();
  try {
    await removeVacation(userId, id);
    refreshAll();
    return { ok: true, message: "Vacation removed" };
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

/** The group narrowed to one of its games (ids come from the client, so check them). */
function gameCtx(ctx: GroupContext, gameId: string) {
  const game = ctx.gameById.get(gameId);
  if (!game) throw new Error("That game isn't in this group anymore.");
  return forGame(ctx, game);
}

export async function lockInAction(gameId: string, startMs: number, endMs: number): Promise<ActionResult> {
  const { ctx, userId } = await requireViewer();
  try {
    const game = gameCtx(ctx, gameId);
    const { session, window, created } = await lockInWindow(game, userId, startMs, endMs);
    if (created) await announceLockIn(game, session, window);
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

/** Report a teammate as late for a started session (tap again to take it back). */
export async function toggleLateReportAction(sessionId: string, lateUserId: string): Promise<ActionResult> {
  const { ctx, userId } = await requireViewer();
  try {
    await toggleLateReport(ctx, sessionId, userId, lateUserId);
    await syncPlannedMessage(ctx, sessionId);
    refreshAll();
    return { ok: true };
  } catch (e) {
    return actionError(e);
  }
}

/** "Can't make it" on a locked-in session (tap again to rejoin). */
export async function toggleDropOutAction(sessionId: string): Promise<ActionResult> {
  const { ctx, userId } = await requireViewer();
  try {
    const { dropped } = await toggleDropOut(ctx, sessionId, userId);
    await syncPlannedMessage(ctx, sessionId);
    refreshAll();
    return { ok: true, message: dropped ? "You're out of this one" : "You're back in 🎮" };
  } catch (e) {
    return actionError(e);
  }
}

/** Vote to remove someone from the lobby or a locked-in session's party (tap again to take it back). */
export async function toggleKickVoteAction(sessionId: string, targetId: string): Promise<ActionResult> {
  const { ctx, userId } = await requireViewer();
  try {
    const { voted, removed, session } = await toggleKickVote(ctx, sessionId, userId, targetId);
    await syncSessionPost(ctx, session);
    refreshAll();
    const name = ctx.byId.get(targetId)?.name ?? "They";
    return { ok: true, message: removed ? `${name} was voted out` : voted ? "Vote counted" : "Vote taken back" };
  } catch (e) {
    return actionError(e);
  }
}

// ─── Live lobby ────────────────────────────────────────────────────────────────────────────

export async function startLfgAction(): Promise<ActionResult> {
  const { ctx, userId } = await requireViewer();
  try {
    const { sessionId, created, closed } = await startLive(ctx, userId);
    await Promise.all([syncLobby(ctx, sessionId), ...closed.map((id) => syncLobby(ctx, id))]);
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
    // Full 5-stacks before this tap: people who asked for it get a DM when one fills.
    const before = fullStacks(summarizeLive(ctx.games, s.players));
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
    await syncLobby(ctx, sessionId, { before, actorId: userId });
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
  // A field that isn't in the form keeps its saved value.
  const int = (name: string, min: number, max: number, fallback: number) => {
    const raw = formData.get(name);
    const n = raw === null || raw === "" ? NaN : Math.round(Number(raw));
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
      minSessionMinutes: int("minSessionMinutes", 30, 360, g.minSessionMinutes),
      maxPauseMinutes: int("maxPauseMinutes", 0, 120, g.maxPauseMinutes),
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

// ─── Games ─────────────────────────────────────────────────────────────────────────────────

/** Pick the games you play (replaces your picks). */
export async function setMyGamesAction(gameIds: string[]): Promise<ActionResult> {
  const { ctx, userId } = await requireViewer();
  try {
    const picked = await setMemberGames(ctx, userId, gameIds);
    refreshAll();
    return { ok: true, message: picked.length ? "Games saved" : "No games picked: you won't show up in any windows" };
  } catch (e) {
    return actionError(e);
  }
}

/** Add a game to the group. You're signed up for it. */
export async function addGameAction(name: string, partySize: number): Promise<ActionResult> {
  const { ctx, userId } = await requireViewer();
  try {
    const game = await addGame(ctx, userId, { name, partySize });
    refreshAll();
    return { ok: true, message: `Added ${game.name}` };
  } catch (e) {
    return actionError(e);
  }
}

export async function updateGameAction(
  gameId: string,
  input: { name: string; partySize: number; matchMinutes: number },
): Promise<ActionResult> {
  const { ctx } = await requireViewer();
  try {
    await updateGame(ctx, gameId, input);
    refreshAll();
    return { ok: true, message: "Saved" };
  } catch (e) {
    return actionError(e);
  }
}

export async function removeGameAction(gameId: string): Promise<ActionResult> {
  const { ctx } = await requireViewer();
  try {
    await removeGame(ctx, gameId);
    refreshAll();
    return { ok: true, message: "Removed" };
  } catch (e) {
    return actionError(e);
  }
}
