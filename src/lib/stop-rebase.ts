import type { TradingMarket } from "./domain";
import type { DailyBar } from "./strategy";

/**
 * Rebased stop for imported positions that were already below their original
 * stop when the agent took ownership. Instead of dumping at the next open:
 *  - hard stop = reference price x 0.95 (intraday, any time, full position);
 *  - trend exit only on a COMPLETED daily close below the lowest low of the
 *    previous 10 completed trading days; the sell then happens next session.
 * No intraday trend selling for these positions.
 */
export const REBASE_STOP_FRACTION = 0.05;
export const RECENT_LOW_LOOKBACK = 10;
export const REBASED_TREND_RULE = "DAILY_CLOSE_BELOW_PREV_10D_LOW_SELL_NEXT_SESSION";

export interface CloseEvaluation {
  date: string; close: number; recentLow: number; windowStart: string; windowEnd: string;
  breakdown: boolean; evaluatedAt: string;
}

export interface StopOverride {
  market: TradingMarket; stockCode: string; stockName: string; positionId: string;
  source: string; reason: "IMPORTED_POSITION_ALREADY_BELOW_STOP";
  averagePrice: number; originalStopPrice: number;
  referencePrice: number; referencePriceSource: string; referenceDate: string; referenceAt: string;
  stopFraction: number; stopPrice: number; createdAt: string;
  trendExitRule?: string;
  /** Legacy field from the superseded 09:30 / 20-day-line rule (9478e36). Not used. */
  trendConfirmAfterKst?: string;
  lastCloseEvaluation?: CloseEvaluation;
  /** Set once a completed close broke the recent low; the exit sells at the next open session. */
  trendExitSignal?: CloseEvaluation;
  lastStopEvaluation?: string; lastTrendEvaluation?: string; lastEvaluatedAt?: string;
}

export function kstMinutes(at: Date): number {
  const kst = new Date(at.getTime() + 9 * 3600_000);
  return kst.getUTCHours() * 60 + kst.getUTCMinutes();
}

export function rebasedStopPrice(referencePrice: number): number {
  return Math.round(referencePrice * (1 - REBASE_STOP_FRACTION) * 100) / 100;
}

export function findStopOverride(list: StopOverride[] | undefined, market: TradingMarket, stockCode: string,
  positionId: string | null | undefined): StopOverride | undefined {
  if (!positionId) return undefined;
  return (list ?? []).find((o) => o.market === market && o.stockCode === stockCode && o.positionId === positionId);
}

/** Lowest daily low of the `lookback` completed bars before index `end` (exclusive). */
export function recentLow(bars: DailyBar[], end: number, lookback = RECENT_LOW_LOOKBACK):
  { low: number; windowStart: string; windowEnd: string } | null {
  const window = bars.slice(Math.max(0, end - lookback), end);
  if (window.length < lookback || window.some((bar) => !(bar.low && bar.low > 0))) return null;
  return { low: Math.min(...window.map((bar) => bar.low as number)), windowStart: window[0].date, windowEnd: window[window.length - 1].date };
}

/** Evaluates the latest bar of `completedBars` (caller must exclude today's partial bar). */
export function closeBreakdown(completedBars: DailyBar[], at: Date): CloseEvaluation | null {
  const last = completedBars[completedBars.length - 1];
  if (!last || !(last.close > 0)) return null;
  const window = recentLow(completedBars, completedBars.length - 1);
  if (!window) return null;
  return { date: last.date, close: last.close, recentLow: window.low, windowStart: window.windowStart,
    windowEnd: window.windowEnd, breakdown: last.close < window.low, evaluatedAt: at.toISOString() };
}