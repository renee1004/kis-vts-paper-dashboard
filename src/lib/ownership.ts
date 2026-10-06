import type { VtsOrder, TradingMarket } from "./domain";

export const isPending = (order: VtsOrder) =>
  ["SUBMITTED", "PARTIALLY_FILLED", "UNKNOWN"].includes(order.status);

// KIS returns the same order number zero-padded on order acceptance ("0000038733")
// and unpadded in the overseas fill inquiry ("38733"). Compare numerically.
export const sameKisOrderNo = (a: string | null | undefined, b: string | null | undefined) => {
  const norm = (v: string | null | undefined) => String(v ?? "").replace(/\D/g, "").replace(/^0+(?=\d)/, "");
  return norm(a) !== "" && norm(a) === norm(b);
};

export interface OwnedLot {
  quantity: number; averagePrice: number; priceVerified: boolean;
  positionId: string | null; partialTaken: boolean; stopFraction: number;
}

export function ownedLot(orders: VtsOrder[], market: TradingMarket, stockCode: string): OwnedLot {
  const result: OwnedLot = { quantity: 0, averagePrice: 0, priceVerified: true,
    positionId: null, partialTaken: false, stopFraction: 0.05 };
  const rows = orders.filter((o) => o.market === market && o.stockCode === stockCode &&
    o.ownershipScope === "AGENT_CREATED_ONLY" && o.kisOrderNo && o.filledQuantity > 0)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  for (const order of rows) {
    const quantity = Math.min(order.filledQuantity, order.quantity);
    if (order.side === "BUY") {
      if (result.quantity === 0) {
        result.positionId = order.id;
        result.partialTaken = false;
        result.priceVerified = true;
        result.stopFraction = order.stopFraction ?? 0.05;
      }
      const price = order.averageFillPrice ?? order.referencePrice;
      result.priceVerified = result.priceVerified && (order.averageFillPrice ?? 0) > 0;
      result.averagePrice = (result.averagePrice * result.quantity + price * quantity) / (result.quantity + quantity);
      result.quantity += quantity;
    } else {
      result.quantity = Math.max(0, result.quantity - quantity);
      if (order.exitReason === "TAKE_PROFIT_10") result.partialTaken = true;
      if (result.quantity === 0) {
        result.averagePrice = 0; result.positionId = null; result.partialTaken = false;
      }
    }
  }
  return result;
}

export function sellableQuantity(orders: VtsOrder[], market: TradingMarket, stockCode: string, brokerQuantity: number): number {
  const lot = ownedLot(orders, market, stockCode);
  const reserved = orders.filter((o) => o.market === market && o.stockCode === stockCode &&
    o.side === "SELL" && isPending(o)).reduce((sum, o) => sum + Math.max(0, o.quantity - o.filledQuantity), 0);
  return Math.max(0, Math.min(lot.quantity, brokerQuantity) - reserved);
}
