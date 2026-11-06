import { USD_KRW_SAFETY_RATE, type TradingMarket } from "@/lib/domain";

// User-confirmed initial balance of the mock account, not extra allocated cash.
export const INITIAL_ACCOUNT_BALANCE_KRW = 30_000_000;
export const PAPER_CAPITAL_KRW = INITIAL_ACCOUNT_BALANCE_KRW;
export const CAPITAL_BASIS = "USER_CONFIRMED_INITIAL_MOCK_ACCOUNT_BALANCE";
// Must accommodate one authorized USD 3,000 buy at the current fixed FX assumption.
export const DAILY_BUY_CAP_KRW = 3_000 * USD_KRW_SAFETY_RATE;
export const US_ORDER_CAP_USD = 3_000;
export function marketRiskLimits(market: TradingMarket) {
  return market === "US_NASDAQ"
    ? { orderCapKrw: US_ORDER_CAP_USD * USD_KRW_SAFETY_RATE, nameFraction: 0.15, riskFraction: 0.012 }
    : { orderCapKrw: 3_000_000, nameFraction: 0.10, riskFraction: 0.005 };
}
export function parseOverseasBuyingPower(output: Record<string, unknown>) {
  const number = (value: unknown) => typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value.replaceAll(",", "")) : NaN;
  const amountUsd = number(output.ovrs_ord_psbl_amt);
  const quantities = [output.ord_psbl_qty, output.max_ord_psbl_qty].map(number).filter(Number.isFinite);
  const quantity = Math.min(...quantities);
  if (output.tr_crcy_cd !== "USD" || !Number.isFinite(amountUsd) || amountUsd < 0 ||
      !Number.isSafeInteger(quantity) || quantity < 0) throw new Error("US_BUYING_POWER_UNVERIFIED");
  return { amountUsd, quantity };
}

/** Leveraged/inverse product detection (name or well-known US tickers). */
export const LEVERED_NAME_PATTERN = /인버스|곱버스|레버리지|2X|3X|ultra|inverse|leveraged|bear\b|bull 3x/i;
const LEVERED_US_TICKERS = new Set(["TQQQ", "SQQQ", "SOXL", "SOXS", "UPRO", "SPXU", "SPXL", "SPXS", "TNA", "TZA", "QLD", "QID", "SSO", "SDS", "TECL", "TECS", "NVDL", "NVDU", "TSLL", "LABU", "LABD"]);
export function isLeveredProduct(stockCode: string, stockName: string): boolean {
  return LEVERED_NAME_PATTERN.test(stockName) || LEVERED_US_TICKERS.has(stockCode.toUpperCase());
}
/** User-approved band 3–5% of portfolio equity; default 5%. Env can only choose inside the band. */
export const LEVERED_CAP_BAND = { min: 0.03, max: 0.05 } as const;
export function leveredExposureCapFraction(raw = process.env.LEVERED_EXPOSURE_CAP_PCT): number {
  const pct = Number(raw);
  if (!raw || !Number.isFinite(pct)) return LEVERED_CAP_BAND.max;
  return Math.min(LEVERED_CAP_BAND.max, Math.max(LEVERED_CAP_BAND.min, pct / 100));
}
/**
 * Max shares of a levered product this order may buy so total levered exposure (owned + pending,
 * KRW) stays <= cap × equity. 0 means blocked. Never increases a quantity, only caps it.
 */
export function leveredCapQuantity(input: { equityKrw: number; currentLeveredKrw: number; priceKrw: number; requested: number; capFraction?: number }): number {
  const cap = input.capFraction ?? leveredExposureCapFraction();
  if (![input.equityKrw, input.currentLeveredKrw, input.priceKrw, input.requested, cap].every(Number.isFinite) ||
      input.equityKrw <= 0 || input.priceKrw <= 0 || input.requested < 1) return 0;
  const room = cap * input.equityKrw - input.currentLeveredKrw;
  return Math.max(0, Math.min(input.requested, Math.floor(room / input.priceKrw)));
}
