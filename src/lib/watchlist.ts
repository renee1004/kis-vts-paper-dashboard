import "server-only";

import crypto from "node:crypto";
import type { TradingMarket, WatchlistItem, WatchlistSource } from "@/lib/domain";
import { state } from "@/lib/store";

/** US symbols are NASDAQ-only: quotes use EXCD=NAS and VTS orders use OVRS_EXCG_CD=NASD. */
export const US_EXCHANGE = "NAS" as const;
export const MAX_WATCHLIST_PER_MARKET = 30;

export function normalizeSymbol(market: TradingMarket, raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toUpperCase();
  if (market === "DOMESTIC") return /^\d{6}$/.test(value) ? value : null;
  return /^[A-Z]{1,5}$/.test(value) ? value : null;
}

export function normalizeName(raw: unknown, fallback: string): string {
  const value = typeof raw === "string" ? raw.replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 40) : "";
  return value || fallback;
}

export function listFor(market: TradingMarket): WatchlistItem[] {
  return market === "DOMESTIC" ? state.watchlist : state.usWatchlist;
}

export function findWatchlistItem(market: TradingMarket, stockCode: string): WatchlistItem | undefined {
  return listFor(market).find((item) => item.stockCode === stockCode);
}

/** Quantity held in the KIS balance or owned by the agent for this symbol. */
export function heldQuantity(market: TradingMarket, stockCode: string): number {
  const balance = (market === "DOMESTIC" ? state.positions : state.overseasPositions)
    .filter((p) => p.stockCode === stockCode)
    .reduce((sum, p) => sum + (p.quantity ?? 0), 0);
  const owned = state.agentOwnedPositions
    .filter((p) => p.market === market && p.stockCode === stockCode)
    .reduce((sum, p) => sum + (p.quantity ?? 0), 0);
  return Math.max(balance, owned);
}

export function createWatchlistItem(input: {
  market: TradingMarket; stockCode: string; stockName: string; source: WatchlistSource; currentPrice?: number | null;
}): WatchlistItem {
  return {
    id: crypto.randomUUID(),
    market: input.market,
    stockCode: input.stockCode,
    stockName: input.stockName,
    currency: input.market === "DOMESTIC" ? "KRW" : "USD",
    source: input.source,
    candleStatus: "PENDING",
    priceStatus: input.currentPrice ? "SUCCESS" : "PENDING",
    analysis: "HOLD",
    confidence: 0,
    buyScore: 0,
    sellScore: 0,
    blockedReason: "다음 분석 사이클 대기",
    currentPrice: input.currentPrice ?? null,
  };
}

export type AddResult =
  | { ok: true; created: boolean; item: WatchlistItem }
  | { ok: false; error: "INVALID_SYMBOL" | "WATCHLIST_FULL" };

export function addWatchlistItem(input: {
  market: TradingMarket; stockCode: unknown; stockName?: unknown; source?: WatchlistSource; currentPrice?: number | null;
}): AddResult {
  const stockCode = normalizeSymbol(input.market, input.stockCode);
  if (!stockCode) return { ok: false, error: "INVALID_SYMBOL" };
  const existing = findWatchlistItem(input.market, stockCode);
  if (existing) return { ok: true, created: false, item: existing };
  const list = listFor(input.market);
  if (list.length >= MAX_WATCHLIST_PER_MARKET) return { ok: false, error: "WATCHLIST_FULL" };
  const item = createWatchlistItem({
    market: input.market, stockCode, stockName: normalizeName(input.stockName, stockCode),
    source: input.source ?? "USER", currentPrice: input.currentPrice,
  });
  list.push(item);
  return { ok: true, created: true, item };
}

export type RemoveResult =
  | { ok: true; item: WatchlistItem }
  | { ok: false; error: "INVALID_SYMBOL" | "NOT_FOUND" }
  | { ok: false; error: "HELD_POSITION_CONFIRM_REQUIRED"; heldQuantity: number };

/** Removing a held symbol needs force: stop/take-profit still run, but trend-exit signals stop updating. */
export function removeWatchlistItem(input: { market: TradingMarket; stockCode: unknown; force?: boolean }): RemoveResult {
  const stockCode = normalizeSymbol(input.market, input.stockCode);
  if (!stockCode) return { ok: false, error: "INVALID_SYMBOL" };
  const list = listFor(input.market);
  const index = list.findIndex((item) => item.stockCode === stockCode);
  if (index < 0) return { ok: false, error: "NOT_FOUND" };
  const held = heldQuantity(input.market, stockCode);
  if (held > 0 && !input.force) return { ok: false, error: "HELD_POSITION_CONFIRM_REQUIRED", heldQuantity: held };
  const [item] = list.splice(index, 1);
  return { ok: true, item };
}
