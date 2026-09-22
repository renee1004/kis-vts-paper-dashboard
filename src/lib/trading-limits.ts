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
    : { orderCapKrw: 300_000, nameFraction: 0.10, riskFraction: 0.005 };
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
