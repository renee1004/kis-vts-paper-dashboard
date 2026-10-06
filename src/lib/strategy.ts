/** A predeclared paper-trading candidate, not a calibrated probability model. */
import type { TradingMarket } from "@/lib/domain";
import { marketRiskLimits } from "@/lib/trading-limits";
export const STRATEGY_VERSION = "trend-breakout-v2-capital30m-unvalidated";
export interface DailyBar { date: string; close: number; low?: number }
export interface StrategySignal {
  side: "BUY" | "SELL" | "HOLD";
  confidence: number; buyScore: number; sellScore: number;
  reason: string; signalDate: string | null; stopFraction: number;
  /** 20-day mean of completed closes (the trend line the SELL rule compares against). */
  trendMa?: number;
}

export function completedBars(bars: DailyBar[], marketDate: string): DailyBar[] {
  const rows = new Map<string, DailyBar>();
  for (const bar of bars) {
    if (/^\d{8}$/.test(bar.date) && bar.date < marketDate &&
        Number.isFinite(bar.close) && bar.close > 0) rows.set(bar.date, bar);
  }
  return [...rows.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function analyzeTrend(bars: DailyBar[]): StrategySignal {
  const result: StrategySignal = {
    side: "HOLD", confidence: 0, buyScore: 0, sellScore: 0,
    reason: "완료된 일봉 65개 필요", signalDate: bars.at(-1)?.date ?? null, stopFraction: 0.05,
  };
  if (bars.length < 65 || bars.some((bar, i) => !Number.isFinite(bar.close) ||
      bar.close <= 0 || (i > 0 && bar.date <= bars[i - 1].date))) return result;
  const closes = bars.map((bar) => bar.close);
  const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
  const last = closes.at(-1)!;
  const fast = mean(closes.slice(-20));
  result.trendMa = fast;
  const slow = mean(closes.slice(-60));
  const previousSlow = mean(closes.slice(-65, -5));
  const breakout = Math.max(...closes.slice(-21, -1));
  const returns = closes.slice(-21).slice(1).map((price, i) => price / closes[closes.length - 21 + i] - 1);
  const averageReturn = mean(returns);
  const volatility = Math.sqrt(mean(returns.map((r) => (r - averageReturn) ** 2)));
  result.stopFraction = Math.min(0.08, Math.max(0.03, volatility * 2));
  if (last < fast) return { ...result, side: "SELL", confidence: 100, sellScore: 100, reason: "종가가 20일 평균 아래로 하락" };
  const trend = last > fast && fast > slow && slow > previousSlow;
  const notExtended = last / fast <= 1.10;
  const acceptableVolatility = volatility <= 0.04;
  result.buyScore = [trend, last > breakout, notExtended, acceptableVolatility].filter(Boolean).length * 25;
  result.confidence = result.buyScore;
  if (trend && last > breakout && notExtended && acceptableVolatility) {
    return { ...result, side: "BUY", reason: "상승 추세·20일 종가 돌파·과열/변동성 조건 충족" };
  }
  return { ...result, reason: "추세·돌파·과열·변동성 조건 대기" };
}

export function exitDecision(input: {
  quantity: number; averagePrice: number; currentPrice: number;
  stopFraction: number; partialTaken: boolean;
  /** Absolute rebased hard stop; replaces the average-cost stop when set. */
  stopPrice?: number;
}): { quantity: number; reason: string } | null {
  if (input.quantity < 1 || input.averagePrice <= 0 || input.currentPrice <= 0) return null;
  if (input.stopPrice && input.stopPrice > 0) {
    if (input.currentPrice <= input.stopPrice) return { quantity: input.quantity, reason: "REBASED_HARD_STOP" };
  } else if (input.currentPrice <= input.averagePrice * (1 - input.stopFraction)) return { quantity: input.quantity, reason: "VOLATILITY_STOP" };
  if (input.currentPrice >= input.averagePrice * 1.20) return { quantity: input.quantity, reason: "TAKE_PROFIT_20" };
  if (input.currentPrice >= input.averagePrice * 1.10 - 1e-10 && input.quantity >= 2 && !input.partialTaken) {
    return { quantity: Math.floor(input.quantity / 2), reason: "TAKE_PROFIT_10" };
  }
  return null;
}

export function sizeForRisk(input: {
  budget: number; price: number; stopFraction: number; committed: number; dailyRemaining: number;
}, market?: TradingMarket): number {
  if (Object.values(input).some((v) => !Number.isFinite(v)) || input.price <= 0 ||
      input.stopFraction < 0.03 || input.budget <= 0) return 0;
  // Calls without a market preserve the prior historical research assumptions.
  const limits = marketRiskLimits(market ?? "DOMESTIC");
  const notional = Math.min(input.budget * limits.riskFraction / input.stopFraction,
    input.budget * limits.nameFraction, input.budget * 0.50 - input.committed,
    input.dailyRemaining, limits.orderCapKrw);
  return Math.max(0, Math.floor(notional / input.price));
}
