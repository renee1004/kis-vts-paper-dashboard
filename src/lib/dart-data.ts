import "server-only";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { TradingMarket } from "@/lib/domain";
import type { DartFinancials, DartFundamentalsView } from "@/lib/scorecard";
import { scoringDartFinancials } from "@/lib/scorecard";

const root = () => process.env.DATA_DIR || path.join(process.cwd(), ".data");
const num = z.number().finite().nullable().optional();
const ymd = z.string().regex(/^\d{8}$/);
const dartSymbolSchema = z.object({
  stockCode: z.string().optional(),
  ok: z.boolean().optional(),
  reason: z.string().nullable().optional(),
  revenue: num, operatingIncome: num, netIncome: num,
  revenueYoyPct: num, operatingIncomeYoyPct: num, netIncomeYoyPct: num,
  debtRatioPct: num, roePct: num,
  asOf: z.string().nullable().optional(),
  reportName: z.string().nullable().optional(),
  source: z.string().optional(),
  earningsDates: z.array(ymd).optional(),
  estimatedNextDate: ymd.nullable().optional(),
  verifiedThrough: ymd.nullable().optional(),
});
const dartSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string(),
  cacheDate: z.string(),
  displayOnly: z.boolean().optional(),
  doesNotAffectOrders: z.boolean().optional(),
  status: z.string(),
  reason: z.string().nullable().optional(),
  symbols: z.record(z.string(), dartSymbolSchema).default({}),
  errors: z.array(z.string()).optional(),
});

const SECRET_QUERY = /(crtfc_key|api[_-]?key|DART_API_KEY)\s*[=:]\s*([^&\s'"]+)/gi;

export function redactDartText(text: string, key = process.env.DART_API_KEY): string {
  let out = String(text ?? "").replace(SECRET_QUERY, "$1=[REDACTED]");
  const secret = typeof key === "string" ? key.trim() : "";
  if (secret && out.includes(secret)) out = out.split(secret).join("[REDACTED]");
  return out;
}

export function kstDate(now = Date.now()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date(now));
}

type DartCache = z.infer<typeof dartSchema>;
let cached: { mtime: number; data: DartCache | null } | null = null;

function load(): DartCache | null {
  const file = path.join(root(), "dart-fundamentals.json");
  let mtime: number;
  try { mtime = fs.statSync(file).mtimeMs; } catch { return null; }
  if (cached?.mtime === mtime) return cached.data;
  try {
    cached = { mtime, data: dartSchema.parse(JSON.parse(fs.readFileSync(file, "utf8"))) };
  } catch {
    cached = { mtime, data: null };
  }
  return cached.data;
}

export interface DartCacheView {
  generatedAt: string | null;
  cacheDate: string | null;
  status: string;
  reason: string;
  stale: boolean;
  symbolCount: number;
  displayOnly: true;
}

const MISSING: DartCacheView = {
  generatedAt: null, cacheDate: null, status: "미확인", reason: "DART 캐시 없음",
  stale: false, symbolCount: 0, displayOnly: true,
};

export function dartCacheView(now = Date.now()): DartCacheView {
  const data = load();
  if (!data) return { ...MISSING };
  const reason = redactDartText(data.reason || (data.status === "ok" ? "" : "DART 조회 실패"));
  const today = kstDate(now);
  if (data.cacheDate !== today) {
    return {
      generatedAt: data.generatedAt, cacheDate: data.cacheDate, status: "미확인",
      reason: `DART 일일 캐시가 오래됨 (${data.cacheDate})`, stale: true,
      symbolCount: 0, displayOnly: true,
    };
  }
  if (data.status !== "ok") {
    return {
      generatedAt: data.generatedAt, cacheDate: data.cacheDate, status: "미확인",
      reason: reason || "DART 조회 실패", stale: false,
      symbolCount: 0, displayOnly: true,
    };
  }
  return {
    generatedAt: data.generatedAt, cacheDate: data.cacheDate, status: "ok",
    reason: reason || "ok", stale: false,
    symbolCount: Object.keys(data.symbols).length, displayOnly: true,
  };
}

function unknownView(reason: string): DartFundamentalsView {
  return { financials: null, reason: redactDartText(reason) };
}

function asFinancials(row: z.infer<typeof dartSymbolSchema>): DartFinancials | null {
  const financials = scoringDartFinancials({
    revenue: row.revenue ?? null, operatingIncome: row.operatingIncome ?? null, netIncome: row.netIncome ?? null,
    revenueYoyPct: row.revenueYoyPct ?? null, operatingIncomeYoyPct: row.operatingIncomeYoyPct ?? null,
    netIncomeYoyPct: row.netIncomeYoyPct ?? null, debtRatioPct: row.debtRatioPct ?? null, roePct: row.roePct ?? null,
    source: row.source || "OPENDART", asOf: row.asOf ?? undefined, reportName: row.reportName ?? undefined,
  });
  if (!financials) return null;
  const known = [financials.revenueYoyPct, financials.operatingIncomeYoyPct, financials.netIncomeYoyPct,
    financials.netIncome, financials.roePct, financials.debtRatioPct].filter((v) => v != null);
  return known.length ? financials : null;
}

/** Fresh daily Open DART row for a symbol, or 미확인 with an explicit reason. Never returns stale numbers. */
export function dartFundamentals(market: TradingMarket, stockCode: string, now = Date.now()): DartFundamentalsView {
  if (market !== "DOMESTIC") return unknownView("DART는 국내 종목만");
  const data = load();
  if (!data) return unknownView("DART 캐시 없음");
  const view = dartCacheView(now);
  if (view.stale) return unknownView(view.reason);
  if (view.status !== "ok") return unknownView(view.reason);
  const row = data.symbols[`DOMESTIC:${stockCode}`];
  if (!row) return unknownView("해당 종목 DART 재무 없음");
  const financials = asFinancials(row);
  if (!financials || row.ok === false)
    return unknownView(redactDartText(row.reason || "DART 재무제표 없음"));
  return { financials, reason: row.reportName ? `${row.reportName} [OPENDART]` : "OPENDART" };
}

export type DartEarningsOverlay = Record<string, { dates: string[]; verifiedThrough: string; source: string }>;

/** Merge into the display event calendar only when today's cache is fresh and has dates. */
export function dartEarningsOverlay(now = Date.now()): DartEarningsOverlay {
  const data = load();
  const view = dartCacheView(now);
  if (!data || view.stale || view.status !== "ok") return {};
  const out: DartEarningsOverlay = {};
  for (const [key, row] of Object.entries(data.symbols)) {
    const dates = [...(row.earningsDates ?? [])];
    if (row.estimatedNextDate && !dates.includes(row.estimatedNextDate)) dates.push(row.estimatedNextDate);
    const verifiedThrough = row.verifiedThrough || dates.slice().sort().at(-1);
    if (!dates.length || !verifiedThrough) continue;
    out[key] = {
      dates: [...new Set(dates)].sort(),
      verifiedThrough,
      source: "auto:opendart",
    };
  }
  return out;
}
