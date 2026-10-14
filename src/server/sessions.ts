import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { playSessionPlayers, playSessions, type PlayerStatus, type SessionPlan } from "@/db/schema";
import type { PlayWindow } from "@/engine";
import type { GroupContext } from "./context";
import { findWindowByBounds } from "./windows";

export type PlaySession = typeof playSessions.$inferSelect;
export type SessionPlayer = typeof playSessionPlayers.$inferSelect;
export interface SessionWithPlayers {
  session: PlaySession;
  players: SessionPlayer[];
}

/** How long a long-dinner break is assumed to take when someone taps "long dinner" live. */
export const LONG_DINNER_MINUTES = 90;
const LIVE_MAX_AGE_MS = 12 * 3_600_000;

async function withPlayers(rows: PlaySession[]): Promise<SessionWithPlayers[]> {
  if (!rows.length) return [];
  const db = await getDb();
  const players = await db
    .select()
    .from(playSessionPlayers)
    .where(inArray(playSessionPlayers.sessionId, rows.map((r) => r.id)));
  return rows.map((session) => ({ session, players: players.filter((p) => p.sessionId === session.id) }));
}

export async function getSession(groupId: string, sessionId: string): Promise<SessionWithPlayers | null> {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(playSessions)
    .where(and(eq(playSessions.id, sessionId), eq(playSessions.groupId, groupId)));
  return row ? (await withPlayers([row]))[0] : null;
}

export function planFromWindow(w: PlayWindow): SessionPlan {
  return {
    playMinutes: w.playMinutes,
    subs: w.subs,
    pauses: w.pauses.map((p) => ({ startMs: p.startMs, endMs: p.endMs, who: p.who })),
  };
}

// ─── Planned sessions ──────────────────────────────────────────────────────────────────────

/** Lock in a suggested window. The window is re-computed server-side; returns the session and window. */
export async function lockInWindow(ctx: GroupContext, userId: string, startMs: number, endMs: number) {
  const window = findWindowByBounds(ctx, startMs, endMs);
  if (!window) throw new Error("That window isn't available anymore. Someone's availability changed.");
  const db = await getDb();
  const [existing] = await db
    .select()
    .from(playSessions)
    .where(
      and(
        eq(playSessions.groupId, ctx.group.id),
        eq(playSessions.kind, "planned"),
        eq(playSessions.status, "active"),
        eq(playSessions.startAt, new Date(startMs)),
      ),
    );
  if (existing) return { session: existing, window, created: false };

  const [session] = await db
    .insert(playSessions)
    .values({
      groupId: ctx.group.id,
      kind: "planned",
      startAt: new Date(startMs),
      endAt: new Date(endMs),
      plan: planFromWindow(window),
      createdBy: userId,
    })
    .returning();
  await db
    .insert(playSessionPlayers)
    .values(window.party.map((id) => ({ sessionId: session.id, userId: id, status: "in" as const })));
  return { session, window, created: true };
}

export async function upcomingPlanned(groupId: string, nowMs = Date.now()): Promise<SessionWithPlayers[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(playSessions)
    .where(
      and(
        eq(playSessions.groupId, groupId),
        eq(playSessions.kind, "planned"),
        eq(playSessions.status, "active"),
        gt(playSessions.endAt, new Date(nowMs)),
      ),
    )
    .orderBy(asc(playSessions.startAt));
  return withPlayers(rows);
}

export async function cancelSession(groupId: string, sessionId: string) {
  const db = await getDb();
  await db
    .update(playSessions)
    .set({ status: "cancelled" })
    .where(and(eq(playSessions.id, sessionId), eq(playSessions.groupId, groupId)));
}

// ─── Live (spontaneous) sessions ───────────────────────────────────────────────────────────

