import { existsSync } from "node:fs";
import type { NextConfig } from "next";

// Next only reads env files from its own folder; ours is at the repo root. Hosted services set env directly.
const rootEnvFile = "../../.env.local";
if (existsSync(rootEnvFile)) process.loadEnvFile(rootEnvFile);

const nextConfig: NextConfig = {
  transpilePackages: ["@billingrelay/db"],
};

export default nextConfig;
