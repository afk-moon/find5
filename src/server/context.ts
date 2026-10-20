import { asc, eq, inArray } from "drizzle-orm";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getDb } from "@/db";
import {
  dayPatterns,
  games,
  groups,
  hybridDays,
  memberGames,
  memberProfiles,
  memberships,
  user,
  vacations,
  wfhDays,
} from "@/db/schema";
import { NO_LATE_STATS, lateStats, type LateStats } from "@/engine/lateness";
import type { HybridMode, MatchSettings, MemberInput, Weekday } from "@/engine/types";
import { getSessionUserId } from "./auth";
import { loadLateRecords, type LateRecord } from "./lateness";

/** "Now" for the current request (server components render per request). */
export function requestTime(): number {
  return Date.now();
}

export type Group = typeof groups.$inferSelect;

export interface MemberView {
  id: string;
  name: string;
  image: string | null;
  color: string;
  timezone: string;
  workStyle: "fixed" | "hybrid";
  role: "owner" | "member";
  discordId: string | null;
  /** Wants a Discord DM when a lobby they are in gets a full 5-stack. */
  dmWhenFull: boolean;
  nightBeforeWfhUntil: string | null;
  hybridDays: Partial<Record<Weekday, HybridMode>>;
  /** Raw stored patterns by key ("w1"…"w7", "wfh", "d:YYYY-MM-DD"). */
  patterns: Record<string, string>;
  wfhDates: string[];
  /** Time away, earliest first ("YYYY-MM-DD" local days, inclusive). */
  vacations: Array<{ id: string; start: string; end: string }>;
  /** Ids of the games they play. */
  games: string[];
  /** Late history over their recent locked-in sessions (drives the "frequently late" tag). */
  lateness: LateStats;
}

export interface GameView {
  id: string;
  name: string;
  /** Players needed to play together. */
  partySize: number;
  /** About how long one match takes. */
  matchMinutes: number;
  /** Members who play it, in member order. */
  players: string[];
  /** When it was added (ms): lists people edit use this order, so rows don't jump around. */
  addedAt: number;
}

export interface GroupContext {
  group: Group;
  members: MemberView[];
  byId: Map<string, MemberView>;
  /** Engine inputs, one per member. */
  inputs: MemberInput[];
  settings: MatchSettings;
  /** Locked-in sessions that have started, newest first (for late reports). */
  lateRecords: LateRecord[];
  /** The group's games, most players first. */
  games: GameView[];
  gameById: Map<string, GameView>;
}

/**
 * The group narrowed to one game: `members`, `inputs` and the party size are that game's, so windows,
 * lobbies and "free right now" pings only involve people who play it. `byId` still has everyone.
 */
export interface GameContext extends GroupContext {
  game: GameView;
}

const PALETTE = ["#ff4655", "#3b82f6", "#f59e0b", "#10b981", "#a78bfa", "#ec4899", "#14b8a6", "#f97316"];

export function settingsOf(group: Group): MatchSettings {
  return {
    partySize: group.partySize,
    minSessionMinutes: group.minSessionMinutes,
    maxPauseMinutes: group.maxPauseMinutes,
  };
}

export function forGame(ctx: GroupContext, game: GameView): GameContext {
  const plays = new Set(game.players);
  return {
    ...ctx,
    group: { ...ctx.group, partySize: game.partySize, matchLengthMinutes: game.matchMinutes },
    members: ctx.members.filter((m) => plays.has(m.id)),
    inputs: ctx.inputs.filter((m) => plays.has(m.id)),
    settings: { ...ctx.settings, partySize: game.partySize },
    game,
  };
}

/** Stand-in for sessions whose game was removed: the whole group, with the group's old settings. */
function anyGame(ctx: GroupContext): GameView {
  return {
    id: "",
    name: "Game",
    partySize: ctx.group.partySize,
    matchMinutes: ctx.group.matchLengthMinutes,
    players: ctx.members.map((m) => m.id),
    addedAt: 0,
  };
}

