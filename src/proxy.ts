import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authorizeDashboardRequest, warnIfDashboardTokenUnset } from "@/lib/dashboard-auth";
import { sanitizeApiPayload } from "@/lib/redact";

/**
 * Next.js 16 request middleware (proxy.ts). Gates /api/* with DASHBOARD_TOKEN.
 * Panic buttons (safety-lock, agent stop) and /api/auth stay reachable without a token.
 */
export function proxy(request: NextRequest) {
  warnIfDashboardTokenUnset();
  const decision = authorizeDashboardRequest(request);
  if (decision.ok) return NextResponse.next();
  return NextResponse.json(
    sanitizeApiPayload({ success: false, error: decision.error }),
    { status: decision.status },
  );
}

export const config = {
  matcher: ["/api/:path*"],
};
