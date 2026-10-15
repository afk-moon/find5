import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { postgresJsUrl } from "./url";

const NEON =
  "postgresql://neondb_owner:npg_abc123@ep-cool-darkness-a1b2c3d4-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require";

describe("postgresJsUrl", () => {
  it("drops Neon's channel_binding and keeps sslmode", () => {
    expect(postgresJsUrl(NEON)).toBe(
      "postgresql://neondb_owner:npg_abc123@ep-cool-darkness-a1b2c3d4-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require",
    );
    expect(postgresJsUrl("postgresql://u:p@host/db?channel_binding=require")).toBe("postgresql://u:p@host/db");
  });

  it("leaves other connection strings untouched", () => {
    const supabase = "postgresql://postgres.abc:p%40ss@aws-0-us-east-1.pooler.supabase.com:6543/postgres";
    expect(postgresJsUrl(supabase)).toBe(supabase);
    expect(postgresJsUrl("postgres://localhost/app?sslmode=disable")).toBe("postgres://localhost/app?sslmode=disable");
    expect(postgresJsUrl("not a url")).toBe("not a url");
  });

  it("gives postgres.js TLS without sending channel_binding to the server", async () => {
    const raw = postgres(NEON, { prepare: false });
    expect(raw.options.connection).toHaveProperty("channel_binding", "require"); // what broke the connection

    const sql = postgres(postgresJsUrl(NEON), { prepare: false });
    expect(sql.options.connection).not.toHaveProperty("channel_binding");
    expect(sql.options).toMatchObject({ ssl: "require", user: "neondb_owner", database: "neondb" });
    expect(sql.options.host).toEqual(["ep-cool-darkness-a1b2c3d4-pooler.us-east-1.aws.neon.tech"]);
    await Promise.all([raw.end(), sql.end()]);
  });
});