/** The game a session (lobby or locked-in window) is for. */
export function sessionGame(ctx: GroupContext, session: { gameId: string | null }): GameContext {
  return forGame(ctx, (session.gameId && ctx.gameById.get(session.gameId)) || anyGame(ctx));
}

/** The game most of the group plays (used where one game has to stand for all, like the WFH vote). */
export function mainGame(ctx: GroupContext): GameContext {
  return forGame(ctx, ctx.games[0] ?? anyGame(ctx));
}

/** Games a member plays, most players first. */
export function gamesOf(ctx: GroupContext, memberId: string): GameView[] {
  return ctx.games.filter((g) => g.players.includes(memberId));
}

/** A game by id, or by name typed loosely ("valorant", "league", "tft"). */
export function findGame(ctx: GroupContext, text: string | null | undefined): GameView | null {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return null;
  const byId = ctx.gameById.get(text!.trim());
  if (byId) return byId;
  const exact = ctx.games.find((g) => g.name.toLowerCase() === t);
  if (exact) return exact;
  const partial = ctx.games.filter((g) => g.name.toLowerCase().includes(t));
  return partial.length === 1 ? partial[0] : null;
}

export async function loadGroupContext(groupId: string): Promise<GroupContext> {
  const db = await getDb();
  const now = Date.now();
  // Everything in one parallel round trip: per-member tables filter by the group's members via a subquery.
  const memberIds = () => db.select({ id: memberships.userId }).from(memberships).where(eq(memberships.groupId, groupId));
  const gameIds = () => db.select({ id: games.id }).from(games).where(eq(games.groupId, groupId));
  const [[group], rows, patternRows, hybridRows, wfhRows, vacationRows, gameRows, playRows, lateRecords] =
    await Promise.all([
      db.select().from(groups).where(eq(groups.id, groupId)),
      db
        .select({
          id: user.id,
          name: user.name,
          image: user.image,
          role: memberships.role,
          timezone: memberProfiles.timezone,
          workStyle: memberProfiles.workStyle,
          color: memberProfiles.color,
          discordId: memberProfiles.discordId,
          dmWhenFull: memberProfiles.dmWhenFull,
          nightBeforeWfhUntil: memberProfiles.nightBeforeWfhUntil,
        })
        .from(memberships)
        .innerJoin(user, eq(user.id, memberships.userId))
        .leftJoin(memberProfiles, eq(memberProfiles.userId, memberships.userId))
        .where(eq(memberships.groupId, groupId))
        .orderBy(asc(memberships.joinedAt), asc(user.name)),
      db.select().from(dayPatterns).where(inArray(dayPatterns.userId, memberIds())),
      db.select().from(hybridDays).where(inArray(hybridDays.userId, memberIds())),
      db.select().from(wfhDays).where(inArray(wfhDays.userId, memberIds())),
      db.select().from(vacations).where(inArray(vacations.userId, memberIds())).orderBy(asc(vacations.startDate)),
      db.select().from(games).where(eq(games.groupId, groupId)).orderBy(asc(games.createdAt), asc(games.name)),
      db.select().from(memberGames).where(inArray(memberGames.gameId, gameIds())),
      loadLateRecords(groupId, now),
    ]);
  if (!group) throw new Error(`Group ${groupId} not found`);
  const late = lateStats(lateRecords, now);

  const members: MemberView[] = rows.map((r, i) => {
    const hybrid = (r.workStyle ?? "fixed") === "hybrid";
    return {
      id: r.id,
      name: r.name,
      image: r.image,
      role: r.role,
      color: r.color ?? PALETTE[i % PALETTE.length],
      timezone: r.timezone ?? group.homeTimezone,
      workStyle: hybrid ? "hybrid" : "fixed",
      discordId: r.discordId ?? null,
      dmWhenFull: r.dmWhenFull ?? false,
      nightBeforeWfhUntil: r.nightBeforeWfhUntil ?? null,
      hybridDays: Object.fromEntries(
        hybridRows.filter((h) => h.userId === r.id).map((h) => [h.weekday, h.mode]),
      ) as Partial<Record<Weekday, HybridMode>>,
      patterns: Object.fromEntries(patternRows.filter((p) => p.userId === r.id).map((p) => [p.key, p.cells])),
      wfhDates: wfhRows.filter((w) => w.userId === r.id).map((w) => w.date),
      vacations: vacationRows
        .filter((v) => v.userId === r.id)
        .map((v) => ({ id: v.id, start: v.startDate, end: v.endDate })),
      games: [],
      lateness: late.get(r.id) ?? NO_LATE_STATS,
    };
  });

  const gameList: GameView[] = gameRows
    .map((g) => ({
      id: g.id,
      name: g.name,
      partySize: g.partySize,
      matchMinutes: g.matchMinutes,
      players: members.filter((m) => playRows.some((p) => p.gameId === g.id && p.userId === m.id)).map((m) => m.id),
      addedAt: g.createdAt.getTime(),
    }))
    // Most players first; the sort is stable, so ties keep the order games were added.
    .sort((a, b) => b.players.length - a.players.length);
  for (const m of members) m.games = gameList.filter((g) => g.players.includes(m.id)).map((g) => g.id);

  return {
    group,
    members,
    byId: new Map(members.map((m) => [m.id, m])),
    inputs: members.map(toEngineInput),
    settings: settingsOf(group),
    lateRecords,
    games: gameList,
    gameById: new Map(gameList.map((g) => [g.id, g])),
  };
}

