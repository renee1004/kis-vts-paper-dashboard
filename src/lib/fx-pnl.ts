import type { VtsOrder } from "@/lib/domain";
import {
  FX_LIMITS_NOTE,
  FX_UNAVAILABLE_LABEL,
  FX_UNRECORDED_LABEL,
  finitePositive,
  formatFillFxLabel,
  formatUsdKrwDisplay,
  type FxRateStatus,
  type UsdKrwSnapshot,
} from "@/lib/fx-rate";

export const FX_PNL_LABELS = {
  stock: "주가 손익",
  fx: "환차 손익",
  total: "원화 합계",
  unrecorded: FX_UNRECORDED_LABEL,
  unknown: FX_UNAVAILABLE_LABEL,
  limitsNote: FX_LIMITS_NOTE,
} as const;

export interface FxPnlParts {
  stockPnlUsd: number;
  stockPnlKrw: number | null;
  fxPnlKrw: number | null;
  totalKrw: number | null;
}

export interface UsFillLike {
  side: "BUY" | "SELL";
  quantity: number;
  priceUsd: number;
  fxUsdKrw?: number | null;
  fxRateStatus?: FxRateStatus | null;
  stockCode: string;
  stockName?: string;
  at?: string;
}

export interface UsFxPnlRow extends FxPnlParts {
  kind: "OPEN" | "CLOSED";
  stockCode: string;
  stockName: string;
  quantity: number;
  buyPriceUsd: number;
  exitPriceUsd: number;
  buyFx: number | null;
  exitFx: number | null;
  buyFxLabel: string;
  exitFxLabel: string;
  fxNote: string | null;
}

export interface UsFxPnlView {
  labels: typeof FX_PNL_LABELS;
  open: UsFxPnlRow[];
  closed: UsFxPnlRow[];
  totals: FxPnlParts & { complete: boolean };
  currentFx: { rate: number | null; label: string; capturedAt: string | null; source: string };
  limitsUseSafetyRate: 1500;
}

interface OpenBuy {
  quantity: number;
  priceUsd: number;
  fx: number | null;
  fxStatus: FxRateStatus | null;
  stockCode: string;
  stockName: string;
}

function fillFxStatus(fill: { fxUsdKrw?: number | null; fxRateStatus?: FxRateStatus | null }): FxRateStatus | null {
  if (fill.fxRateStatus === "RECORDED" || fill.fxRateStatus === "UNAVAILABLE") return fill.fxRateStatus;
  if (finitePositive(fill.fxUsdKrw)) return "RECORDED";
  return null;
}

function recordedFx(fill: { fxUsdKrw?: number | null; fxRateStatus?: FxRateStatus | null }): number | null {
  return fillFxStatus(fill) === "RECORDED" && finitePositive(fill.fxUsdKrw) ? fill.fxUsdKrw : null;
}

function noteFor(buyStatus: FxRateStatus | null, exitStatus: FxRateStatus | null): string | null {
  if (buyStatus == null || exitStatus == null) return FX_UNRECORDED_LABEL;
  if (buyStatus === "UNAVAILABLE" || exitStatus === "UNAVAILABLE") return FX_UNAVAILABLE_LABEL;
  return null;
}

/**
 * Stock P&L in USD, stock P&L in KRW at the buy rate, and
 * FX P&L = quantity * sellPriceUSD * (sellFx - buyFx).
 */
export function stockAndFxPnl(input: {
  quantity: number;
  buyPriceUsd: number;
  sellPriceUsd: number;
  buyFx: number | null;
  sellFx: number | null;
}): FxPnlParts {
  const stockPnlUsd = input.quantity * (input.sellPriceUsd - input.buyPriceUsd);
  const stockPnlKrw = finitePositive(input.buyFx) ? stockPnlUsd * input.buyFx : null;
  const fxPnlKrw =
    finitePositive(input.buyFx) && finitePositive(input.sellFx)
      ? input.quantity * input.sellPriceUsd * (input.sellFx - input.buyFx)
      : null;
  const totalKrw = stockPnlKrw != null && fxPnlKrw != null ? stockPnlKrw + fxPnlKrw : null;
  return { stockPnlUsd, stockPnlKrw, fxPnlKrw, totalKrw };
}

function rowFromMatch(input: {
  kind: "OPEN" | "CLOSED";
  quantity: number;
  buyPriceUsd: number;
  exitPriceUsd: number;
  buyFx: number | null;
  exitFx: number | null;
  buyStatus: FxRateStatus | null;
  exitStatus: FxRateStatus | null;
  stockCode: string;
  stockName: string;
}): UsFxPnlRow {
  const parts = stockAndFxPnl({
    quantity: input.quantity,
    buyPriceUsd: input.buyPriceUsd,
    sellPriceUsd: input.exitPriceUsd,
    buyFx: input.buyFx,
    sellFx: input.exitFx,
  });
  return {
    ...parts,
    kind: input.kind,
    stockCode: input.stockCode,
    stockName: input.stockName,
    quantity: input.quantity,
    buyPriceUsd: input.buyPriceUsd,
    exitPriceUsd: input.exitPriceUsd,
    buyFx: input.buyFx,
    exitFx: input.exitFx,
    buyFxLabel: formatFillFxLabel({ fxUsdKrw: input.buyFx, fxRateStatus: input.buyStatus ?? undefined }),
    exitFxLabel: formatFillFxLabel({ fxUsdKrw: input.exitFx, fxRateStatus: input.exitStatus ?? undefined }),
    fxNote: noteFor(input.buyStatus, input.exitStatus),
  };
}

