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
  blockedReason: "NEWS_DEFEND" | "NEWS_ANALYSIS_UNAVAILABLE" | null;
  reason: string;
}

const DEFAULT_MAX_AGE_MS = 3 * 60_000;

/** A completed, recent news check is required before a new chart-driven BUY.
 * Neutral news is allowed; a headline BUY is not a verified profit forecast.
 */
export function newsCheckedBuyVerdict(
  stance: StoredNewsStance | null | undefined,
  nowMs: number,
): NewsBuyVerdict {
  const at = stance?.at ? Date.parse(stance.at) : NaN;
  if (!stance || !stance.fresh || !stance.reason.trim() || !Number.isFinite(at) || !Number.isFinite(nowMs) ||
      at > nowMs || nowMs - at > DEFAULT_MAX_AGE_MS) {
    return { block: true, blockedReason: "NEWS_ANALYSIS_UNAVAILABLE", reason: "종목 뉴스 분석 누락·실패·지연: 신규 매수 보류" };
  }
  return newsDefendBuyVerdict(stance, nowMs);
}

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
