import { DateTime } from "luxon";
import { cellIndexForWallTime, gamingDayOf, nextOccurrence, parseClockTime, planAway, type AwayPlan } from "@/engine";
import { saveDateOverride } from "./availability";
import { toEngineInput, type GroupContext } from "./context";
import { activeLive, setPlayerStatus, summarizeLive, upcomingPlanned, type LiveSummary } from "./sessions";

export interface AwayResult extends AwayPlan {
  /** When they said they'd be back (for "now", the start of this half hour). */
  backMs: number;
  /** "/back now": free from now, and in the lobby if one is open. */
  now: boolean;
  /** The open lobby they were added to, and its state before (for the "party's full" ping). */
  lobby: { sessionId: string; before: LiveSummary["state"] } | null;
  /** Start of a locked-in session they're in that begins before they're back. */
  clashMs: number | null;
}

const NOW = /^(now|rn|right ?now)$/i;

/** When "/back <time>" means, read in the member's own time zone. Throws a friendly message if it can't tell. */
export function resolveBackTime(input: string, nowMs: number, zone: string): { backMs: number; now: boolean } {
  const text = input.trim().slice(0, 40);
  if (NOW.test(text)) {
    if (!gamingDayOf(nowMs, zone)) throw new Error("It's between 4am and 8am, outside the app's day (8am → 4am).");
    const local = DateTime.fromMillis(nowMs, { zone });
    return { backMs: local.set({ minute: local.minute < 30 ? 0 : 30, second: 0, millisecond: 0 }).toMillis(), now: true };
  }
  const times = parseClockTime(text);
  if (!times) throw new Error(`I couldn't read “${text}” as a time. Try 9pm, 9:30pm, 21:30 or now.`);
  if (times.every((t) => cellIndexForWallTime(t.hour, t.minute) < 0)) {
    throw new Error("Pick a time between 8am and 4am (the app's day runs 8am → 4am).");
  }
  const backMs = nextOccurrence(times, nowMs, zone);
  if (backMs === null) throw new Error(`${text} already passed. If you're back now, use /back time:now.`);
  return { backMs, now: false };
}

/**
 * "/back 9pm": away until then, free from then. Saves it as a date override, which they can see and undo
 * under My availability → Specific days, so windows and pings use it right away. If a lobby is open, it
 * lists them as back at that time. "/back now" marks them free from now and puts them in the lobby.
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
  const plan = planAway(toEngineInput(me), nowMs, backMs);

  const [live, planned] = await Promise.all([
    activeLive(ctx.group.id, nowMs),
    upcomingPlanned(ctx.group.id, nowMs),
    Promise.all(plan.overrides.map((o) => saveDateOverride(userId, o.date, o.cells))),
  ]);

  let lobby: AwayResult["lobby"] = null;
  if (live) {
    const before = summarizeLive(ctx.group.partySize, live.players).state;
    await setPlayerStatus(ctx, live.session.id, userId, now ? "in" : "soon", now ? null : new Date(backMs));
    lobby = { sessionId: live.session.id, before };
  }
  const clash = now
    ? undefined
    : planned.find(
        (p) => p.session.startAt.getTime() < backMs && p.players.some((x) => x.userId === userId && x.status === "in"),
      );
  return { ...plan, backMs, now, lobby, clashMs: clash?.session.startAt.getTime() ?? null };
}
