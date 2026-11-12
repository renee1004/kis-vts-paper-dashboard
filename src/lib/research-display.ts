import "server-only";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { MARKET_CALENDAR } from "./market-calendar-data";
import type { TradingMarket } from "./domain";

const root = () => process.env.DATA_DIR || path.join(process.cwd(), ".data");
const MAX_AGE_MS = 4 * 86400_000;
const num = z.number().finite().nullable();

export function dashboardTradingDayStatus(market: TradingMarket, ymd: string): "open" | "closed" | "unknown" {
  if (ymd < MARKET_CALENDAR.from || ymd > MARKET_CALENDAR.through) return "unknown";
  if ((MARKET_CALENDAR.unverifiedDates[market] as readonly string[]).includes(ymd)) return "unknown";
  const sessions = MARKET_CALENDAR.markets[market] as Readonly<Record<string, unknown>>;
  return sessions[ymd] ? "open" : "closed";
}

export const CALENDAR_CHECK_UNAVAILABLE = "calendar mismatch: 대조 실패 (미확인)";

export function formatCalendarMismatch(row: {
  date: string; dashboard: string; calendar: string; reference: string;
}): string {
  return `calendar mismatch: ${row.date} dashboard=${row.dashboard}, ${row.calendar}=${row.reference}`;
}

export function formatResearchPct(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "미확인" : `${value.toFixed(1)}%`;
}

const mismatchSchema = z.object({
  date: z.string(),
  dashboard: z.string(),
  calendar: z.string(),
  reference: z.string(),
  market: z.string().optional(),
  message: z.string().optional(),
});
const calendarSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string(),
  displayOnly: z.boolean().optional(),
  xcalsVersion: z.string().nullable().optional(),
  dashboardCalendarVersion: z.string().optional(),
  window: z.object({ from: z.string(), through: z.string() }).optional(),
  mismatches: z.array(mismatchSchema).default([]),
  errors: z.array(z.string()).optional(),
});
const holdingSchema = z.object({
  market: z.enum(["DOMESTIC", "US_NASDAQ"]),
  stockCode: z.string(),
  stockName: z.string(),
  evaluationKrw: num,
  weightPct: num,
  volatilityPct: num,
  riskContributionPct: num,
  theme: z.string().nullable().optional(),
  bars: z.number().optional(),
});
const groupSchema = z.object({
  theme: z.string(),
  weightPct: num,
  riskContributionPct: num,
});
const riskSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string(),
  displayOnly: z.boolean().optional(),
  usdKrw: z.number().finite().optional(),
  fxSource: z.string().optional(),
  holdings: z.array(holdingSchema).default([]),
  groups: z.array(groupSchema).default([]),
  semiconductorWeightPct: num.optional(),
  semiconductorRiskContributionPct: num.optional(),
  riskSource: z.string().nullable().optional(),
  errors: z.array(z.string()).optional(),
});

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(root(), file), "utf8"));
}
function ageOk(generatedAt: string, now: number): boolean {
  const age = now - Date.parse(generatedAt);
  return Number.isFinite(age) && age >= -60_000 && age <= MAX_AGE_MS;
}

export interface CalendarCrosscheckView {
  generatedAt: string | null;
  stale: boolean;
  unavailable: boolean;
  messages: string[];
  mismatches: z.infer<typeof mismatchSchema>[];
  window: { from: string; through: string } | null;
  xcalsVersion: string | null;
  errors: string[];
}

export function calendarCrosscheckView(now = Date.now()): CalendarCrosscheckView {
  const empty: CalendarCrosscheckView = {
    generatedAt: null, stale: false, unavailable: false, messages: [], mismatches: [],
    window: null, xcalsVersion: null, errors: [],
  };
  try {
    const parsed = calendarSchema.parse(readJson("calendar-crosscheck.json"));
    if (!ageOk(parsed.generatedAt, now)) {
      return { ...empty, generatedAt: parsed.generatedAt, stale: true };
    }
    const mismatches = parsed.mismatches;
    const errors = parsed.errors ?? [];
    const unavailable = errors.length > 0;
    return {
      generatedAt: parsed.generatedAt, stale: false, unavailable, mismatches, errors,
      window: parsed.window ?? null, xcalsVersion: parsed.xcalsVersion ?? null,
      messages: [
        ...(unavailable ? [CALENDAR_CHECK_UNAVAILABLE] : []),
        ...mismatches.map((row) => formatCalendarMismatch(row)),
      ],
    };
  } catch {
    return empty;
  }
}

export interface RiskContributionView {
  generatedAt: string | null;
  stale: boolean;
  usdKrw: number | null;
  fxSource: string | null;
  holdings: z.infer<typeof holdingSchema>[];
  groups: z.infer<typeof groupSchema>[];
  semiconductorWeightPct: number | null;
  semiconductorRiskContributionPct: number | null;
  riskSource: string | null;
}

export function riskContributionView(now = Date.now()): RiskContributionView {
  const empty: RiskContributionView = {
    generatedAt: null, stale: false, usdKrw: null, fxSource: null, holdings: [], groups: [],
    semiconductorWeightPct: null, semiconductorRiskContributionPct: null, riskSource: null,
  };
  try {
    const parsed = riskSchema.parse(readJson("risk-contribution.json"));
    if (!ageOk(parsed.generatedAt, now)) {
      return { ...empty, generatedAt: parsed.generatedAt, stale: true };
    }
    return {
      generatedAt: parsed.generatedAt, stale: false,
      usdKrw: parsed.usdKrw ?? null, fxSource: parsed.fxSource ?? null,
      holdings: parsed.holdings, groups: parsed.groups,
      semiconductorWeightPct: parsed.semiconductorWeightPct ?? null,
      semiconductorRiskContributionPct: parsed.semiconductorRiskContributionPct ?? null,
      riskSource: parsed.riskSource ?? null,
    };
  } catch {
    return empty;
  }
}
