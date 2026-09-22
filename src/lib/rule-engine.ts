import "server-only";

import { TradingMarket } from "@/lib/domain";
import { getOrderDecision } from "@/lib/safety";

export interface SignalDecisionInput {
  market: TradingMarket;
  side: "BUY" | "SELL" | "HOLD";
  confidence: number;
  price: number;
}

export function evaluatePaperOrder(input: SignalDecisionInput): {
  allowed: boolean;
  reason: string;
} {
  if (input.side === "HOLD") return { allowed: false, reason: "HOLD_SIGNAL" };
  if (!Number.isFinite(input.confidence)) return { allowed: false, reason: "INVALID_SCORE" };
  if (input.side === "BUY" && input.confidence < 100) {
    return { allowed: false, reason: "STRATEGY_CONDITIONS_NOT_MET" };
  }
  if (input.confidence < 70) return { allowed: false, reason: "LOW_CONFIDENCE" };
  if (!Number.isFinite(input.price) || input.price <= 0) {
    return { allowed: false, reason: "INVALID_PRICE" };
  }
  return getOrderDecision(input.market);
}
