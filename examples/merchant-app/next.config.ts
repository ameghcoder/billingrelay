import type { NextConfig } from "next";

const nextConfig: NextConfig = { transpilePackages: ["@billingrelay/sdk", "@billingrelay/core"] };

export default nextConfig;
