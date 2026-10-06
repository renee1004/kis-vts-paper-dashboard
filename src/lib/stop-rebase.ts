import type { TradingMarket } from "./domain";

/**
 * Rebased stop for imported positions that were already below their original
 * stop when the agent took ownership. Instead of dumping at the next open, the
 * position gets a fresh hard stop (reference price x 0.95) and a trend exit that
 * may only fire after the opening auction noise (09:30 KST) once the current
 * price is still below the strategy's 20-day average.
 */
export const REBASE_STOP_FRACTION = 0.05;
export const TREND_CONFIRM_AFTER_KST = "09:30";
const TREND_CONFIRM_MINUTES = 9 * 60 + 30;

export interface StopOverride {
  market: TradingMarket; stockCode: string; stockName: string; positionId: string;
  source: string; reason: "IMPORTED_POSITION_ALREADY_BELOW_STOP";
  averagePrice: number; originalStopPrice: number;
  referencePrice: number; referencePriceSource: string; referenceDate: string; referenceAt: string;
  stopFraction: number; stopPrice: number; trendConfirmAfterKst: string; createdAt: string;
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

/** Trend-sell confirmation for rebased positions. Hard stop is handled by exitDecision(stopPrice). */
export function rebasedTrendExitGate(input: { currentPrice: number; trendMa?: number | null; at: Date }):
  { allowed: boolean; reason: string } {
  if (kstMinutes(input.at) < TREND_CONFIRM_MINUTES) return { allowed: false, reason: "REBASED_TREND_WAIT_0930" };
  if (!(input.trendMa && input.trendMa > 0)) return { allowed: false, reason: "REBASED_TREND_MA_MISSING" };
  if (!(input.currentPrice > 0) || input.currentPrice >= input.trendMa) {
    return { allowed: false, reason: "REBASED_TREND_NOT_CONFIRMED" };
  }
  return { allowed: true, reason: "REBASED_TREND_CONFIRMED" };
}