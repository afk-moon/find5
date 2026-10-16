import { asc, eq, inArray } from "drizzle-orm";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getDb } from "@/db";
import { dayPatterns, groups, hybridDays, memberProfiles, memberships, user, vacations, wfhDays } from "@/db/schema";
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
  nightBeforeWfhUntil: string | null;
  hybridDays: Partial<Record<Weekday, HybridMode>>;
  /** Raw stored patterns by key ("w1"…"w7", "wfh", "d:YYYY-MM-DD"). */
  patterns: Record<string, string>;
  wfhDates: string[];
  /** Time away, earliest first ("YYYY-MM-DD" local days, inclusive). */
  vacations: Array<{ id: string; start: string; end: string }>;
  /** Late history over their recent locked-in sessions (drives the "frequently late" tag). */
  lateness: LateStats;
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
}

const PALETTE = ["#ff4655", "#3b82f6", "#f59e0b", "#10b981", "#a78bfa", "#ec4899", "#14b8a6", "#f97316"];

export function settingsOf(group: Group): MatchSettings {
  return {
    partySize: group.partySize,
    minSessionMinutes: group.minSessionMinutes,
    maxPauseMinutes: group.maxPauseMinutes,
  };
}

export async function loadGroupContext(groupId: string): Promise<GroupContext> {
  const db = await getDb();
  const now = Date.now();
  // Everything in one parallel round trip: per-member tables filter by the group's members via a subquery.
  const memberIds = () => db.select({ id: memberships.userId }).from(memberships).where(eq(memberships.groupId, groupId));
  const [[group], rows, patternRows, hybridRows, wfhRows, vacationRows, lateRecords] = await Promise.all([
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
      nightBeforeWfhUntil: r.nightBeforeWfhUntil ?? null,
      hybridDays: Object.fromEntries(
        hybridRows.filter((h) => h.userId === r.id).map((h) => [h.weekday, h.mode]),
      ) as Partial<Record<Weekday, HybridMode>>,
      patterns: Object.fromEntries(patternRows.filter((p) => p.userId === r.id).map((p) => [p.key, p.cells])),
      wfhDates: wfhRows.filter((w) => w.userId === r.id).map((w) => w.date),
      vacations: vacationRows
        .filter((v) => v.userId === r.id)
        .map((v) => ({ id: v.id, start: v.startDate, end: v.endDate })),
      lateness: late.get(r.id) ?? NO_LATE_STATS,
    };
  });

  return {
    group,
    members,
    byId: new Map(members.map((m) => [m.id, m])),
    inputs: members.map(toEngineInput),
    settings: settingsOf(group),
    lateRecords,
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
 * The signed-in user's id and group id: one quick lookup, so pages can start their own queries in
 * parallel with requireViewer(). Redirects to /login when there isn't one. Cached per request.
 */
export const requireMember = cache(async (): Promise<{ userId: string; groupId: string }> => {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const db = await getDb();
  const [membership] = await db
    .select({ groupId: memberships.groupId })
    .from(memberships)
    .where(eq(memberships.userId, userId))
    .orderBy(asc(memberships.joinedAt))
    .limit(1);
  if (!membership) redirect("/login?stale=1");
  return { userId, groupId: membership.groupId };
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
