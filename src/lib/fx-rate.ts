import fs from "node:fs";
import path from "node:path";
import { USD_KRW_SAFETY_RATE } from "@/lib/domain";

export const FX_CACHE_FILE = "usd-krw-rate.json";
export const FX_CACHE_TTL_MS = 5 * 60_000;
export const USD_KRW_MIN = 800;
export const USD_KRW_MAX = 2_500;
export const FX_UNAVAILABLE_LABEL = "미확인";
export const FX_UNRECORDED_LABEL = "환율 미기록";
export const FX_LIMITS_NOTE =
  `주문 한도·종목 비중은 보수적 1 USD = ${USD_KRW_SAFETY_RATE.toLocaleString("ko-KR")}원 환산을 유지합니다. 최근 24시간 매수 한도는 4,500,000원 고정(원화 절대값)이며 환율에 연동하지 않습니다. 실제 환율은 표시·기록 전용입니다.`;

export type FxRateStatus = "RECORDED" | "UNAVAILABLE";
export type UsdKrwSource =
  | "KIS_OVERSEAS_BALANCE"
  | "DUNAMU"
  | "FRANKFURTER"
  | "NONE";

export interface UsdKrwSnapshot {
  rate: number | null;
  capturedAt: string | null;
  source: UsdKrwSource;
  status: "AVAILABLE" | "UNAVAILABLE";
}

export interface UsFillFxFields {
  market?: string;
  filledQuantity?: number;
  fxUsdKrw?: number;
  fxRateStatus?: FxRateStatus;
  fxCapturedAt?: string;
  fxSource?: UsdKrwSource;
}

const KIS_USD_KRW_KEYS = [
  "frst_bltn_exrt",
  "bass_exrt",
  "thdt_buy_exrt",
  "thdt_sll_exrt",
  "appl_exrt",
  "ovrs_exrt",
  "fx_exrt",
] as const;

const PUBLIC_SOURCES: Array<{
  source: Exclude<UsdKrwSource, "KIS_OVERSEAS_BALANCE" | "NONE">;
  url: string;
  parse: (body: unknown) => number | null;
}> = [
  {
    source: "DUNAMU",
    url: "https://quotation-api-cdn.dunamu.com/v1/forex/recent?codes=FRX.KRWUSD",
    parse: parseDunamuUsdKrw,
  },
  {
    source: "FRANKFURTER",
    url: "https://api.frankfurter.app/latest?from=USD&to=KRW",
    parse: parseFrankfurterUsdKrw,
  },
];

function dataDir(): string {
  return process.env.DATA_DIR || path.join(process.cwd(), ".data");
}

function cachePath(): string {
  return path.join(dataDir(), FX_CACHE_FILE);
}

export function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function parseUsdKrwNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return sanitizeUsdKrw(value);
  if (typeof value !== "string") return null;
  const parsed = Number(value.replace(/,/g, "").trim());
  return sanitizeUsdKrw(parsed);
}

export function sanitizeUsdKrw(rate: number): number | null {
  if (!Number.isFinite(rate) || rate < USD_KRW_MIN || rate > USD_KRW_MAX) return null;
  return rate;
}

function walkObjects(value: unknown, visit: (row: Record<string, unknown>) => void, depth = 0): void {
  if (depth > 4 || value == null) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 40)) walkObjects(item, visit, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  const row = value as Record<string, unknown>;
  visit(row);
  for (const nested of Object.values(row)) {
    if (nested && typeof nested === "object") walkObjects(nested, visit, depth + 1);
  }
}

/** Prefer KIS overseas-balance / present-balance FX fields. Never infers USD_KRW_SAFETY_RATE. */
export function extractUsdKrwFromKisPayload(payload: unknown): number | null {
  let found: number | null = null;
  walkObjects(payload, (row) => {
    if (found != null) return;
    for (const key of KIS_USD_KRW_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(row, key)) continue;
      const rate = parseUsdKrwNumber(row[key]);
      if (rate != null) {
        found = rate;
        return;
      }
    }
  });
  return found;
}

export function parseDunamuUsdKrw(body: unknown): number | null {
  const rows = Array.isArray(body) ? body : [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const code = String(rec.code ?? rec.currencyCode ?? "");
    if (code !== "FRX.KRWUSD" && rec.currencyCode !== "USD") continue;
    const rate = parseUsdKrwNumber(rec.basePrice);
    if (rate != null) return rate;
  }
  return null;
}

