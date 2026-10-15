/**
 * Connection-string options that are meant for other clients (libpq, Prisma). postgres.js forwards any
 * option it doesn't know to the server as a setting, and the server rejects these ("unrecognized
 * configuration parameter"). Neon's connection strings, including the DATABASE_URL that Vercel adds,
 * end in `channel_binding=require`.
 */
const CLIENT_ONLY_OPTIONS = ["channel_binding", "pgbouncer", "connection_limit", "pool_timeout"];

/**
 * DATABASE_URL with client-only options removed, ready for postgres.js. Encryption still comes from
 * `sslmode` (`sslmode=require`), which is how Neon's docs configure postgres.js.
 */
export function postgresJsUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  const present = CLIENT_ONLY_OPTIONS.filter((option) => url.searchParams.has(option));
  if (!present.length) return raw;
  for (const option of present) url.searchParams.delete(option);
  return url.toString();
}
