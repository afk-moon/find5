import { eq, sql } from "drizzle-orm";
import type { DB } from "@/db";
import { offenseReports, playerRatings, playSessions } from "@/db/schema";
import { offensesFrom, reputationOf, type Reputation } from "@/engine/reputation";

/**
 * Everyone's 👍/👎 totals and bannable offenses in a group, over all of its lobbies. Both queries go out
 * together and nothing is awaited first, so alongside other queries this adds no round trip.
 */
export async function loadReputation(db: DB, groupId: string): Promise<Map<string, Reputation>> {
  const inGroup = eq(playSessions.groupId, groupId);
  const [votes, reports] = await Promise.all([
    db
      .select({
        userId: playerRatings.targetId,
        up: sql<number>`count(*) filter (where ${playerRatings.value} > 0)`.mapWith(Number),
        down: sql<number>`count(*) filter (where ${playerRatings.value} < 0)`.mapWith(Number),
      })
      .from(playerRatings)
      .innerJoin(playSessions, eq(playSessions.id, playerRatings.sessionId))
      .where(inGroup)
      .groupBy(playerRatings.targetId),
    // Reports per (lobby, person, reporter): offenses are counted lobby by lobby from these.
    db
      .select({
        sessionId: offenseReports.sessionId,
        userId: offenseReports.targetId,
        n: sql<number>`count(*)`.mapWith(Number),
      })
      .from(offenseReports)
      .innerJoin(playSessions, eq(playSessions.id, offenseReports.sessionId))
      .where(inGroup)
      .groupBy(offenseReports.sessionId, offenseReports.targetId, offenseReports.reporterId),
  ]);
  const perLobby = new Map<string, { userId: string; counts: number[] }>();
  for (const r of reports) {
    const key = `${r.sessionId}:${r.userId}`;
    const entry = perLobby.get(key) ?? { userId: r.userId, counts: [] };
    entry.counts.push(r.n);
    perLobby.set(key, entry);
  }
  const offenses = new Map<string, number>();
  for (const { userId, counts } of perLobby.values()) offenses.set(userId, (offenses.get(userId) ?? 0) + offensesFrom(counts));
  const ids = new Set([...votes.map((v) => v.userId), ...offenses.keys()]);
  return new Map(
    [...ids].map((id) => {
      const v = votes.find((x) => x.userId === id);
      return [id, reputationOf(v?.up ?? 0, v?.down ?? 0, offenses.get(id) ?? 0)];
    }),
  );
}
