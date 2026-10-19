import { DateTime } from "luxon";
import {
  cellIndexForWallTime,
  gamingDayOf,
  nextOccurrence,
  parseClockTime,
  planAway,
  vacationOn,
  type AwayPlan,
} from "@/engine";
import { saveDateOverride } from "./availability";
import { sessionGame, toEngineInput, type GroupContext } from "./context";
import { lobbiesFor, setPlayerStatus, summarizeLive, upcomingPlanned, type LiveSummary } from "./sessions";

export interface AwayResult {
  /** When they said they'd be back (for "now", the start of this half hour). */
  backMs: number;
  /** "/back now": free from now, and in the lobby if one is open. */
  now: boolean;
  /** How their availability changed. Null for "now" between 4am and 8am (no gaming day) or on vacation. */
  plan: AwayPlan | null;
  /** Open lobbies they were added to (see lobbiesFor), each with its state before (for the "party's full" ping). */
  lobbies: Array<{ sessionId: string; before: LiveSummary["state"]; game: string }>;
  /** Start of a locked-in session they're in that begins before they're back. */
  clashMs: number | null;
  /** Last day of the vacation they're on, when "now" left their availability alone because of it. */
  vacationUntil: string | null;
}

const NOW = /^(now|rn|right ?now)$/i;

/** When "/back <time>" means, read in the member's own time zone. Throws a friendly message if it can't tell. */
export function resolveBackTime(input: string, nowMs: number, zone: string): { backMs: number; now: boolean } {
  const text = input.trim().slice(0, 40);
  if (NOW.test(text)) {
    const local = DateTime.fromMillis(nowMs, { zone });
    return { backMs: local.set({ minute: local.minute < 30 ? 0 : 30, second: 0, millisecond: 0 }).toMillis(), now: true };
  }
  const times = parseClockTime(text);
  if (!times) throw new Error(`I couldn't read “${text}” as a time. Try 930, 9pm, 21:30 or now.`);
  if (times.every((t) => cellIndexForWallTime(t.hour, t.minute) < 0)) {
    throw new Error("Pick a time between 8am and 4am (the app's day runs 8am → 4am).");
  }
  const backMs = nextOccurrence(times, nowMs, zone);
  if (backMs === null) throw new Error(`${text} already passed. If you're back now, use /back now.`);
  return { backMs, now: false };
}

/**
 * "/back 930": away until then, free from then. Saves it as a date override, which they can see and undo
 * under My availability → Specific days, so windows and pings use it right away. Lobbies they're in (or
 * the one open lobby for a game they play) list them as back at that time. "/back now" marks them free
 * from now and puts them in those lobbies.
 */
export async function setAwayUntil(
  ctx: GroupContext,
  userId: string,
  input: string,
  nowMs = Date.now(),
): Promise<AwayResult> {
  const me = ctx.byId.get(userId);
  if (!me) throw new Error("You're not in this group.");
  const { backMs, now } = resolveBackTime(input, nowMs, me.timezone);
  const member = toEngineInput(me);
  const today = gamingDayOf(nowMs, me.timezone);
  const vacation = now && today ? vacationOn(member, today) : null;
  // "now" between 4am and 8am (no gaming day) or on vacation leaves availability alone and only updates the lobby.
  const plan = now && (!today || vacation) ? null : planAway(member, nowMs, backMs);

  const [lobbies, planned] = await Promise.all([
    lobbiesFor(ctx, userId, nowMs),
    upcomingPlanned(ctx.group.id, nowMs),
    Promise.all((plan?.overrides ?? []).map((o) => saveDateOverride(userId, o.date, o.cells))),
  ]);

  const updated: AwayResult["lobbies"] = [];
  for (const live of lobbies) {
    const { game } = sessionGame(ctx, live.session);
    const before = summarizeLive(game.partySize, live.players).state;
    await setPlayerStatus(ctx, live.session.id, userId, now ? "in" : "soon", now ? null : new Date(backMs));
    updated.push({ sessionId: live.session.id, before, game: game.name });
  }
  const clash = now
    ? undefined
    : planned.find(
        (p) => p.session.startAt.getTime() < backMs && p.players.some((x) => x.userId === userId && x.status === "in"),
      );
  return {
    backMs,
    now,
    plan,
    lobbies: updated,
    clashMs: clash?.session.startAt.getTime() ?? null,
    vacationUntil: vacation?.end ?? null,
  };
}
