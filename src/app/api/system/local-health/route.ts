import { execFileSync } from "node:child_process";
import { NextResponse } from "next/server";
import {
  computeSafetyMode,
  getOrderDecision,
  getPublicKisConfig,
} from "@/lib/safety";
import {
  usMarketStatusLabel,
  usRegularHoursDescriptionKo,
} from "@/lib/market-hours";
import { state } from "@/lib/store";
import { isLocalRequest } from "@/lib/local-request";

export const dynamic = "force-dynamic";

function gitValue(args: string[], fallback: string): string {
  try {
    return execFileSync("git", args, {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 1_000,
    }).trim();
  } catch {
    return fallback;
  }
}

export async function GET(request: Request) {
  const kis = getPublicKisConfig();
  const domesticDecision = getOrderDecision("DOMESTIC");
  const overseasDecision = getOrderDecision("US_NASDAQ");
  const effectiveSafetyMode = computeSafetyMode();

  return NextResponse.json({
    success: true,
    runtime: process.env.NODE_ENV === "production" ? "production" : "local",
    // Remote (phone/LAN/Tailscale) viewers are read-only; see lib/local-request.
    access: { localClient: isLocalRequest(request) },
    database: {
      connected: true,
      provider: "encrypted-local-fallback",
      postgresqlConfigured: Boolean(process.env.DATABASE_URL),
      postgresqlActive: false,
    },
    kis: {
      ...kis,
      lastError: state.lastError,
    },
    safety: {
      ...state.settings,
      effectiveSafetyMode,
      canPlaceDomesticOrderNow: domesticDecision.allowed,
      canPlaceOverseasOrderNow: overseasDecision.allowed,
      domesticOrderBlockedReason: domesticDecision.allowed ? null : domesticDecision.reason,
      overseasOrderBlockedReason: overseasDecision.allowed ? null : overseasDecision.reason,
      usMarketStatus: usMarketStatusLabel(),
      usMarketHoursKo: usRegularHoursDescriptionKo(),
    },
    version: {
      gitCommitSha:
        process.env.VERCEL_GIT_COMMIT_SHA ??
        gitValue(["rev-parse", "--short", "HEAD"], "unknown"),
      gitBranch:
        process.env.VERCEL_GIT_COMMIT_REF ??
        gitValue(["branch", "--show-current"], "unknown"),
    },
  });
}
