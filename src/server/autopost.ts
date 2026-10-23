import { DateTime } from "luxon";
import { getDb } from "@/db";
import { autoPosts } from "@/db/schema";
import { currentGamingDay, gamingDayBounds, type PlayWindow } from "@/engine";
import { forGame, type GameContext, type GameView, type GroupContext } from "./context";
import { announceLockIn, postDailyWindows } from "./notify";
import { lockInWindow } from "./sessions";
import { upcomingWindows } from "./windows";

/*
 * The bot's own posts, so nobody has to lock anything in on the website:
 * - at 11 AM (Pacific) it posts the day's windows for the auto-post games (Valorant), if there are any;
 * - 5 minutes before a window starts, it locks it in and posts the locked-in lobby, which pings the party.
 * Both run from /api/cron/tick, which something pings every 5 minutes. Most pings have nothing to do and return
 * without touching the database (see tickDue), so the database can still sleep between them.
 */

/** When the day's windows are posted: 11 AM in the auto-post time zone. */
export const DAILY_POST_HOUR = 11;
/** How long before a window starts its lobby is posted. */
export const LOBBY_LEAD_MINUTES = 5;
/** If the 11 AM ping was missed, a later one can still post the day's windows until 2 PM… */
const DAILY_POST_UNTIL_HOUR = 14;
/** …and a lobby can still be posted up to 30 minutes after its window started. */
const LOBBY_GRACE_MS = 30 * 60_000;

/** The time zone for "11 AM": AUTO_POST_TIME_ZONE, Pacific by default. */
export const autoPostZone = () => process.env.AUTO_POST_TIME_ZONE?.trim() || "America/Los_Angeles";

/** Games whose windows the bot posts by itself: AUTO_POST_GAMES (comma-separated names, any case), else Valorant. */
export function autoPostGames(ctx: GroupContext): GameView[] {
  const names = (process.env.AUTO_POST_GAMES ?? "Valorant")
    .split(",")
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean);
  return ctx.games.filter((g) => names.includes(g.name.trim().toLowerCase()));
}

/**
 * What a ping at `nowMs` might have to do, worked out without the database: the day's windows from 11:00 to
 * 11:04, and lobbies in the 5 minutes before each hour and half hour (windows start on the hour or half hour).
 */
export function tickDue(nowMs: number) {
  const local = DateTime.fromMillis(nowMs, { zone: autoPostZone() });
  const minute = new Date(nowMs).getUTCMinutes();
  return {
    daily: local.hour === DAILY_POST_HOUR && local.minute < 5,
    lobbies: (minute + LOBBY_LEAD_MINUTES) % 30 < 5,
  };
}

/** Claim a once-only post: true for the first ping that asks. The insert is atomic, so two pings can't both win. */
async function claim(groupId: string, key: string): Promise<boolean> {
  const db = await getDb();
  const won = await db.insert(autoPosts).values({ groupId, key }).onConflictDoNothing().returning({ key: autoPosts.key });
  return won.length > 0;
}

/** A game's windows that start later today (the gaming day in the auto-post time zone, which runs until 4 AM). */
export function todaysWindows(ctx: GameContext, nowMs: number): PlayWindow[] {
  const zone = autoPostZone();
  const { endMs } = gamingDayBounds(currentGamingDay(nowMs, zone), zone);
  return upcomingWindows(ctx, nowMs).filter((w) => w.startMs > nowMs && w.startMs < endMs);
}

/** One ping's work for a group: the day's windows, then any lobby that's due. Returns what it did. */
export async function runAutoPosts(ctx: GroupContext, nowMs = Date.now(), due = tickDue(nowMs)): Promise<string[]> {
  const done: string[] = [];
  if (!ctx.group.discordChannelId || (!due.daily && !due.lobbies)) return done;
  const local = DateTime.fromMillis(nowMs, { zone: autoPostZone() });
  const morning = local.hour >= DAILY_POST_HOUR && local.hour < DAILY_POST_UNTIL_HOUR;
  for (const g of autoPostGames(ctx)) {
    if (g.players.length < g.partySize) continue;
    const game = forGame(ctx, g);
    // The day's windows, once a day (and only if there are any) at 11 AM, or on a later ping that morning.
    if (morning && (await claim(ctx.group.id, `windows:${g.id}:${local.toISODate()}`))) {
      const today = todaysWindows(game, nowMs);
      if (today.length) {
        await postDailyWindows(game, today, LOBBY_LEAD_MINUTES);
        done.push(`posted ${today.length} ${g.name} window${today.length === 1 ? "" : "s"}`);
      }
    }
    if (!due.lobbies) continue;
    // Each window's lobby, LOBBY_LEAD_MINUTES before it starts (or a bit late if that ping was missed).
    for (const w of upcomingWindows(game, nowMs)) {
      const lead = w.startMs - nowMs;
      if (lead > (LOBBY_LEAD_MINUTES + 5) * 60_000 || lead < -LOBBY_GRACE_MS) continue;
      if (!(await claim(ctx.group.id, `lobby:${g.id}:${w.startMs}`))) continue;
      const at = new Date(w.startMs).toISOString();
      const { session, window, created } = await lockInWindow(game, null, w.startMs, w.endMs);
      // Someone may have locked it in on the website already; then its post is out there.
      if (created) await announceLockIn(game, session, window, { event: false });
      done.push(created ? `locked in ${g.name} at ${at}` : `${g.name} at ${at} was already locked in`);
    }
  }
  return done;
}
