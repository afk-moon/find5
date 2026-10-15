import { and, eq, inArray } from "drizzle-orm";
import { DateTime } from "luxon";
import { getDb } from "@/db";
import { wfhBallots, wfhDays, wfhVotes } from "@/db/schema";
import { addDays, decideWfhVote, planWfhWeek, type Weekday, type WfhPlan } from "@/engine";
import type { GroupContext, MemberView } from "./context";

export type WfhVote = typeof wfhVotes.$inferSelect;

/** Monday of this week (offset 0) or next week (offset 1), in the group's zone. */
export function weekStartOf(zone: string, offsetWeeks = 0, nowMs = Date.now()): string {
  return DateTime.fromMillis(nowMs, { zone }).startOf("week").plus({ weeks: offsetWeeks }).toISODate()!;
}

export async function getVote(groupId: string, weekStart: string): Promise<WfhVote | null> {
  const db = await getDb();
  const [vote] = await db
    .select()
    .from(wfhVotes)
    .where(and(eq(wfhVotes.groupId, groupId), eq(wfhVotes.weekStart, weekStart)));
  return vote ?? null;
}

export async function ensureVote(groupId: string, weekStart: string): Promise<WfhVote> {
  const db = await getDb();
  await db.insert(wfhVotes).values({ groupId, weekStart }).onConflictDoNothing();
  return (await getVote(groupId, weekStart))!;
}

export async function getBallots(voteId: string): Promise<Record<string, Weekday[]>> {
  const db = await getDb();
  const rows = await db.select().from(wfhBallots).where(eq(wfhBallots.voteId, voteId));
  return Object.fromEntries(rows.map((r) => [r.userId, r.days as Weekday[]]));
}

export interface WfhState {
  weekStart: string;
  vote: WfhVote | null;
  ballots: Record<string, Weekday[]>;
  hybrid: MemberView[];
  /** What the current ballots decide (or the projection, before anyone votes). */
  plan: WfhPlan;
  /** "If every flexible person WFH'd that day": the ceiling for each day. */
  projection: WfhPlan;
}

export async function getWfhState(ctx: GroupContext, weekStart: string): Promise<WfhState> {
  const db = await getDb();
  const thisVote = () =>
    db
      .select({ id: wfhVotes.id })
      .from(wfhVotes)
      .where(and(eq(wfhVotes.groupId, ctx.group.id), eq(wfhVotes.weekStart, weekStart)));
  const [vote, ballotRows] = await Promise.all([
    getVote(ctx.group.id, weekStart),
    db.select().from(wfhBallots).where(inArray(wfhBallots.voteId, thisVote())),
  ]);
  const ballots: Record<string, Weekday[]> = Object.fromEntries(ballotRows.map((r) => [r.userId, r.days as Weekday[]]));
  const args = {
    members: ctx.inputs,
    settings: ctx.settings,
    weekStart,
    homeZone: ctx.group.homeTimezone,
    sharedDays: ctx.group.wfhSharedDays,
  };
  const projection = planWfhWeek(args);
  const plan = Object.keys(ballots).length ? planWfhWeek({ ...args, ballots }) : projection;
  return { weekStart, vote, ballots, hybrid: ctx.members.filter((m) => m.workStyle === "hybrid"), plan, projection };
}

function assertCanVote(ctx: GroupContext, userId: string, day?: Weekday) {
  const me = ctx.byId.get(userId);
  if (!me || me.workStyle !== "hybrid") throw new Error("Only hybrid members vote on WFH days.");
  if (day && me.hybridDays[day] !== "flex") throw new Error("That isn't one of your flexible days.");
}

async function saveBallot(voteId: string, userId: string, days: Weekday[]) {
  const db = await getDb();
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  await db
    .insert(wfhBallots)
    .values({ voteId, userId, days: sorted })
    .onConflictDoUpdate({
      target: [wfhBallots.voteId, wfhBallots.userId],
      set: { days: sorted, updatedAt: new Date() },
    });
  return sorted;
}

/** Toggle one day on the member's ballot. Returns their updated days. */
export async function toggleBallotDay(ctx: GroupContext, weekStart: string, userId: string, day: Weekday) {
  assertCanVote(ctx, userId, day);
  const vote = await ensureVote(ctx.group.id, weekStart);
  if (vote.status !== "open") throw new Error("This week's vote is already closed.");
  const current = (await getBallots(vote.id))[userId] ?? [];
  const next = current.includes(day) ? current.filter((d) => d !== day) : [...current, day];
  return saveBallot(vote.id, userId, next);
}

/** "I can't WFH any day this week." */
export async function clearBallot(ctx: GroupContext, weekStart: string, userId: string) {
  assertCanVote(ctx, userId);
  const vote = await ensureVote(ctx.group.id, weekStart);
  if (vote.status !== "open") throw new Error("This week's vote is already closed.");
  return saveBallot(vote.id, userId, []);
}

/** Decide the shared WFH day(s) from the ballots and record them as WFH dates. */
export async function closeVote(ctx: GroupContext, weekStart: string) {
  const vote = await ensureVote(ctx.group.id, weekStart);
  const ballots = await getBallots(vote.id);
  const result = decideWfhVote({
    members: ctx.inputs,
    settings: ctx.settings,
    weekStart,
    homeZone: ctx.group.homeTimezone,
    sharedDays: ctx.group.wfhSharedDays,
    ballots,
  });
  const db = await getDb();
  if (result.assignments.length) {
    await db
      .insert(wfhDays)
      .values(result.assignments.map((a) => ({ userId: a.memberId, date: a.date, source: "vote" as const })))
      .onConflictDoNothing();
  }
  await db
    .update(wfhVotes)
    .set({ status: "closed", decidedDays: result.recommended, closedAt: new Date() })
    .where(eq(wfhVotes.id, vote.id));
  return result;
}

/** Undo a decision: remove the WFH dates it created and reopen voting. */
export async function reopenVote(ctx: GroupContext, weekStart: string) {
  const vote = await getVote(ctx.group.id, weekStart);
  if (!vote) return;
  const db = await getDb();
  const dates = [0, 1, 2, 3, 4].map((i) => addDays(weekStart, i));
  const ids = ctx.members.map((m) => m.id);
  if (ids.length) {
    await db
      .delete(wfhDays)
      .where(and(eq(wfhDays.source, "vote"), inArray(wfhDays.date, dates), inArray(wfhDays.userId, ids)));
  }
  await db
    .update(wfhVotes)
    .set({ status: "open", decidedDays: null, closedAt: null })
    .where(eq(wfhVotes.id, vote.id));
}