export function parseFrankfurterUsdKrw(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  const rates = (body as { rates?: { KRW?: unknown } }).rates;
  return parseUsdKrwNumber(rates?.KRW);
}

export function unavailableUsdKrwSnapshot(at = new Date().toISOString()): UsdKrwSnapshot {
  return { rate: null, capturedAt: at, source: "NONE", status: "UNAVAILABLE" };
}

export function availableUsdKrwSnapshot(
  rate: number,
  source: Exclude<UsdKrwSource, "NONE">,
  capturedAt = new Date().toISOString(),
): UsdKrwSnapshot | null {
  const sanitized = sanitizeUsdKrw(rate);
  if (sanitized == null) return null;
  return { rate: sanitized, capturedAt, source, status: "AVAILABLE" };
}

export function formatUsdKrwDisplay(snapshot: Pick<UsdKrwSnapshot, "rate" | "status"> | null | undefined): string {
  if (!snapshot || snapshot.status !== "AVAILABLE" || !finitePositive(snapshot.rate)) return FX_UNAVAILABLE_LABEL;
  return snapshot.rate.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
}

export function formatFillFxLabel(input: {
  fxUsdKrw?: number | null;
  fxRateStatus?: FxRateStatus | null;
}): string {
  if (input.fxRateStatus == null && !finitePositive(input.fxUsdKrw)) return FX_UNRECORDED_LABEL;
  if (input.fxRateStatus === "UNAVAILABLE" || !finitePositive(input.fxUsdKrw)) return FX_UNAVAILABLE_LABEL;
  return input.fxUsdKrw.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
}

function parseCachedSnapshot(raw: unknown): UsdKrwSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const source = rec.source;
  if (source !== "KIS_OVERSEAS_BALANCE" && source !== "DUNAMU" && source !== "FRANKFURTER" && source !== "NONE") {
    return null;
  }
  const capturedAt = typeof rec.capturedAt === "string" ? rec.capturedAt : null;
  const rate = parseUsdKrwNumber(rec.rate);
  if (rec.status === "AVAILABLE" && rate != null) {
    return { rate, capturedAt, source, status: "AVAILABLE" };
  }
  if (rec.status === "UNAVAILABLE") {
    return { rate: null, capturedAt, source: "NONE", status: "UNAVAILABLE" };
  }
  return null;
}

export function readUsdKrwSnapshot(): UsdKrwSnapshot {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(), "utf8"));
    return parseCachedSnapshot(parsed) ?? unavailableUsdKrwSnapshot();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return unavailableUsdKrwSnapshot();
    }
    return unavailableUsdKrwSnapshot();
  }
}

export function writeUsdKrwSnapshot(snapshot: UsdKrwSnapshot): UsdKrwSnapshot {
  fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  const payload = {
    rate: snapshot.rate,
    capturedAt: snapshot.capturedAt,
    source: snapshot.source,
    status: snapshot.status,
  };
  const file = cachePath();
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(payload), { mode: 0o600 });
  fs.renameSync(temp, file);
  return snapshot;
}

export function recordObservedUsdKrw(
  rate: number,
  source: Exclude<UsdKrwSource, "NONE">,
  capturedAt = new Date().toISOString(),
): UsdKrwSnapshot | null {
  const snapshot = availableUsdKrwSnapshot(rate, source, capturedAt);
  if (!snapshot) return null;
  return writeUsdKrwSnapshot(snapshot);
}

export function cacheAgeMs(snapshot: UsdKrwSnapshot, now = Date.now()): number | null {
  const time = Date.parse(snapshot.capturedAt ?? "");
  if (!Number.isFinite(time) || time > now) return null;
  return now - time;
}

/** True only when the snapshot is AVAILABLE, in range, and younger than FX_CACHE_TTL_MS. */
export function isFreshUsdKrwSnapshot(snapshot: UsdKrwSnapshot, now = Date.now()): boolean {
  if (snapshot.status !== "AVAILABLE" || !finitePositive(snapshot.rate)) return false;
  const age = cacheAgeMs(snapshot, now);
  return age != null && age < FX_CACHE_TTL_MS;
}

/**
 * Current-rate view for display and fill stamping.
 * A stale cache is 미확인 — never a usable fill/current FX — while the file may still hold last-known.
 */
export function usableUsdKrwSnapshot(snapshot: UsdKrwSnapshot, now = Date.now()): UsdKrwSnapshot {
  if (isFreshUsdKrwSnapshot(snapshot, now)) return snapshot;
  return unavailableUsdKrwSnapshot(new Date(now).toISOString());
}

