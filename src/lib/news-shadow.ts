import { exitDecision, sizeForRisk, type StrategySignal } from "@/lib/strategy";
import { domesticMarketDate, usMarketDate, isDomesticRegularMarketOpen, isUsRegularMarketOpen } from "@/lib/market-hours";
import { targetKey, type NewsAssessment, type NewsTarget } from "@/lib/news-model";

import { PAPER_CAPITAL_KRW, DAILY_BUY_CAP_KRW } from "@/lib/trading-limits";
export const SHADOW_CAPITAL = PAPER_CAPITAL_KRW;
export const SHADOW_FX = 1500;
export const SHADOW_FEE = 0.0015;
export const SHADOW_SLIPPAGE = 0.001;
export interface ShadowLot { quantity: number; averagePriceKrw: number; stopFraction: number; partialTaken: boolean }
export interface ShadowPending {
  side: "BUY" | "SELL"; decidedAt: string; signalKey: string; reason: string;
  evidenceIds: string[]; quantity: number; stopFraction: number; partial: boolean;
  referencePriceKrw: number;
}
export interface ShadowBook {
  cashKrw: number; positions: Record<string, ShadowLot>; pending: Record<string, ShadowPending>;
  marks: Record<string, { priceKrw: number; at: string }>;
  usedBuySignals: Record<string, string>; lastSoldSession: Record<string, string>;
  dailyBuy: { date: string; notionalKrw: number };
  fills: number; closedLots: number; feesKrw: number; peakNavKrw: number; maxDrawdownPct: number;
  lastEvent: string;
}
export interface ResearchObservation {
  target: NewsTarget; price: number; previousClose: number; at: string;
  signal: StrategySignal; news: NewsAssessment;
}
export function emptyBook(): ShadowBook {
  return { cashKrw: SHADOW_CAPITAL, positions: {}, pending: {}, marks: {}, usedBuySignals: {}, lastSoldSession: {},
    dailyBuy: { date: "", notionalKrw: 0 }, fills: 0, closedLots: 0, feesKrw: 0,
    peakNavKrw: SHADOW_CAPITAL, maxDrawdownPct: 0, lastEvent: "아직 가상 체결 없음" };
}
export function bookSummary(book: ShadowBook, now: number = Date.now()) {
  const lots = Object.entries(book.positions);
  const missingMarks = lots.some(([key]) => !book.marks[key]);
  const navKrw = missingMarks ? null : book.cashKrw + lots.reduce((sum, [key, lot]) => sum + lot.quantity * book.marks[key].priceKrw, 0);
  return { navKrw, returnPct: navKrw == null ? null : (navKrw / SHADOW_CAPITAL - 1) * 100,
    cashKrw: book.cashKrw, holdings: lots.length, fills: book.fills, closedLots: book.closedLots,
    feesKrw: book.feesKrw, maxDrawdownPct: book.maxDrawdownPct, pending: Object.keys(book.pending).length,
    staleMarks: lots.filter(([key]) => !book.marks[key] || now - Date.parse(book.marks[key].at) > 15 * 60_000).length,
    lastEvent: book.lastEvent };
}
/** Local hypothetical fills only. This module has no broker client or order transport. */
export function advanceShadow(book: ShadowBook, observation: ResearchObservation, mode: "price" | "news"): string[] {
  const { target, signal, news, at, previousClose } = observation;
  const now = Date.parse(at), key = targetKey(target);
  const events: string[] = [];
  if (!Number.isFinite(now) || !Number.isFinite(observation.price) || observation.price <= 0 ||
      (book.marks[key] && Date.parse(book.marks[key].at) >= now)) return events;
  const priceKrw = observation.price * (target.market === "US_NASDAQ" ? SHADOW_FX : 1);
  const date = signal.signalDate;
  const candleAge = date && /^\d{8}$/.test(date) ? (now - Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T00:00:00Z`)) / 86400_000 : Infinity;
  const validCandles = candleAge >= 0 && candleAge <= 7;
  const session = target.market === "US_NASDAQ" ? usMarketDate(new Date(now)) : domesticMarketDate(new Date(now));
  const open = target.market === "US_NASDAQ" ? isUsRegularMarketOpen(new Date(now)) : isDomesticRegularMarketOpen(new Date(now));
  book.marks[key] = { priceKrw, at };
  const krDay = domesticMarketDate(new Date(now));
  if (book.dailyBuy.date !== krDay) book.dailyBuy = { date: krDay, notionalKrw: 0 };
  const pending = book.pending[key];
  if (pending && (now - Date.parse(pending.decidedAt) > 15 * 60_000 || !open)) {
    delete book.pending[key]; events.push("가상 대기 주문 만료·장 마감 취소");
  } else if (pending && now - Date.parse(pending.decidedAt) >= 30_000) {
    delete book.pending[key];
    const executionPrice = priceKrw * (1 + (pending.side === "BUY" ? SHADOW_SLIPPAGE : -SHADOW_SLIPPAGE));
    const lot = book.positions[key];
    if (pending.side === "BUY") {
      const exposure = Object.entries(book.positions).reduce((sum, [k, p]) => sum + p.quantity * (book.marks[k]?.priceKrw ?? p.averagePriceKrw), 0);
      const stale = bookSummary(book, now).staleMarks > 0;
      const currentAllowsBuy = validCandles && (mode === "price" ? signal.side === "BUY" : news.side === "BUY" && news.fresh);
      const quantity = Math.min(pending.quantity, sizeForRisk({ budget: SHADOW_CAPITAL, price: executionPrice,
        stopFraction: pending.stopFraction, committed: exposure, dailyRemaining: DAILY_BUY_CAP_KRW - book.dailyBuy.notionalKrw }, target.market),
        Math.floor(book.cashKrw / (executionPrice * (1 + SHADOW_FEE))));
      if (!lot && !stale && currentAllowsBuy && Object.keys(book.positions).length < 5 && quantity > 0 &&
          Math.abs(priceKrw / pending.referencePriceKrw - 1) <= 0.02 && previousClose > 0 &&
          Math.abs(observation.price / previousClose - 1) <= 0.02) {
        const cost = quantity * executionPrice, fee = cost * SHADOW_FEE;
        book.cashKrw -= cost + fee; book.feesKrw += fee; book.dailyBuy.notionalKrw += cost;
        book.positions[key] = { quantity, averagePriceKrw: executionPrice, stopFraction: pending.stopFraction, partialTaken: false };
        book.fills++; events.push(`가상 BUY ${quantity}주 · ${pending.reason}`);
      } else events.push("가상 매수 취소: 현재 신호·가격·예산·보유 조건 불충족");
    } else if (lot) {
      const quantity = Math.min(lot.quantity, pending.quantity);
      if (quantity > 0) {
        const proceeds = quantity * executionPrice, fee = proceeds * SHADOW_FEE;
        book.cashKrw += proceeds - fee; book.feesKrw += fee; lot.quantity -= quantity; book.fills++;
        if (pending.partial) lot.partialTaken = true;
        if (!lot.quantity) { delete book.positions[key]; book.closedLots++; }
        book.lastSoldSession[key] = session;
        events.push(`가상 SELL ${quantity}주 · ${pending.reason}`);
      }
    }
  }
  const valuation = bookSummary(book, now);
  if (valuation.navKrw != null && !valuation.staleMarks) {
    book.peakNavKrw = Math.max(book.peakNavKrw, valuation.navKrw);
    book.maxDrawdownPct = Math.max(book.maxDrawdownPct, (1 - valuation.navKrw / book.peakNavKrw) * 100);
  }
  if (events.length) book.lastEvent = `${at} ${target.stockName} ${events.at(-1)}`;
  if (!open || book.pending[key]) return events;
  const lot = book.positions[key];
  const risk = lot ? exitDecision({ quantity: lot.quantity, averagePrice: lot.averagePriceKrw,
    currentPrice: priceKrw, stopFraction: lot.stopFraction, partialTaken: lot.partialTaken }) : null;
  const side = risk ? "SELL" : mode === "price" ? signal.side : news.side;
  const reason = risk?.reason ?? (mode === "price" ? signal.reason : news.reason);
  const signalKey = `${session}:${signal.signalDate}:${side}`;
  if (!risk && !validCandles) return events;
  if (side === "BUY" && !lot && book.usedBuySignals[key] !== signalKey && book.lastSoldSession[key] !== session &&
      validCandles && previousClose > 0 && Math.abs(observation.price / previousClose - 1) <= 0.02) {
    const exposure = Object.entries(book.positions).reduce((sum, [k, p]) => sum + p.quantity * (book.marks[k]?.priceKrw ?? p.averagePriceKrw), 0);
    const quantity = sizeForRisk({ budget: SHADOW_CAPITAL, price: priceKrw * (1 + SHADOW_SLIPPAGE), stopFraction: signal.stopFraction,
      committed: exposure, dailyRemaining: DAILY_BUY_CAP_KRW - book.dailyBuy.notionalKrw }, target.market);
    if (quantity > 0 && Object.keys(book.positions).length < 5 && !valuation.staleMarks) {
      book.usedBuySignals[key] = signalKey;
      book.pending[key] = { side, decidedAt: at, signalKey, reason, evidenceIds: mode === "news" ? news.evidenceIds : [], quantity,
        stopFraction: signal.stopFraction, partial: false, referencePriceKrw: priceKrw };
    }
  } else if (side === "SELL" && lot) {
    book.pending[key] = { side, decidedAt: at, signalKey, reason, evidenceIds: mode === "news" ? news.evidenceIds : [],
      quantity: risk?.quantity ?? lot.quantity, stopFraction: lot.stopFraction, partial: risk?.reason === "TAKE_PROFIT_10", referencePriceKrw: priceKrw };
  }
  return events;
}
