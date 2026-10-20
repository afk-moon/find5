import { and, eq, like } from "drizzle-orm";
import { DateTime } from "luxon";
import { getDb } from "@/db";
import {
  dayPatterns,
  games,
  groups,
  hybridDays,
  memberProfiles,
  memberships,
  user,
  vacations,
  wfhDays,
} from "@/db/schema";
import { normalizePattern, pattern } from "@/engine";
import type { HybridMode } from "@/engine/types";
import { isValidZone } from "@/lib/format";
import { defaultGameRows } from "@/lib/games";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[03]0$/;

async function upsertPattern(userId: string, key: string, cells: string) {
  const db = await getDb();
  await db
    .insert(dayPatterns)
    .values({ userId, key, cells: normalizePattern(cells) })
    .onConflictDoUpdate({
      target: [dayPatterns.userId, dayPatterns.key],
      set: { cells: normalizePattern(cells), updatedAt: new Date() },
    });
}

export async function saveWeekPatterns(userId: string, weekly: Record<string, string>) {
  for (const [day, cells] of Object.entries(weekly)) {
    if (!/^[1-7]$/.test(day)) throw new Error(`Bad weekday ${day}`);
    await upsertPattern(userId, `w${day}`, cells);
  }
}

/** WFH-day patterns per weekday (Mon–Fri): WFH Mondays can look different from WFH Fridays. */
export async function saveWfhWeek(userId: string, days: Record<string, string>) {
  for (const [day, cells] of Object.entries(days)) {
    if (!/^[1-5]$/.test(day)) throw new Error(`Bad WFH weekday ${day}`);
    await upsertPattern(userId, `wfh${day}`, cells);
  }
}

/** Set (or clear, with null) a one-off pattern for a specific gaming day. */
export async function saveDateOverride(userId: string, date: string, cells: string | null) {
  if (!DATE_RE.test(date)) throw new Error(`Bad date ${date}`);
  if (cells === null) {
    const db = await getDb();
    await db.delete(dayPatterns).where(and(eq(dayPatterns.userId, userId), eq(dayPatterns.key, `d:${date}`)));
  } else {
    await upsertPattern(userId, `d:${date}`, cells);
  }
}

/** A real calendar day ("2026-02-30" isn't). */
const isRealDate = (date: string) => DATE_RE.test(date) && DateTime.fromISO(date, { zone: "utc" }).isValid;

/**
 * Add time away: busy every day from `startDate` to `endDate` (inclusive, the member's own local days).
 * `today` is their current gaming day, so a trip that's already over is refused.
 */
export async function addVacation(userId: string, startDate: string, endDate: string, today: string) {
  if (!isRealDate(startDate) || !isRealDate(endDate)) throw new Error("Pick the first and last day you're away.");
  if (endDate < startDate) throw new Error("The last day is before the first day.");
  if (endDate < today) throw new Error("Those dates are already over.");
  const length = DateTime.fromISO(endDate, { zone: "utc" }).diff(DateTime.fromISO(startDate, { zone: "utc" }), "days").days;
  if (length >= 366) throw new Error("That's more than a year. Pick a shorter trip.");
  const db = await getDb();
  const [row] = await db.insert(vacations).values({ userId, startDate, endDate }).returning();
  return row;
}

/** Remove one of your own vacations. */
export async function removeVacation(userId: string, id: string) {
  const db = await getDb();
  await db.delete(vacations).where(and(eq(vacations.id, id), eq(vacations.userId, userId)));
}

export interface ProfileInput {
  timezone: string;
  workStyle: "fixed" | "hybrid";
  nightBeforeWfhUntil: string | null;
  hybridDays: Partial<Record<1 | 2 | 3 | 4 | 5, HybridMode>>;
  /** DM me on Discord when a lobby I'm in fills a 5-stack. Left out: keep what's saved. */
  dmWhenFull?: boolean;
}

