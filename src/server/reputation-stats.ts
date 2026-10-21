import { eq, sql } from "drizzle-orm";
import type { DB } from "@/db";
import { offenseReports, playerRatings, playSessions } from "@/db/schema";
import { REPORTS_PER_OFFENSE, reputationOf, type Reputation } from "@/engine/reputation";

/**
 * Everyone's 👍/👎 totals and bannable offenses in a group, over all of its lobbies. Both queries go out
 * together and nothing is awaited first, so alongside other queries this adds no round trip.
 */
export async function loadReputation(db: DB, groupId: string): Promise<Map<string, Reputation>> {
  const inGroup = eq(playSessions.groupId, groupId);
  const [votes, offenses] = await Promise.all([
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
    // One row per (lobby, person) with enough reports: each row is one offense.
    db
      .select({ userId: offenseReports.targetId })
      .from(offenseReports)
      .innerJoin(playSessions, eq(playSessions.id, offenseReports.sessionId))
      .where(inGroup)
      .groupBy(offenseReports.sessionId, offenseReports.targetId)
      .having(sql`count(*) >= ${REPORTS_PER_OFFENSE}`),
  ]);
  const ids = new Set([...votes.map((v) => v.userId), ...offenses.map((o) => o.userId)]);
  return new Map(
    [...ids].map((id) => {
      const v = votes.find((x) => x.userId === id);
      return [id, reputationOf(v?.up ?? 0, v?.down ?? 0, offenses.filter((o) => o.userId === id).length)];
    }),
  );
}
