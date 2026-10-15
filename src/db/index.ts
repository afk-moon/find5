import { mkdir } from "node:fs/promises";
import path from "node:path";
import { sql } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "./schema";
import { seedDemo } from "./seed";
import { postgresJsUrl } from "./url";

/**
 * Both drivers expose the same Drizzle query API; we type everything as the PGlite flavor.
 * Local dev: embedded Postgres (PGlite) in .data/pglite, so no database server or account is needed.
 * Deployed: set DATABASE_URL (Supabase, Neon, …) and the same migrations run against it.
 */
export type DB = PgliteDatabase<typeof schema>;

const globalForDb = globalThis as unknown as { __receptionistDb?: Promise<DB> };

export function getDb(): Promise<DB> {
  if (!globalForDb.__receptionistDb) {
    globalForDb.__receptionistDb = init().catch((err) => {
      globalForDb.__receptionistDb = undefined; // retry on the next request
      throw err;
    });
  }
  return globalForDb.__receptionistDb;
}

async function init(): Promise<DB> {
  const migrationsFolder = path.join(process.cwd(), "drizzle");
  let db: DB;

  if (process.env.DATABASE_URL) {
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    const { default: postgres } = await import("postgres");
    const pg = drizzle(postgres(postgresJsUrl(process.env.DATABASE_URL), { prepare: false }), { schema });
    await migrate(pg, { migrationsFolder });
    db = pg as unknown as DB;
  } else {
    if (process.env.VERCEL && process.env.NODE_ENV === "production") {
      // Vercel's filesystem is read-only, so the embedded database can't work there.
      throw new Error(
        "DATABASE_URL is not set. In Vercel, connect a Postgres database to this project (Storage tab), then redeploy.",
      );
    }
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    const dataDir = process.env.PGLITE_DIR ?? path.join(process.cwd(), ".data", "pglite");
    await mkdir(dataDir, { recursive: true });
    db = drizzle(new PGlite(dataDir), { schema });
    await migrate(db, { migrationsFolder });
  }

  const shouldSeed = process.env.DATABASE_URL ? process.env.SEED_DEMO === "1" : process.env.SEED_DEMO !== "0";
  if (shouldSeed) {
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(schema.groups);
    if (count === 0) await seedDemo(db);
  }
  return db;
}
