import { getDb } from "@/db";
import { groups } from "@/db/schema";
import { runAutoPosts, tickDue } from "@/server/autopost";
import { loadGroupContext } from "@/server/context";

/**
 * The bot's own posts (see src/server/autopost.ts): the day's windows at 11 AM, and each window's locked-in lobby
 * 5 minutes before it starts. Ping it every 5 minutes, from a free service like cron-job.org (Vercel's free plan
 * only runs crons once a day) or a Vercel cron on the Pro plan. Pings with nothing to do return right away
 * without touching the database. Protected by CRON_SECRET: send "Authorization: Bearer <secret>", or add
 * ?key=<secret> to the URL for services that can't send headers.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const key = new URL(req.url).searchParams.get("key");
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}` && key !== secret) {
    return new Response("unauthorized", { status: 401 });
  }
  const now = Date.now();
  const due = tickDue(now);
  if (!due.daily && !due.lobbies) return Response.json({ ok: true, idle: true });
  const db = await getDb();
  const results: string[] = [];
  for (const g of await db.select({ id: groups.id, name: groups.name }).from(groups)) {
    for (const done of await runAutoPosts(await loadGroupContext(g.id), now, due)) results.push(`${g.name}: ${done}`);
  }
  return Response.json({ ok: true, results });
}
