import { apiJson } from "@/lib/api-response";
import {
  AUTH_COOKIE_NAME,
  authenticateToken,
  authCookieAttributes,
  dashboardTokenConfigured,
  extractProvidedToken,
  readConfiguredDashboardToken,
} from "@/lib/dashboard-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const provided = extractProvidedToken({
    authorizationHeader: request.headers.get("authorization"),
    cookieHeader: request.headers.get("cookie"),
  });
  return apiJson({
    success: true,
    tokenConfigured: dashboardTokenConfigured(),
    authenticated: authenticateToken(provided),
    remoteUnprotected: !dashboardTokenConfigured(),
  });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { token?: unknown } | null;
  const provided = typeof body?.token === "string" ? body.token.trim() : "";
  if (!readConfiguredDashboardToken()) {
    return apiJson(
      { success: false, error: "DASHBOARD_TOKEN_NOT_CONFIGURED" },
      { status: 400 },
    );
  }
  if (!authenticateToken(provided)) {
    return apiJson({ success: false, error: "UNAUTHORIZED" }, { status: 401 });
  }
  const response = apiJson({ success: true });
  response.cookies.set({
    name: AUTH_COOKIE_NAME,
    value: encodeURIComponent(provided),
    ...authCookieAttributes(),
  });
  return response;
}
