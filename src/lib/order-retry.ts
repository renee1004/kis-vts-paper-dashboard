import type { VtsOrder } from "./domain";

// Confirmed broker refusals must not be resubmitted every analysis cycle.
// This also applies to risk exits: three refusals require operator review.
export function rejectionBlock(orders: VtsOrder[], input: Pick<VtsOrder, "market" | "stockCode" | "side">,
  orderDate: string, now = Date.now()): string | null {
  const rejected = orders.filter(o => o.status === "REJECTED" && o.blockedReason === "KIS_VTS_ORDER_REJECTED" &&
    o.market === input.market && o.stockCode === input.stockCode && o.side === input.side && o.orderDate === orderDate);
  if (rejected.length >= 3) return "BROKER_REJECTION_REVIEW_REQUIRED";
  if (rejected.some(o => !Number.isFinite(Date.parse(o.timestamp)) || now - Date.parse(o.timestamp) < 15 * 60_000)) {
    return "BROKER_REJECTION_COOLDOWN";
  }
  return null;
}
