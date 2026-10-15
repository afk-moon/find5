import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Embedded Postgres (WASM) for local dev: load it from node_modules at runtime instead of bundling.
  serverExternalPackages: ["@electric-sql/pglite"],
  experimental: {
    // Switching back to a tab you opened in the last 30 seconds is instant. Saving anything (server
    // actions revalidate), logging in or out, and the Live tab's auto-refresh still fetch fresh data.
    staleTimes: { dynamic: 30 },
  },
};

export default nextConfig;
