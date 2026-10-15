import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// Throwaway embedded database (seeded with the demo group on first use).
process.env.PGLITE_DIR = mkdtempSync(path.join(tmpdir(), "receptionist-roundtrips-"));

const { getDb } = await import("@/db");
const { DEMO_GROUP_ID } = await import("@/db/seed");
const { loadGroupContext } = await import("./context");
const { activeLive, upcomingPlanned } = await import("./sessions");
const { getWfhState, weekStartOf } = await import("./wfh");

/**
 * Hosted databases are a network hop away, so what makes a page slow is how many times it has to wait
 * for the database in a row. This counts those waits: queries sent together (before the next timer
 * tick) count as one round trip.
 */
let roundTrips = 0;
let inFlight = false;

beforeAll(async () => {
  const db = await getDb();
  const client = (db as unknown as { $client: { query: (...args: unknown[]) => Promise<unknown> } }).$client;
  const query = client.query.bind(client);
  client.query = async (...args: unknown[]) => {
    if (!inFlight) {
      inFlight = true;
      roundTrips++;
      setTimeout(() => (inFlight = false), 0);
    }
    await new Promise((resolve) => setTimeout(resolve, 5)); // the network hop
    return query(...args);
  };
}, 60_000);

async function countRoundTrips(load: () => Promise<unknown>) {
  roundTrips = 0;
  await load();
  return roundTrips;
}

describe("database round trips per page", () => {
  it("loads the whole group in one round trip", async () => {
    expect(await countRoundTrips(() => loadGroupContext(DEMO_GROUP_ID))).toBe(1);
  });

  it("loads the Windows and Live tabs' extra data alongside the group", async () => {
    expect(await countRoundTrips(() => Promise.all([loadGroupContext(DEMO_GROUP_ID), upcomingPlanned(DEMO_GROUP_ID)]))).toBe(1);
    expect(await countRoundTrips(() => Promise.all([loadGroupContext(DEMO_GROUP_ID), activeLive(DEMO_GROUP_ID)]))).toBe(1);
  });

  it("loads a WFH vote and its ballots in one round trip", async () => {
    const ctx = await loadGroupContext(DEMO_GROUP_ID);
    expect(await countRoundTrips(() => getWfhState(ctx, weekStartOf(ctx.group.homeTimezone, 1)))).toBe(1);
  });
});
