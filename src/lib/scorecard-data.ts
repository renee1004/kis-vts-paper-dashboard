import "server-only";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { TradingMarket } from "@/lib/domain";
import type { DailyBar } from "@/lib/strategy";
import { DECISION_ENGINE_VERSION, LEGACY_DECISION_ENGINE_VERSION, referenceCrudeOil, referencePsr, UNKNOWN_CRUDE_OIL, type CrudeOilReference, type EventCalendar, type FlowsInput, type FundamentalsInput, type MacroInput, type PsrReference } from "@/lib/scorecard";

const root = () => process.env.DATA_DIR || path.join(process.cwd(), ".data");
const num = z.number().finite().nullable();
const cacheSchema = z.object({
  version: z.literal(1), generatedAt: z.string().datetime({ offset: true }),
  symbols: z.record(z.string(), z.object({
    bars: z.array(z.object({ date: z.string().regex(/^\d{8}$/), close: z.number().positive(), low: z.number().positive().optional() })).max(400).default([]),
    fundamentals: z.object({ per: num, pbr: num, marketCapKrw: num, asOf: z.string(), source: z.string().optional() }).nullable().default(null),
    flows: z.object({ foreignNetKrw: num, institutionNetKrw: num, days: z.number().int().positive(), asOf: z.string(), source: z.string().optional() }).nullable().default(null),
    isEtf: z.boolean().optional(),
  })),
  macro: z.object({ vix: num, usdKrwChange20dPct: num, us10yChange20dBp: num, asOf: z.string() }).nullable().default(null),
});
export interface SymbolData { bars: DailyBar[]; fundamentals: FundamentalsInput | null; flows: FlowsInput | null; isEtf: boolean; psr: PsrReference }
const MAX_AGE_MS = 4 * 86400_000;
let cached: { mtime: number; data: z.infer<typeof cacheSchema> | null; raw: unknown } | null = null;
function load() {
  const file = path.join(root(), "scorecard-data.json");
  let mtime: number;
  try { mtime = fs.statSync(file).mtimeMs; } catch { return null; }
  if (cached?.mtime === mtime) return cached;
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    cached = { mtime, data: cacheSchema.parse(raw), raw };
  } catch { cached = { mtime, data: null, raw: null }; }
  return cached;
}
function rawRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
}
function rawSymbolFundamentals(raw: unknown, key: string): unknown {
  const row = rawRecord(rawRecord(raw)?.symbols)?.[key];
  return rawRecord(row)?.fundamentals;
}
/**
 * Scoring cache is parsed with the existing schema (unknown keys stripped). PSR / crude oil
 * are read from the raw JSON separately so a bad reference value cannot invalidate view scores.
 */
