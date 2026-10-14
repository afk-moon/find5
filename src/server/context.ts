import { asc, eq, inArray } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { dayPatterns, groups, hybridDays, memberProfiles, memberships, user, wfhDays } from "@/db/schema";
import type { HybridMode, MatchSettings, MemberInput, Weekday } from "@/engine/types";
import { getSessionUserId } from "./auth";

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
}

export interface GroupContext {
  group: Group;
  members: MemberView[];
  byId: Map<string, MemberView>;
  /** Engine inputs, one per member. */
  inputs: MemberInput[];
  settings: MatchSettings;
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
  const [group] = await db.select().from(groups).where(eq(groups.id, groupId));
  if (!group) throw new Error(`Group ${groupId} not found`);

  const rows = await db
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
    .orderBy(asc(memberships.joinedAt), asc(user.name));

  const ids = rows.map((r) => r.id);
  const [patternRows, hybridRows, wfhRows] = ids.length
    ? await Promise.all([
        db.select().from(dayPatterns).where(inArray(dayPatterns.userId, ids)),
        db.select().from(hybridDays).where(inArray(hybridDays.userId, ids)),
        db.select().from(wfhDays).where(inArray(wfhDays.userId, ids)),
      ])
    : [[], [], []];

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
    };
  });

  return {
    group,
    members,
    byId: new Map(members.map((m) => [m.id, m])),
    inputs: members.map(toEngineInput),
    settings: settingsOf(group),
  };
}

export function toEngineInput(m: MemberView): MemberInput {
  const weekly: MemberInput["weekly"] = {};
  const overrides: Record<string, string> = {};
  for (const [key, cells] of Object.entries(m.patterns)) {
    if (/^w[1-7]$/.test(key)) weekly[Number(key.slice(1)) as Weekday] = cells;
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
    hybridDays: hybrid ? m.hybridDays : undefined,
    wfhDates: hybrid ? new Set(m.wfhDates) : undefined,
    nightBeforeWfhUntil: hybrid ? m.nightBeforeWfhUntil : null,
  };
}

export interface Viewer {
  userId: string;
  me: MemberView;
  ctx: GroupContext;
}

/** The signed-in member and their group. Redirects to /login when there isn't one. */
export async function requireViewer(): Promise<Viewer> {
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
  const ctx = await loadGroupContext(membership.groupId);
  const me = ctx.byId.get(userId);
  if (!me) redirect("/login?stale=1");
  return { userId, me, ctx };
}