export function toEngineInput(m: MemberView): MemberInput {
  const weekly: MemberInput["weekly"] = {};
  const wfhWeekly: NonNullable<MemberInput["wfhWeekly"]> = {};
  const overrides: Record<string, string> = {};
  for (const [key, cells] of Object.entries(m.patterns)) {
    if (/^w[1-7]$/.test(key)) weekly[Number(key.slice(1)) as Weekday] = cells;
    else if (/^wfh[1-7]$/.test(key)) wfhWeekly[Number(key.slice(3)) as Weekday] = cells;
    else if (key.startsWith("d:")) overrides[key.slice(2)] = cells;
  }
  const hybrid = m.workStyle === "hybrid";
  return {
    id: m.id,
    name: m.name,
    timezone: m.timezone,
    weekly,
    overrides,
    wfhPattern: hybrid ? (m.patterns.wfh ?? null) : null,
    wfhWeekly: hybrid ? wfhWeekly : undefined,
    hybridDays: hybrid ? m.hybridDays : undefined,
    wfhDates: hybrid ? new Set(m.wfhDates) : undefined,
    nightBeforeWfhUntil: hybrid ? m.nightBeforeWfhUntil : null,
    vacations: m.vacations,
  };
}

export interface Viewer {
  userId: string;
  me: MemberView;
  ctx: GroupContext;
}

/**
 * The signed-in user's id, group id and the group's home time zone: one quick lookup, so pages can start
 * their own queries in parallel with requireViewer(). Redirects to /login when there isn't one. Cached per
 * request.
 */
export const requireMember = cache(async (): Promise<{ userId: string; groupId: string; homeTimezone: string }> => {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const db = await getDb();
  const [membership] = await db
    .select({ groupId: memberships.groupId, homeTimezone: groups.homeTimezone })
    .from(memberships)
    .innerJoin(groups, eq(groups.id, memberships.groupId))
    .where(eq(memberships.userId, userId))
    .orderBy(asc(memberships.joinedAt))
    .limit(1);
  if (!membership) redirect("/login?stale=1");
  return { userId, groupId: membership.groupId, homeTimezone: membership.homeTimezone };
});

/**
 * The signed-in member and their group. Redirects to /login when there isn't one. Cached per request,
 * so the layout and the page share one load.
 */
export const requireViewer = cache(async (): Promise<Viewer> => {
  const { userId, groupId } = await requireMember();
  const ctx = await loadGroupContext(groupId);
  const me = ctx.byId.get(userId);
  if (!me) redirect("/login?stale=1");
  return { userId, me, ctx };
});
