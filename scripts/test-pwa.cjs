/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
let checks = 0;
const check = (name, run) => {
  run();
  checks += 1;
  console.log("PASS", name);
};

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Compile a Next.js `config.matcher` string into a pathname regex. */
function matcherToRegex(pattern) {
  if (pattern.startsWith("(") || pattern.includes("?!")) {
    throw new Error(`catch-all matcher is not allowed: ${pattern}`);
  }
  let src = "";
  const token = /:([A-Za-z0-9_]+)(\*)?/g;
  let last = 0;
  let match;
  while ((match = token.exec(pattern))) {
    const prefix = pattern.slice(last, match.index);
    if (match[2] === "*") {
      src += prefix.endsWith("/")
        ? `${escapeRegex(prefix.slice(0, -1))}(?:/.*)?`
        : `${escapeRegex(prefix)}(?:/.*)?`;
    } else {
      src += `${escapeRegex(prefix)}[^/]+`;
    }
    last = token.lastIndex;
  }
  src += escapeRegex(pattern.slice(last));
  return new RegExp(`^${src}$`);
}

function parseProxyMatchers(source) {
  const block = source.match(/export const config\s*=\s*\{([\s\S]*?)\};/);
  assert.ok(block, "proxy.ts must export config");
  const matcher = block[1].match(/matcher:\s*\[([^\]]+)\]/);
  assert.ok(matcher, "proxy.ts config must include matcher");
  return [...matcher[1].matchAll(/["']([^"']+)["']/g)].map((item) => item[1]);
}

function pngSize(filePath) {
  const buf = fs.readFileSync(filePath);
  assert.equal(buf.slice(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(buf.toString("ascii", 12, 16), "IHDR");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const proxySource = fs.readFileSync(path.join(root, "src/proxy.ts"), "utf8");
const matchers = parseProxyMatchers(proxySource);
const matcherRes = matchers.map(matcherToRegex);
const matchesProxy = (pathname) => matcherRes.some((re) => re.test(pathname));

const PWA_ASSETS = [
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
];

check("proxy matcher is only /api/:path*", () => {
  assert.deepEqual(matchers, ["/api/:path*"]);
});

check("proxy matcher does not cover PWA install assets", () => {
  for (const asset of PWA_ASSETS) {
    assert.equal(matchesProxy(asset), false, asset);
  }
  assert.equal(matchesProxy("/api/agent/status"), true);
  assert.equal(matchesProxy("/api/auth"), true);
});

check("manifest.ts is a standalone PWA without a service worker", () => {
  const source = fs.readFileSync(path.join(root, "src/app/manifest.ts"), "utf8");
  assert.match(source, /name:\s*["']KIS 모의투자 대시보드["']/);
  assert.match(source, /short_name:\s*["']KIS 모의["']/);
  assert.match(source, /display:\s*["']standalone["']/);
  assert.match(source, /start_url:\s*["']\/["']/);
  assert.match(source, /theme_color:\s*["']#020617["']/);
  assert.match(source, /background_color:\s*["']#f1f5f9["']/);
  assert.match(source, /src:\s*["']\/icon-192\.png["']/);
  assert.match(source, /src:\s*["']\/icon-512\.png["']/);
  assert.equal(/serviceWorker|service-worker|workbox/i.test(source), false);
});

check("root layout advertises iOS home-screen web app metadata", () => {
  const source = fs.readFileSync(path.join(root, "src/app/layout.tsx"), "utf8");
  assert.match(source, /appleWebApp:/);
  assert.match(source, /capable:\s*true/);
  assert.match(source, /title:\s*["']KIS 모의["']/);
  assert.match(source, /statusBarStyle:\s*["']black-translucent["']/);
  assert.match(source, /url:\s*["']\/apple-touch-icon\.png["']/);
  assert.match(source, /viewportFit:\s*["']cover["']/);
  assert.equal(/serviceWorker|navigator\.serviceWorker|workbox/i.test(source), false);
});

check("safe-area padding keeps content out from under the notch", () => {
  const source = fs.readFileSync(path.join(root, "src/app/globals.css"), "utf8");
  assert.match(source, /safe-area-inset-top/);
  assert.match(source, /safe-area-inset-bottom/);
});

check("generated PNG icons are committed at 192, 512, and 180", () => {
  assert.deepEqual(pngSize(path.join(root, "public/icon-192.png")), { width: 192, height: 192 });
  assert.deepEqual(pngSize(path.join(root, "public/icon-512.png")), { width: 512, height: 512 });
  assert.deepEqual(pngSize(path.join(root, "public/apple-touch-icon.png")), { width: 180, height: 180 });
});

check("repo does not register a service worker or offline cache", () => {
  const files = [
    "src/proxy.ts",
    "src/app/layout.tsx",
    "src/app/manifest.ts",
    "next.config.ts",
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.equal(/service[-_]?worker|workbox|offlinecaching|next-pwa/i.test(source), false, file);
  }
  assert.equal(fs.existsSync(path.join(root, "public/sw.js")), false);
  assert.equal(fs.existsSync(path.join(root, "public/service-worker.js")), false);
});

console.log(JSON.stringify({ passed: checks }));
