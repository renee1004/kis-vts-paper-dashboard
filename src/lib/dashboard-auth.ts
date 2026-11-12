import { createHash, timingSafeEqual } from "node:crypto";
import { isLocalRequestHeaders } from "@/lib/loopback";

export const AUTH_COOKIE_NAME = "dashboard_token";
export const AUTH_COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 30;

export const UNSET_TOKEN_WARNING =
  "DASHBOARD_TOKEN이 없습니다. localhost는 기존처럼 허용되지만 원격 접속은 토큰을 설정하기 전까지 보호되지 않습니다. .env.local에 DASHBOARD_TOKEN을 넣고 재시작하세요.";

const PUBLIC_API: ReadonlyArray<{ method: string; path: string }> = [
  { method: "POST", path: "/api/settings/safety-lock" },
  { method: "POST", path: "/api/agent/stop" },
  { method: "GET", path: "/api/auth" },
  { method: "POST", path: "/api/auth" },
];

export type DashboardAuthInput = {
  method: string;
  pathname: string;
  hostHeader: string | null;
  originHeader: string | null;
  authorizationHeader: string | null;
  cookieHeader: string | null;
  secFetchSite: string | null;
};

export type DashboardAuthDecision =
  | { ok: true; warnUnprotectedRemote: boolean }
  | { ok: false; status: number; error: string };

let unsetTokenWarned = false;

export function readConfiguredDashboardToken(): string {
  return (process.env.DASHBOARD_TOKEN ?? "").trim();
}

export function dashboardTokenConfigured(): boolean {
  return readConfiguredDashboardToken().length > 0;
}

export function warnIfDashboardTokenUnset(log: (message: string) => void = console.warn): void {
  if (dashboardTokenConfigured() || unsetTokenWarned) return;
  unsetTokenWarned = true;
  log(UNSET_TOKEN_WARNING);
}

export function resetDashboardAuthWarningForTests(): void {
  unsetTokenWarned = false;
}

export function authCookieAttributes(): {
  httpOnly: true;
  sameSite: "lax";
  path: "/";
  secure: false;
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: false,
    maxAge: AUTH_COOKIE_MAX_AGE_SEC,
  };
}

export function normalizeApiPath(pathname: string): string {
  if (!pathname) return "/";
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed.length === 0 ? "/" : trimmed;
}

export function isPublicApiRequest(method: string, pathname: string): boolean {
  const path = normalizeApiPath(pathname);
  const verb = method.toUpperCase();
  return PUBLIC_API.some((entry) => entry.method === verb && entry.path === path);
}

export function tokenMatches(provided: string, expected: string): boolean {
  const left = createHash("sha256").update(provided).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

export function parseCookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() !== name) continue;
    const raw = part.slice(idx + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

export function extractProvidedToken(input: {
  authorizationHeader: string | null;
  cookieHeader: string | null;
}): string | null {
  const authorization = input.authorizationHeader;
  if (authorization) {
    const match = /^Bearer\s+(\S+)/i.exec(authorization.trim());
    if (match) return match[1];
  }
  return parseCookieValue(input.cookieHeader, AUTH_COOKIE_NAME);
}

export function authenticateToken(provided: string | null | undefined): boolean {
  const expected = readConfiguredDashboardToken();
  const token = typeof provided === "string" ? provided.trim() : "";
  if (!expected || token === "") return false;
  return tokenMatches(token, expected);
}

export function authorizeDashboardApi(input: DashboardAuthInput): DashboardAuthDecision {
  const pathname = normalizeApiPath(input.pathname);
  if (isPublicApiRequest(input.method, pathname)) {
    return { ok: true, warnUnprotectedRemote: !dashboardTokenConfigured() };
  }

  const expected = readConfiguredDashboardToken();
  if (expected) {
    const provided = extractProvidedToken(input);
    if (provided && tokenMatches(provided, expected)) {
      return { ok: true, warnUnprotectedRemote: false };
    }
    return { ok: false, status: 401, error: "UNAUTHORIZED" };
  }

  const loopback = isLocalRequestHeaders({
    host: input.hostHeader,
    origin: input.originHeader,
    secFetchSite: input.secFetchSite,
  });
  if (loopback) {
    return { ok: true, warnUnprotectedRemote: true };
  }
  return { ok: false, status: 401, error: "DASHBOARD_TOKEN_REQUIRED" };
}

export function authorizeDashboardRequest(request: Request): DashboardAuthDecision {
  const url = new URL(request.url);
  return authorizeDashboardApi({
    method: request.method,
    pathname: url.pathname,
    hostHeader: request.headers.get("host"),
    originHeader: request.headers.get("origin"),
    authorizationHeader: request.headers.get("authorization"),
    cookieHeader: request.headers.get("cookie"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });
}
