import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  output: "standalone",
  // Phone/LAN access to `next dev`: Next 16 blocks cross-origin dev resources
  // (/_next/*, HMR) by default, so without this the page never hydrates and
  // shows the empty "not configured" SSR state. Hostnames only, dev-only setting.
  allowedDevOrigins: [
    "127.0.0.1",
    "100.104.251.15", // Tailscale IP
    "parkeunae.tailebfead.ts.net", // Tailscale MagicDNS
    "192.168.10.60", // LAN (Windows portproxy)
  ],
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
