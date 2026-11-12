import type { NextConfig } from "next";
import path from "node:path";

function allowedDevOriginsFromEnv(): string[] {
  return (process.env.DASHBOARD_ALLOWED_DEV_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

const nextConfig: NextConfig = {
  output: "standalone",
  // Phone/LAN access to `next dev`: Next 16 blocks cross-origin dev resources
  // (/_next/*, HMR) by default, so without this the page never hydrates and
  // shows the empty "not configured" SSR state. Hostnames only, from env.
  allowedDevOrigins: allowedDevOriginsFromEnv(),
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
