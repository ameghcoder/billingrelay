import { existsSync } from "node:fs";
import type { NextConfig } from "next";

// Next only reads env files from its own folder; ours is at the repo root. Hosted services set env directly.
const rootEnvFile = "../../.env.local";
if (existsSync(rootEnvFile)) process.loadEnvFile(rootEnvFile);

// `pnpm dev` blocks its own scripts on other hosts, and buyers reach the hosted checkout on the public address.
const publicUrl = process.env.PUBLIC_BASE_URL;
const allowedDevOrigins = publicUrl && URL.canParse(publicUrl) ? [new URL(publicUrl).hostname] : [];

const nextConfig: NextConfig = {
  allowedDevOrigins,
  transpilePackages: ["@billingrelay/core", "@billingrelay/db", "@billingrelay/provider-paypal"],
  // Another site can't frame the admin or the hosted checkout to trick someone into clicking.
  headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default nextConfig;