export function currentUsdKrwSnapshot(now = Date.now()): UsdKrwSnapshot {
  return usableUsdKrwSnapshot(readUsdKrwSnapshot(), now);
}

async function fetchPublicUsdKrw(
  fetchImpl: typeof fetch,
  now: number,
): Promise<UsdKrwSnapshot | null> {
  for (const spec of PUBLIC_SOURCES) {
    try {
      const response = await fetchImpl(spec.url, {
        cache: "no-store",
        signal: AbortSignal.timeout(8_000),
        headers: { Accept: "application/json" },
      });
      if (!response.ok) continue;
      const text = await response.text();
      if (text.length > 100_000) continue;
      const rate = spec.parse(JSON.parse(text));
      if (rate == null) continue;
      return availableUsdKrwSnapshot(rate, spec.source, new Date(now).toISOString());
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Display/record FX only. Never returns USD_KRW_SAFETY_RATE as a stand-in.
 * Fresh cache is reused. A failed fetch does not return a stale AVAILABLE snapshot
 * (last-known stays on disk for inspection; current/fill use is 미확인).
 */
export async function refreshUsdKrwRate(options: {
  fetchImpl?: typeof fetch;
  now?: number;
  kisRate?: number | null;
} = {}): Promise<UsdKrwSnapshot> {
  const now = options.now ?? Date.now();
  const kis = options.kisRate == null ? null : availableUsdKrwSnapshot(options.kisRate, "KIS_OVERSEAS_BALANCE", new Date(now).toISOString());
  if (kis) return writeUsdKrwSnapshot(kis);

  const cached = readUsdKrwSnapshot();
  if (isFreshUsdKrwSnapshot(cached, now)) return cached;

  const fetched = await fetchPublicUsdKrw(options.fetchImpl ?? fetch, now);
  if (fetched) return writeUsdKrwSnapshot(fetched);
  if (cached.status === "AVAILABLE" && finitePositive(cached.rate)) {
    return unavailableUsdKrwSnapshot(new Date(now).toISOString());
  }
  return writeUsdKrwSnapshot(unavailableUsdKrwSnapshot(new Date(now).toISOString()));
}

function applyRecordedFx<T extends UsFillFxFields>(
  order: T,
  rate: number,
  snapshot: UsdKrwSnapshot,
  at: string,
): T {
  order.fxUsdKrw = rate;
  order.fxRateStatus = "RECORDED";
  order.fxCapturedAt = snapshot.capturedAt ?? at;
  order.fxSource = snapshot.source;
  return order;
}

/**
 * Stamp USD/KRW on a US fill. Stale snapshots are 미확인, not RECORDED.
 * Later partial fills reweight the recorded rate by fill quantity.
 * UNAVAILABLE may be upgraded to RECORDED when a fresh rate arrives (same-cycle KIS).
 * A RECORDED rate is never replaced by UNAVAILABLE.
 */
export function stampUsFillFx<T extends UsFillFxFields>(
  order: T,
  snapshot: UsdKrwSnapshot,
  options: { now?: number; previousFilledQuantity?: number } = {},
): T {
  if (order.market !== "US_NASDAQ") return order;
  const now = options.now ?? Date.now();
  const at = new Date(now).toISOString();
  const usable = usableUsdKrwSnapshot(snapshot, now);
  const filled = finitePositive(order.filledQuantity) ? order.filledQuantity : 0;
  const previous = options.previousFilledQuantity ?? (
    order.fxRateStatus === "RECORDED" || order.fxRateStatus === "UNAVAILABLE" ? filled : 0
  );
  const delta = Math.max(0, filled - previous);
  const hasFreshRate = usable.status === "AVAILABLE" && finitePositive(usable.rate);

  if (order.fxRateStatus === "RECORDED" && finitePositive(order.fxUsdKrw)) {
    if (delta > 0 && hasFreshRate) {
      const baseQty = previous > 0 ? previous : 0;
      const qty = filled > 0 ? filled : baseQty + delta;
      if (qty > 0) {
        applyRecordedFx(order, (order.fxUsdKrw * baseQty + usable.rate * delta) / qty, usable, at);
      }
    }
    return order;
  }

  if (hasFreshRate) {
    return applyRecordedFx(order, usable.rate, usable, at);
  }
  if (order.fxRateStatus === "UNAVAILABLE") return order;
  order.fxRateStatus = "UNAVAILABLE";
  order.fxCapturedAt = usable.capturedAt ?? at;
  order.fxSource = "NONE";
  return order;
}

