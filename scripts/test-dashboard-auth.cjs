/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createLoader } = require("./lib/load-source.cjs");

const root = path.resolve(__dirname, "..");
const TOKEN = "test-dashboard-token";
let checks = 0;
const check = (name, run) => {
  run();
  checks += 1;
  console.log("PASS", name);
};

delete process.env.DASHBOARD_TOKEN;
const load = createLoader();
const auth = load("src/lib/dashboard-auth.ts");
const redact = load("src/lib/redact.ts");
const loopback = load("src/lib/loopback.ts");

function decision(overrides) {
  return auth.authorizeDashboardApi({
    method: "GET",
    pathname: "/api/agent/status",
    hostHeader: "localhost:3939",
    originHeader: "http://localhost:3939",
    authorizationHeader: null,
    cookieHeader: null,
    secFetchSite: "same-origin",
    ...overrides,
  });
}

check("middleware rejects missing token", () => {
  process.env.DASHBOARD_TOKEN = TOKEN;
  const result = decision({ authorizationHeader: null, cookieHeader: null });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.error, "UNAUTHORIZED");
});

check("middleware rejects wrong token", () => {
  process.env.DASHBOARD_TOKEN = TOKEN;
  const result = decision({ authorizationHeader: "Bearer other-token" });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.error, "UNAUTHORIZED");
});

