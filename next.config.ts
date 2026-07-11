import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Prevent better-sqlite3 native addon from being bundled for the client
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
