import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Embedded Postgres (WASM) for local dev: load it from node_modules at runtime instead of bundling.
  serverExternalPackages: ["@electric-sql/pglite"],
};

export default nextConfig;