export async function activeLive(groupId: string, nowMs = Date.now()): Promise<SessionWithPlayers | null> {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(playSessions)
    .where(
      and(
        eq(playSessions.groupId, groupId),
        eq(playSessions.kind, "live"),
        eq(playSessions.status, "active"),
        gt(playSessions.startAt, new Date(nowMs - LIVE_MAX_AGE_MS)),
      ),
    )
    .orderBy(desc(playSessions.startAt))
    .limit(1);
  return row ? (await withPlayers([row]))[0] : null;
}

/** Open a lobby (or join the one that's already open). */
export async function startLive(ctx: GroupContext, userId: string) {
  const existing = await activeLive(ctx.group.id);
  if (existing) {
    await setPlayerStatus(ctx, existing.session.id, userId, "in");
    return { sessionId: existing.session.id, created: false };
  }
  const db = await getDb();
  const [session] = await db
    .insert(playSessions)
    .values({ groupId: ctx.group.id, kind: "live", startAt: new Date(), createdBy: userId })
    .returning();
  await db.insert(playSessionPlayers).values({ sessionId: session.id, userId, status: "in" });
  return { sessionId: session.id, created: true };
}

export async function setPlayerStatus(
  ctx: GroupContext,
  sessionId: string,
  userId: string,
  status: PlayerStatus,
  backAt: Date | null = null,
) {
  if (!ctx.byId.has(userId)) throw new Error("You're not in this group.");
  const db = await getDb();
  const [session] = await db
    .select()
    .from(playSessions)
    .where(and(eq(playSessions.id, sessionId), eq(playSessions.groupId, ctx.group.id)));
  if (!session || session.status !== "active") throw new Error("That session has ended.");
  await db
    .insert(playSessionPlayers)
    .values({ sessionId, userId, status, backAt })
    .onConflictDoUpdate({
      target: [playSessionPlayers.sessionId, playSessionPlayers.userId],
      set: { status, backAt, updatedAt: new Date() },
    });
}

/** Quick dinner: the party waits (up to the pause limit). Long dinner: they're out for a while. */
export async function goToDinner(ctx: GroupContext, sessionId: string, userId: string, kind: "quick" | "long") {
  const minutes = kind === "quick" ? ctx.group.maxPauseMinutes : LONG_DINNER_MINUTES;
  await setPlayerStatus(
    ctx,
    sessionId,
    userId,
    kind === "quick" ? "quick_dinner" : "long_dinner",
    new Date(Date.now() + minutes * 60_000),
  );
}

export async function endSession(ctx: GroupContext, sessionId: string) {
  const db = await getDb();
  await db
    .update(playSessions)
    .set({ status: "ended", endAt: new Date() })
    .where(and(eq(playSessions.id, sessionId), eq(playSessions.groupId, ctx.group.id)));
}

export interface LiveSummary {
  /** full: enough people playing · paused: waiting on quick dinners · forming: need more people */
  state: "full" | "paused" | "forming";
  playing: string[];
  eating: Array<{ id: string; kind: "quick" | "long"; backAt: number | null }>;
  soon: string[];
  declined: string[];
  left: string[];
  /** How many more people are needed (quick diners count, since the party waits for them). */
  needed: number;
}

export function summarizeLive(partySize: number, players: SessionPlayer[]): LiveSummary {
  const ids = (status: PlayerStatus) => players.filter((p) => p.status === status).map((p) => p.userId);
  const playing = ids("in");
  const quick = ids("quick_dinner");
  const eating = players
    .filter((p) => p.status === "quick_dinner" || p.status === "long_dinner")
    .map((p) => ({
      id: p.userId,
      kind: p.status === "quick_dinner" ? ("quick" as const) : ("long" as const),
      backAt: p.backAt?.getTime() ?? null,
    }));
  const state =
    playing.length >= partySize ? "full" : playing.length + quick.length >= partySize ? "paused" : "forming";
  return {
    state,
    playing,
    eating,
    soon: ids("soon"),
    declined: ids("declined"),
    left: ids("left"),
    needed: Math.max(0, partySize - playing.length - quick.length),
  };
}
