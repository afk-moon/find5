import { DateTime } from "luxon";
import { getDb } from "@/db";
import { groups } from "@/db/schema";
import { loadGroupContext } from "@/server/context";
import { announceWfhDecision, closeOldLobbies, finishLateChecks, syncWfhVote } from "@/server/notify";
import { closeVote, ensureVote, getVote, weekStartOf } from "@/server/wfh";

/**
 * Daily job (Vercel Cron, see vercel.json): on the group's "open" weekday, post next week's WFH vote;
 * on the "close" weekday, decide it and announce the shared WFH day. Every day, it also closes lobbies
 * left open from earlier days (so old posts stop looking open) and updates the Discord messages of late
 * checks that just closed to show the result.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("unauthorized", { status: 401 });
  }
  const db = await getDb();
  const results: string[] = [];
  for (const g of await db.select().from(groups)) {
    const today = DateTime.now().setZone(g.homeTimezone).weekday;
    const nextWeek = weekStartOf(g.homeTimezone, 1);
    if (today === g.wfhVoteOpenWeekday) {
      await ensureVote(g.id, nextWeek);
      await syncWfhVote(await loadGroupContext(g.id), nextWeek, true);
      results.push(`${g.name}: opened WFH vote for ${nextWeek}`);
    }
    if (today === g.wfhVoteCloseWeekday) {
      const vote = await getVote(g.id, nextWeek);
      if (vote?.status === "open") {
        const result = await closeVote(await loadGroupContext(g.id), nextWeek);
        const fresh = await loadGroupContext(g.id);
        await announceWfhDecision(fresh, nextWeek, result);
        await syncWfhVote(fresh, nextWeek);
        results.push(`${g.name}: decided ${nextWeek} → ${result.recommended.join(",") || "none"}`);
      }
    }
    const ctx = await loadGroupContext(g.id);
    const lobbies = await closeOldLobbies(ctx);
    if (lobbies) results.push(`${g.name}: closed ${lobbies} old lobb${lobbies === 1 ? "y" : "ies"}`);
    const finished = await finishLateChecks(ctx);
    if (finished) results.push(`${g.name}: closed ${finished} late check${finished === 1 ? "" : "s"}`);
  }
  return Response.json({ ok: true, results });
}
