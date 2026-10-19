import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { games, memberGames } from "@/db/schema";
import { MAX_PARTY, MIN_PARTY } from "@/lib/games";
import type { GroupContext } from "./context";

const clampParty = (n: number) => Math.min(MAX_PARTY, Math.max(MIN_PARTY, Math.round(n) || 5));

function cleanName(ctx: GroupContext, name: string, exceptId?: string) {
  const clean = name.trim().replace(/\s+/g, " ").slice(0, 40);
  if (!clean) throw new Error("Give the game a name.");
  const taken = ctx.games.find((g) => g.id !== exceptId && g.name.toLowerCase() === clean.toLowerCase());
  if (taken) throw new Error(`${taken.name} is already on the list.`);
  return clean;
}

function ownGame(ctx: GroupContext, gameId: string) {
  const game = ctx.gameById.get(gameId);
  if (!game) throw new Error("That game isn't in this group.");
  return game;
}

/** Pick which of the group's games a member plays (replaces their previous picks). */
export async function setMemberGames(ctx: GroupContext, userId: string, gameIds: string[]) {
  if (!ctx.byId.has(userId)) throw new Error("You're not in this group.");
  const picked = [...new Set(gameIds)].filter((id) => ctx.gameById.has(id));
  const db = await getDb();
  const groupGames = ctx.games.map((g) => g.id);
  if (groupGames.length) {
    await db.delete(memberGames).where(and(eq(memberGames.userId, userId), inArray(memberGames.gameId, groupGames)));
  }
  if (picked.length) await db.insert(memberGames).values(picked.map((gameId) => ({ userId, gameId })));
  return picked;
}

/** Add a game to the group. Whoever adds it plays it. */
export async function addGame(ctx: GroupContext, userId: string, input: { name: string; partySize: number }) {
  const name = cleanName(ctx, input.name);
  const db = await getDb();
  const [game] = await db
    .insert(games)
    .values({ groupId: ctx.group.id, name, partySize: clampParty(input.partySize), createdBy: userId })
    .returning();
  await db.insert(memberGames).values({ userId, gameId: game.id }).onConflictDoNothing();
  return game;
}

/** Rename a game or change how many players it needs and how long a match takes. */
export async function updateGame(
  ctx: GroupContext,
  gameId: string,
  input: { name: string; partySize: number; matchMinutes: number },
) {
  ownGame(ctx, gameId);
  const db = await getDb();
  await db
    .update(games)
    .set({
      name: cleanName(ctx, input.name, gameId),
      partySize: clampParty(input.partySize),
      matchMinutes: Math.min(180, Math.max(10, Math.round(input.matchMinutes) || 40)),
    })
    .where(eq(games.id, gameId));
}

/** Remove a game (and everyone's pick of it). Past sessions stay, without a game. The last game can't go. */
export async function removeGame(ctx: GroupContext, gameId: string) {
  ownGame(ctx, gameId);
  if (ctx.games.length <= 1) throw new Error("Keep at least one game.");
  const db = await getDb();
  await db.delete(games).where(eq(games.id, gameId));
}