function addTotals(rows: UsFxPnlRow[]): FxPnlParts & { complete: boolean } {
  const complete = rows.every((row) => row.stockPnlKrw != null && row.fxPnlKrw != null && row.totalKrw != null);
  const stockPnlUsd = rows.reduce((sum, row) => sum + row.stockPnlUsd, 0);
  if (!complete) {
    return { stockPnlUsd, stockPnlKrw: null, fxPnlKrw: null, totalKrw: null, complete: false };
  }
  return {
    stockPnlUsd,
    stockPnlKrw: rows.reduce((sum, row) => sum + (row.stockPnlKrw ?? 0), 0),
    fxPnlKrw: rows.reduce((sum, row) => sum + (row.fxPnlKrw ?? 0), 0),
    totalKrw: rows.reduce((sum, row) => sum + (row.totalKrw ?? 0), 0),
    complete: true,
  };
}

function emptyView(current: UsdKrwSnapshot): UsFxPnlView {
  return {
    labels: FX_PNL_LABELS,
    open: [],
    closed: [],
    totals: { stockPnlUsd: 0, stockPnlKrw: 0, fxPnlKrw: 0, totalKrw: 0, complete: true },
    currentFx: {
      rate: current.rate,
      label: formatUsdKrwDisplay(current),
      capturedAt: current.capturedAt,
      source: current.source,
    },
    limitsUseSafetyRate: 1500,
  };
}

export function usFxPnlFromFills(
  fills: UsFillLike[],
  marksUsd: Record<string, number>,
  current: UsdKrwSnapshot,
): UsFxPnlView {
  const open: OpenBuy[] = [];
  const closed: UsFxPnlRow[] = [];
  const currentStatus: FxRateStatus | null =
    current.status === "AVAILABLE" && finitePositive(current.rate) ? "RECORDED" : current.status === "UNAVAILABLE" ? "UNAVAILABLE" : null;
  const currentFx = currentStatus === "RECORDED" ? current.rate : null;

  for (const fill of fills) {
    if (!(fill.quantity > 0) || !(fill.priceUsd > 0)) continue;
    if (fill.side === "BUY") {
      open.push({
        quantity: fill.quantity,
        priceUsd: fill.priceUsd,
        fx: recordedFx(fill),
        fxStatus: fillFxStatus(fill),
        stockCode: fill.stockCode,
        stockName: fill.stockName ?? fill.stockCode,
      });
      continue;
    }
    let remaining = fill.quantity;
    const sellFx = recordedFx(fill);
    const sellStatus = fillFxStatus(fill);
    while (remaining > 0 && open.length) {
      const lot = open[0];
      if (lot.stockCode !== fill.stockCode) {
        // Different symbol at head — skip matching across names.
        const idx = open.findIndex((candidate) => candidate.stockCode === fill.stockCode);
        if (idx < 0) break;
        const [matched] = open.splice(idx, 1);
        open.unshift(matched);
        continue;
      }
      const qty = Math.min(remaining, lot.quantity);
      closed.push(rowFromMatch({
        kind: "CLOSED",
        quantity: qty,
        buyPriceUsd: lot.priceUsd,
        exitPriceUsd: fill.priceUsd,
        buyFx: lot.fx,
        exitFx: sellFx,
        buyStatus: lot.fxStatus,
        exitStatus: sellStatus,
        stockCode: lot.stockCode,
        stockName: lot.stockName,
      }));
      lot.quantity -= qty;
      remaining -= qty;
      if (lot.quantity <= 0) open.shift();
    }
  }

  const openRows: UsFxPnlRow[] = [];
  for (const lot of open) {
    const mark = marksUsd[lot.stockCode];
    if (!(mark > 0)) continue;
    openRows.push(rowFromMatch({
      kind: "OPEN",
      quantity: lot.quantity,
      buyPriceUsd: lot.priceUsd,
      exitPriceUsd: mark,
      buyFx: lot.fx,
      exitFx: currentFx,
      buyStatus: lot.fxStatus,
      exitStatus: currentStatus,
      stockCode: lot.stockCode,
      stockName: lot.stockName,
    }));
  }

  const rows = [...closed, ...openRows];
  const view = emptyView(current);
  view.closed = closed;
  view.open = openRows;
  view.totals = rows.length ? addTotals(rows) : view.totals;
  return view;
}

export function usFxPnlFromOrders(
  orders: VtsOrder[],
  marksUsd: Record<string, number>,
  current: UsdKrwSnapshot,
): UsFxPnlView {
  const fills: UsFillLike[] = [...orders]
    .filter((order) => order.market === "US_NASDAQ" && order.filledQuantity > 0 && (order.averageFillPrice ?? 0) > 0)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .map((order) => ({
      side: order.side,
      quantity: Math.min(order.filledQuantity, order.quantity),
      priceUsd: order.averageFillPrice!,
      fxUsdKrw: order.fxUsdKrw,
      fxRateStatus: order.fxRateStatus,
      stockCode: order.stockCode,
      stockName: order.stockName,
      at: order.timestamp,
    }));
  return usFxPnlFromFills(fills, marksUsd, current);
}