export async function saveProfile(userId: string, input: ProfileInput) {
  if (!isValidZone(input.timezone)) throw new Error(`Unknown time zone ${input.timezone}`);
  if (input.nightBeforeWfhUntil && !TIME_RE.test(input.nightBeforeWfhUntil)) throw new Error("Bad time");
  const db = await getDb();
  const values = {
    timezone: input.timezone,
    workStyle: input.workStyle,
    nightBeforeWfhUntil: input.nightBeforeWfhUntil || null,
    ...(typeof input.dmWhenFull === "boolean" ? { dmWhenFull: input.dmWhenFull } : {}),
  };
  await db
    .insert(memberProfiles)
    .values({ userId, ...values })
    .onConflictDoUpdate({ target: memberProfiles.userId, set: { ...values, updatedAt: new Date() } });

  await db.delete(hybridDays).where(eq(hybridDays.userId, userId));
  const rows = Object.entries(input.hybridDays)
    .filter(([d, mode]) => /^[1-5]$/.test(d) && (mode === "office" || mode === "wfh" || mode === "flex"))
    .map(([d, mode]) => ({ userId, weekday: Number(d), mode: mode as HybridMode }));
  if (rows.length) await db.insert(hybridDays).values(rows);
}

/** Mark/unmark a specific date as a WFH day (outside of the weekly vote). */
export async function setWfhDate(userId: string, date: string, on: boolean) {
  if (!DATE_RE.test(date)) throw new Error(`Bad date ${date}`);
  const db = await getDb();
  if (on) {
    await db.insert(wfhDays).values({ userId, date, source: "manual" }).onConflictDoNothing();
  } else {
    await db.delete(wfhDays).where(and(eq(wfhDays.userId, userId), eq(wfhDays.date, date)));
  }
}

/** Remove past date overrides so they don't pile up. */
export async function pruneOldOverrides(userId: string, beforeDate: string) {
  const db = await getDb();
  const rows = await db
    .select({ key: dayPatterns.key })
    .from(dayPatterns)
    .where(and(eq(dayPatterns.userId, userId), like(dayPatterns.key, "d:%")));
  for (const { key } of rows) {
    if (key.slice(2) < beforeDate) {
      await db.delete(dayPatterns).where(and(eq(dayPatterns.userId, userId), eq(dayPatterns.key, key)));
    }
  }
}

/** Starter week for new members: free evenings with a quick 6:30pm dinner, longer weekends. */
export function starterWeek(): Record<number, string> {
  const weekday = pattern({ F: [["18:00", "23:00"]], Q: [["18:30", "19:00"]] });
  const weekend = pattern({ F: [["12:00", "00:00"]], Q: [["18:30", "19:00"]] });
  return { 1: weekday, 2: weekday, 3: weekday, 4: weekday, 5: weekday, 6: weekend, 7: weekend };
}

/** Add a member to a group (creating the group if none exists yet) with a starter week. */
export async function createMember(input: {
  name: string;
  timezone: string;
  email?: string;
  image?: string | null;
  discordId?: string | null;
}) {
  const db = await getDb();
  const id = crypto.randomUUID();
  const timezone = isValidZone(input.timezone) ? input.timezone : "America/Chicago";
  await db.insert(user).values({
    id,
    name: input.name.trim().slice(0, 40) || "Player",
    email: input.email ?? `${id}@members.receptionist.local`,
    image: input.image ?? null,
  });
  await db.insert(memberProfiles).values({ userId: id, timezone, discordId: input.discordId ?? null });

  let [group] = await db.select({ id: groups.id }).from(groups).limit(1);
  const isFirst = !group;
  if (!group) {
    [group] = await db.insert(groups).values({ name: "Valorant Squad" }).returning({ id: groups.id });
    await db.insert(games).values(defaultGameRows(group.id));
  }
  // No games picked yet: they choose theirs on My availability (the Windows page asks them to).
  await db.insert(memberships).values({ groupId: group.id, userId: id, role: isFirst ? "owner" : "member" });

  await saveWeekPatterns(
    id,
    Object.fromEntries(Object.entries(starterWeek()).map(([d, cells]) => [String(d), cells])),
  );
  return id;
}
