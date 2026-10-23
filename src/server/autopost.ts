import { getDb } from "@/db";
import { autoPosts } from "@/db/schema";
import { currentGamingDay, gamingDayBounds, type PlayWindow } from "@/engine";
import { forGame, type GameContext, type GameView, type GroupContext } from "./context";
import { announceLockIn } from "./notify";
import { lockInWindow } from "./sessions";
import { upcomingWindows } from "./windows";

/*
 * The bot's own sessions, so nobody has to lock anything in on the website. Once a day (Vercel's daily job, see
 * /api/cron/daily) it locks in each of the day's windows for the auto-post games (Valorant) and posts the
 * locked-in lobby, which pings the party. Each one also gets a Discord server event that starts HEADS_UP_MINUTES
 * before the window: Discord starts it by itself and notifies everyone who tapped Interested, so the heads-up
 * needs nothing of ours running at that time.
 */

/** How long before a window its server event starts (Discord's "starting now" notification is the heads-up). */
export const HEADS_UP_MINUTES = 5;

/** Games the bot locks in by itself: AUTO_POST_GAMES (comma-separated names, any case), else Valorant. */
export function autoPostGames(ctx: GroupContext): GameView[] {
  const names = (process.env.AUTO_POST_GAMES ?? "Valorant")
    .split(",")
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean);
  return ctx.games.filter((g) => names.includes(g.name.trim().toLowerCase()));
}

/** Claim a once-only job: true the first time. The insert is atomic, so two runs can't both win. */
async function claim(groupId: string, key: string): Promise<boolean> {
  const db = await getDb();
  const won = await db.insert(autoPosts).values({ groupId, key }).onConflictDoNothing().returning({ key: autoPosts.key });
  return won.length > 0;
}

/** A game's windows that start later today (the group's gaming day, which runs until 4 AM). */
export function todaysWindows(ctx: GameContext, nowMs: number): PlayWindow[] {
  const zone = ctx.group.homeTimezone;
  const { endMs } = gamingDayBounds(currentGamingDay(nowMs, zone), zone);
  return upcomingWindows(ctx, nowMs).filter((w) => w.startMs > nowMs && w.startMs < endMs);
}

/**
 * The daily job's part: lock in each of today's windows for the auto-post games and post their lobbies, once a
 * day. A window someone already locked in on the website is left alone. Returns what it did.
 */
export async function postTodaysSessions(ctx: GroupContext, nowMs = Date.now()): Promise<string[]> {
  const done: string[] = [];
  if (!ctx.group.discordChannelId) return done;
  const day = currentGamingDay(nowMs, ctx.group.homeTimezone);
  for (const g of autoPostGames(ctx)) {
    if (g.players.length < g.partySize || !(await claim(ctx.group.id, `day:${g.id}:${day}`))) continue;
    const game = forGame(ctx, g);
    for (const w of todaysWindows(game, nowMs)) {
      const at = new Date(w.startMs).toISOString();
      try {
        const { session, window, created } = await lockInWindow(game, null, w.startMs, w.endMs);
        if (created) await announceLockIn(game, session, window, { headsUpMinutes: HEADS_UP_MINUTES });
        done.push(created ? `locked in ${g.name} at ${at}` : `${g.name} at ${at} was already locked in`);
      } catch (err) {
        console.error(`[autopost] couldn't lock in ${g.name} at ${at}:`, err);
        done.push(`couldn't lock in ${g.name} at ${at}`);
      }
    }
  }
  return done;
}