export function scorecardData(market: TradingMarket, stockCode: string, now = Date.now()): {
  symbol: SymbolData | null; macro: MacroInput | null; generatedAt: string | null; crudeOil: CrudeOilReference;
} {
  const loaded = load();
  const unknown = { symbol: null, macro: null, generatedAt: null as string | null, crudeOil: { ...UNKNOWN_CRUDE_OIL } };
  if (!loaded?.data) return unknown;
  const data = loaded.data;
  const age = now - Date.parse(data.generatedAt);
  if (!Number.isFinite(age) || age < -60_000 || age > MAX_AGE_MS) return { ...unknown, generatedAt: data.generatedAt };
  const key = `${market}:${stockCode}`;
  const row = data.symbols[key];
  return {
    generatedAt: data.generatedAt, macro: data.macro, crudeOil: referenceCrudeOil(rawRecord(loaded.raw)?.crudeOil),
    symbol: row ? { bars: row.bars, fundamentals: row.fundamentals, flows: row.flows, isEtf: !!row.isEtf,
      psr: referencePsr(rawSymbolFundamentals(loaded.raw, key)) } : null,
  };
}
/** Market-wide WTI reference (KOSPI 선행 가설, 미검증). Stale/missing cache => unknown. */
export function scorecardCrudeOil(now = Date.now()): CrudeOilReference {
  return scorecardData("DOMESTIC", "_", now).crudeOil;
}
/** Universe file for scripts/scorecard-collect.py (codes and names only, no account data). */
export function writeScorecardUniverse(targets: { market: TradingMarket; stockCode: string; stockName: string }[]): void {
  try {
    fs.mkdirSync(root(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(root(), "scorecard-universe.json"), JSON.stringify(targets.map(({ market, stockCode, stockName }) => ({ market, stockCode, stockName }))), { mode: 0o600 });
  } catch { /* collector falls back to CLI args */ }
}
const calendarSchema = z.object({
  fomc: z.object({ verifiedFrom: z.string(), verifiedThrough: z.string(), blackout: z.object({ DOMESTIC: z.array(z.string()), US_NASDAQ: z.array(z.string()) }) }),
  earnings: z.record(z.string(), z.object({ verifiedThrough: z.string(), dates: z.array(z.string()), source: z.string().optional() })),
});
const autoSchema = z.object({ earnings: calendarSchema.shape.earnings });
/** Repo calendar (FOMC + manual earnings) merged over collector auto dates in .data; manual wins. */
export function eventCalendar(): EventCalendar | null {
  let base: EventCalendar;
  try { base = calendarSchema.parse(JSON.parse(fs.readFileSync(path.join(process.cwd(), "data", "event-calendar.json"), "utf8"))); }
  catch { return null; }
  try {
    const auto = autoSchema.parse(JSON.parse(fs.readFileSync(path.join(root(), "event-calendar-auto.json"), "utf8")));
    return { ...base, earnings: { ...auto.earnings, ...base.earnings } };
  } catch { return base; }
}
/**
 * One-time cutover marker: live VTS paper orders switch from the legacy trend signal to the
 * scorecard. Written once (never overwritten) so pre/post records can always be separated.
 */
export function recordDecisionEngineCutover(at = new Date().toISOString()): { version: string; cutoverAt: string; previousVersion: string } {
  const file = path.join(root(), "decision-engine-cutover.json");
  try {
    const existing = JSON.parse(fs.readFileSync(file, "utf8"));
    if (existing?.version === DECISION_ENGINE_VERSION && typeof existing.cutoverAt === "string") return existing;
  } catch { /* create below */ }
  const marker = { version: DECISION_ENGINE_VERSION, cutoverAt: at, previousVersion: LEGACY_DECISION_ENGINE_VERSION,
    note: "Live VTS paper-order decision replaced by 5-perspective scorecard. Orders/performance before cutoverAt belong to previousVersion." };
  try { fs.mkdirSync(root(), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, JSON.stringify(marker, null, 2), { mode: 0o600, flag: "wx" }); }
  catch { /* raced or unwritable; read path below still reports */ }
  return marker;
}
export function decisionEngineCutover(): { version: string; cutoverAt: string; previousVersion: string } | null {
  try { const v = JSON.parse(fs.readFileSync(path.join(root(), "decision-engine-cutover.json"), "utf8")); return typeof v?.cutoverAt === "string" ? v : null; }
  catch { return null; }
}

export type StoredScorecard = import("@/lib/scorecard").Scorecard & {
  at: string; market: TradingMarket; stockCode: string; stockName: string; dataGeneratedAt: string | null;
  technicalDate: string | null; stopFraction: number; levels: import("@/lib/scorecard").TechnicalLevels | null;
  /** Display-only. Never copied into decideScorecard / conclusionToOrderSide. */
  references?: { psr: PsrReference };
};
export type { CrudeOilReference, PsrReference };
const runtimeCards = globalThis as typeof globalThis & { __scorecards?: Map<string, StoredScorecard> };
export function setScorecard(card: StoredScorecard): void {
  (runtimeCards.__scorecards ??= new Map()).set(`${card.market}:${card.stockCode}`, card);
}
export function scorecardsView(): StoredScorecard[] { return [...(runtimeCards.__scorecards?.values() ?? [])]; }
/** Chart series for the panel: completed cached bars with 20/60/200-day moving averages. */
export function chartSeries(market: TradingMarket, stockCode: string) {
  const bars = scorecardData(market, stockCode).symbol?.bars ?? [];
  const closes = bars.map((b) => b.close);
  const ma = (n: number) => bars.map((b, i) => i + 1 >= n ? { date: b.date, value: closes.slice(i + 1 - n, i + 1).reduce((a, c) => a + c, 0) / n } : null)
    .filter((v): v is { date: string; value: number } => !!v);
  return { bars: bars.map((b) => ({ date: b.date, value: b.close })), ma20: ma(20), ma60: ma(60), ma200: ma(200) };
}
