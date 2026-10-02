/** Pure buy gate. News may only block a new BUY. It never chooses a sell. */

export const PRICE_STRATEGY_NEWS_SELL_REASON = "기존 가격 전략의 추세 이탈 매도 유지";

export interface StoredNewsStance {
  newsSide: "BUY" | "SELL" | "HOLD";
  reason: string;
  fresh: boolean;
  at: string | null;
}

export interface NewsBuyVerdict {
  block: boolean;
  blockedReason: "NEWS_DEFEND" | null;
  reason: string;
}

const DEFAULT_MAX_AGE_MS = 3 * 60_000;

/** Block a new BUY only for a fresh bad-news SELL stance. Missing, stale, HOLD, and BUY pass. */
export function newsDefendBuyVerdict(
  stance: StoredNewsStance | null | undefined,
  nowMs: number,
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
): NewsBuyVerdict {
  const allow: NewsBuyVerdict = { block: false, blockedReason: null, reason: "" };
  if (!stance || stance.newsSide !== "SELL" || stance.fresh !== true) return allow;
  // assessNews copies a price-strategy exit onto newsSide. That is not bad news.
  if (stance.reason === PRICE_STRATEGY_NEWS_SELL_REASON) return allow;
  const at = stance.at == null ? Number.NaN : Date.parse(stance.at);
  if (!Number.isFinite(at) || !Number.isFinite(nowMs) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) return allow;
  if (at > nowMs + 5_000 || nowMs - at > maxAgeMs) return allow;
  const reason = stance.reason.trim();
  if (!reason) return allow;
  return { block: true, blockedReason: "NEWS_DEFEND", reason };
}