check("middleware rejects Host-spoofed requests without token", () => {
  process.env.DASHBOARD_TOKEN = TOKEN;
  const result = decision({
    method: "POST",
    pathname: "/api/kis/save-config",
    hostHeader: "localhost:3939",
    originHeader: "http://localhost:3939",
    authorizationHeader: null,
    cookieHeader: null,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.error, "UNAUTHORIZED");
});

check("middleware allows safety-lock without token", () => {
  process.env.DASHBOARD_TOKEN = TOKEN;
  const result = decision({
    method: "POST",
    pathname: "/api/settings/safety-lock",
    authorizationHeader: null,
    cookieHeader: null,
    hostHeader: "192.0.2.10:3939",
    originHeader: null,
  });
  assert.equal(result.ok, true);
});

check("middleware allows agent stop without token", () => {
  process.env.DASHBOARD_TOKEN = TOKEN;
  const result = decision({
    method: "POST",
    pathname: "/api/agent/stop",
    authorizationHeader: null,
    cookieHeader: null,
    hostHeader: "192.0.2.10:3939",
    originHeader: null,
  });
  assert.equal(result.ok, true);
});

check("middleware accepts correct Bearer token", () => {
  process.env.DASHBOARD_TOKEN = TOKEN;
  const result = decision({
    hostHeader: "192.0.2.10:3939",
    originHeader: null,
    authorizationHeader: `Bearer ${TOKEN}`,
  });
  assert.equal(result.ok, true);
  assert.equal(result.warnUnprotectedRemote, false);
});

check("middleware accepts correct HttpOnly cookie token", () => {
  process.env.DASHBOARD_TOKEN = TOKEN;
  const result = decision({
    hostHeader: "192.0.2.10:3939",
    originHeader: null,
    cookieHeader: `${auth.AUTH_COOKIE_NAME}=${encodeURIComponent(TOKEN)}`,
  });
  assert.equal(result.ok, true);
});

check("cookie parser undoes a single encode, not a double encode", () => {
  const token = "abc+/=xyz";
  process.env.DASHBOARD_TOKEN = token;
  const once = decision({
    hostHeader: "192.0.2.10:3939",
    originHeader: null,
    cookieHeader: `${auth.AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
  });
  assert.equal(once.ok, true);
  const twice = decision({
    hostHeader: "192.0.2.10:3939",
    originHeader: null,
    cookieHeader: `${auth.AUTH_COOKIE_NAME}=${encodeURIComponent(encodeURIComponent(token))}`,
  });
  assert.equal(twice.ok, false);
  assert.equal(auth.parseCookieValue(`${auth.AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`, auth.AUTH_COOKIE_NAME), token);
});

check("unset token still allows loopback", () => {
  delete process.env.DASHBOARD_TOKEN;
  const result = decision({ authorizationHeader: null, cookieHeader: null });
  assert.equal(result.ok, true);
  assert.equal(result.warnUnprotectedRemote, true);
});

check("unset token rejects non-loopback API", () => {
  delete process.env.DASHBOARD_TOKEN;
  const result = decision({
    hostHeader: "192.0.2.10:3939",
    originHeader: null,
    authorizationHeader: null,
    cookieHeader: null,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "DASHBOARD_TOKEN_REQUIRED");
});

check("auth bootstrap routes stay public", () => {
  process.env.DASHBOARD_TOKEN = TOKEN;
  assert.equal(decision({ method: "GET", pathname: "/api/auth" }).ok, true);
  assert.equal(decision({ method: "POST", pathname: "/api/auth" }).ok, true);
});

check("cookie attributes are HttpOnly and not Secure (HTTP Tailscale)", () => {
  const cookie = auth.authCookieAttributes();
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.sameSite, "lax");
  assert.equal(cookie.path, "/");
  assert.equal(cookie.secure, false);
});

check("token compare is length-stable and rejects empties", () => {
  process.env.DASHBOARD_TOKEN = TOKEN;
  assert.equal(auth.tokenMatches(TOKEN, TOKEN), true);
  assert.equal(auth.tokenMatches("short", TOKEN), false);
  assert.equal(auth.authenticateToken(""), false);
  assert.equal(auth.authenticateToken(null), false);
});

check("redaction masks 8-digit, 8-2, and 10-digit account-like numbers", () => {
  const text = redact.redactSensitiveText(
    "acct 12345678 product 12345678-01 long 1234567890 keep 1234567 EGW00201",
  );
  assert.equal(text.includes("12345678"), false);
  assert.equal(text.includes("12345678-01"), false);
  assert.equal(text.includes("1234567890"), false);
  assert.equal(text.includes("1234567"), true);
  assert.equal(text.includes("EGW00201"), true);
  assert.equal((text.match(/\[REDACTED\]/g) || []).length, 3);
});

check("lastError and API error text are redacted before JSON", () => {
  const payload = redact.sanitizeApiPayload({
    success: false,
    error: "INVALID_CHECK_ACNO 12345678",
    message: "계좌 12345678-01",
    lastError: {
      msg1: "account 1234567890 rejected",
      probableCauses: ["use 12345678"],
      endpointPath: "/uapi/domestic-stock/v1/foo",
    },
    data: { orderDate: "20261112", stockCode: "005930" },
  });
  assert.equal(payload.error.includes("12345678"), false);
  assert.equal(payload.message.includes("12345678-01"), false);
  assert.equal(payload.lastError.msg1.includes("1234567890"), false);
  assert.equal(payload.lastError.probableCauses[0].includes("12345678"), false);
  assert.equal(payload.data.orderDate, "20261112");
  assert.equal(payload.data.stockCode, "005930");
});

check("next.config has no hardcoded IPs or MagicDNS hosts", () => {
  const source = fs.readFileSync(path.join(root, "next.config.ts"), "utf8");
  assert.equal(/\d{1,3}(?:\.\d{1,3}){3}/.test(source), false);
  assert.equal(/ts\.net/i.test(source), false);
  assert.equal(source.includes("DASHBOARD_ALLOWED_DEV_ORIGINS"), true);
  assert.equal(source.includes("allowedDevOriginsFromEnv"), true);
});

check("proxy.ts is the /api middleware and uses shared auth", () => {
  const source = fs.readFileSync(path.join(root, "src/proxy.ts"), "utf8");
  assert.equal(source.includes("export function proxy"), true);
  assert.equal(source.includes('matcher: ["/api/:path*"]'), true);
  assert.equal(source.includes("authorizeDashboardRequest"), true);
  assert.equal(source.includes("/manifest.webmanifest"), false);
  assert.equal(source.includes("apple-touch-icon"), false);
});

check("gitignore lists encrypted config and key filenames", () => {
  const gitignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
  assert.equal(gitignore.includes("kis-config.enc"), true);
  assert.equal(gitignore.includes("master.key"), true);
  assert.equal(gitignore.includes("*.key"), true);
});

check("env example has empty placeholders only", () => {
  const example = fs.readFileSync(path.join(root, ".env.local.example"), "utf8");
  assert.match(example, /^DASHBOARD_TOKEN=$/m);
  assert.match(example, /^DASHBOARD_ALLOWED_DEV_ORIGINS=$/m);
  assert.equal(/\d{1,3}(?:\.\d{1,3}){3}/.test(example.split("DASHBOARD_ALLOWED_DEV_ORIGINS")[1] ?? ""), false);
});

check("loopback helper still treats localhost as local and LAN as not", () => {
  assert.equal(
    loopback.isLocalRequestHeaders({
      host: "localhost:3939",
      origin: "http://localhost:3939",
      secFetchSite: "same-origin",
    }),
    true,
  );
  assert.equal(
    loopback.isLocalRequestHeaders({
      host: "192.0.2.10:3939",
      origin: null,
      secFetchSite: "none",
    }),
    false,
  );
});

console.log(JSON.stringify({ passed: checks }));
