import "server-only";
import crypto from "node:crypto";
import { TradingMarket, USD_KRW_SAFETY_RATE, VtsOrder, buyNotionalKrw } from "@/lib/domain";
import { KisVtsClient } from "@/lib/kis-vts-client";
import { evaluatePaperOrder } from "@/lib/rule-engine";
import { getOrderDecision } from "@/lib/safety";
import { usMarketDate } from "@/lib/market-hours";
import { addLog, rebuildAgentOwnedPositions, saveState, state } from "@/lib/store";
import { isPending, ownedLot, sellableQuantity } from "@/lib/ownership";
import { exitDecision, sizeForRisk, STRATEGY_VERSION } from "@/lib/strategy";

import { PAPER_CAPITAL_KRW, DAILY_BUY_CAP_KRW, US_ORDER_CAP_USD, marketRiskLimits } from "@/lib/trading-limits";
import { researchBuyNewsBlock } from "@/lib/news-research";
const PRINCIPAL_KRW = PAPER_CAPITAL_KRW;
const DAILY_BUY_CAP = DAILY_BUY_CAP_KRW;
const MAX_POSITIONS = 5;
const kstDate = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10).replaceAll("-", "");
const marketDate = (market: TradingMarket) => market === "US_NASDAQ" ? usMarketDate() : kstDate();
const rate = (market: TradingMarket) => market === "US_NASDAQ" ? USD_KRW_SAFETY_RATE : 1;
const key = (market: TradingMarket, symbol: string) => `${market}:${symbol}`;
const globalExecution = globalThis as typeof globalThis & { __vtsSubmitting?: Set<string> };
const submitting = globalExecution.__vtsSubmitting ??= new Set();

interface ExecuteVtsOrderInput {
  market: TradingMarket; stockCode: string; stockName: string;
  side: "BUY" | "SELL" | "HOLD"; confidence: number; price: number; signalId: string;
  signalDate?: string; stopFraction?: number;
}
export function todayBuyNotional(): number {
  return state.vtsOrders.filter((o) => new Date(new Date(o.timestamp).getTime() + 9 * 3600_000)
    .toISOString().slice(0, 10).replaceAll("-", "") === kstDate())
    .reduce((sum, order) => sum + buyNotionalKrw(order), 0);
}
function persist(order: VtsOrder): VtsOrder {
  if (!state.vtsOrders.some((o) => o.id === order.id)) state.vtsOrders.unshift(order);
  let count = 0;
  state.vtsOrders = state.vtsOrders.filter((o) => o.status !== "BLOCKED" || ++count <= 100);
  saveState(); return order;
}
function makeOrder(input: ExecuteVtsOrderInput, quantity: number): VtsOrder {
  return { id: crypto.randomUUID(), timestamp: new Date().toISOString(), orderDate: marketDate(input.market),
    market: input.market, exchange: input.market === "DOMESTIC" ? "KRX" : "NASD",
    currency: input.market === "DOMESTIC" ? "KRW" : "USD", stockCode: input.stockCode,
    stockName: input.stockName, side: input.side === "SELL" ? "SELL" : "BUY", quantity,
    filledQuantity: 0, referencePrice: input.price, orderType: input.market === "DOMESTIC" ? "MARKET" : "LIMIT",
    status: "UNKNOWN", blockedReason: null, kisOrderNo: null, kisBranchNo: null,
    signalId: input.signalId, sessionId: state.sessionId, ownershipScope: "AGENT_CREATED_ONLY",
    strategyVersion: STRATEGY_VERSION, signalDate: input.signalDate, stopFraction: input.stopFraction };
}
function blocked(input: ExecuteVtsOrderInput, reason: string): VtsOrder {
  state.lastCycleSummary.vtsOrderFailed += 1;
  const order = makeOrder(input, 0); order.status = "BLOCKED"; order.blockedReason = reason;
  return persist(order);
}
function positionFor(input: Pick<ExecuteVtsOrderInput, "market" | "stockCode">) {
  return (input.market === "DOMESTIC" ? state.positions : state.overseasPositions)
    .find((p) => p.stockCode === input.stockCode);
}
function freshBalance(market: TradingMarket): boolean {
  const snapshot = market === "DOMESTIC" ? state.balanceSnapshot : state.overseasBalanceSnapshot;
  const age = Date.now() - Date.parse(snapshot?.syncedAt ?? "");
  return Number.isFinite(age) && age >= 0 && age < 180_000;
}
// Strategy cash flows + marked owned shares. No account deposits or overseas cash inference.
export function strategyValuation(): { pnl: number; committed: number; valid: boolean } {
  let pnl = 0; let committed = 0; let valid = true;
  const quantities = new Map<string, number>();
  for (const order of [...state.vtsOrders].sort((a, b) => a.timestamp.localeCompare(b.timestamp))) {
    if (order.filledQuantity <= 0) continue;
    const symbolKey = key(order.market, order.stockCode);
    const held = quantities.get(symbolKey) ?? 0;
    if (!order.kisOrderNo || (order.side === "SELL" && order.filledQuantity > held)) valid = false;
    quantities.set(symbolKey, Math.max(0, held + (order.side === "BUY" ? 1 : -1) * order.filledQuantity));
    if (!(order.averageFillPrice! > 0)) { valid = false; continue; }
    const value = order.filledQuantity * order.averageFillPrice! * rate(order.market);
    pnl += (order.side === "BUY" ? -value : value) - value * 0.0015; // Estimated cost assumption, not broker fees.
  }
  const symbols = new Map(state.vtsOrders.map((o) => [key(o.market, o.stockCode), o]));
  for (const order of symbols.values()) {
    const lot = ownedLot(state.vtsOrders, order.market, order.stockCode);
    if (!lot.quantity) continue;
    const position = positionFor(order);
    if (!freshBalance(order.market) || !position || position.quantity < lot.quantity || position.currentPrice <= 0) {
      valid = false; continue;
    }
    const value = lot.quantity * position.currentPrice * rate(order.market);
    pnl += value; committed += value;
  }
  committed += state.vtsOrders.filter((o) => o.side === "BUY" && isPending(o))
    .reduce((sum, o) => sum + (o.quantity - o.filledQuantity) * o.referencePrice * rate(o.market), 0);
  return { pnl, committed, valid };
}
function dailyLossExceeded(pnl: number): boolean {
  if (state.strategyRisk.date !== kstDate()) {
    state.strategyRisk = { date: kstDate(), startPnl: pnl }; saveState();
  }
  return pnl - state.strategyRisk.startPnl <= -PRINCIPAL_KRW * 0.02;
}
export async function executeVtsMockOrder(client: KisVtsClient, input: ExecuteVtsOrderInput): Promise<VtsOrder | null> {
  if (input.side === "HOLD") return null;
  const gate = evaluatePaperOrder(input);
  if (!gate.allowed || !state.isRunning) return blocked(input, gate.allowed ? "AGENT_STOPPED" : gate.reason);
  if (!freshBalance(input.market)) return blocked(input, "STALE_BALANCE");
  if (state.vtsOrders.some((o) => o.market === input.market && o.stockCode === input.stockCode && isPending(o))) return blocked(input, "AGENT_ORDER_ALREADY_PENDING");
  const lot = ownedLot(state.vtsOrders, input.market, input.stockCode);
  if (input.side === "SELL") {
    const quantity = sellableQuantity(state.vtsOrders, input.market, input.stockCode, positionFor(input)?.quantity ?? 0);
    return quantity > 0 ? submitOrder(client, input, quantity, "TREND_EXIT", lot.positionId ?? undefined) : blocked(input, "NO_CONFIRMED_AGENT_SHARES");
  }
  if (!input.signalDate || !input.stopFraction) return blocked(input, "MISSING_STRATEGY_CONTEXT");
  if (state.vtsOrders.some((o) => o.status === "UNKNOWN")) return blocked(input, "ORDER_RECONCILIATION_REQUIRED");
  if (lot.quantity > 0 || (positionFor(input)?.quantity ?? 0) > 0) return blocked(input, "NO_PYRAMIDING_OR_MIXED_HOLDINGS");
  if (state.vtsOrders.some((o) => o.market === input.market && o.stockCode === input.stockCode && o.side === "BUY" &&
      o.signalDate === input.signalDate && o.status !== "BLOCKED")) return blocked(input, "SIGNAL_ALREADY_USED");
  if (state.vtsOrders.some((o) => o.market === input.market && o.stockCode === input.stockCode && o.side === "SELL" &&
      o.filledQuantity > 0 && o.orderDate === marketDate(input.market))) return blocked(input, "SAME_DAY_REENTRY_BLOCKED");
  if (/인버스|곱버스|레버리지|3X|2X/i.test(input.stockName)) return blocked(input, "LEVERED_PRODUCT_BLOCKED");
  let usBuyingPower: { amountUsd: number; quantity: number; checkedAt: number } | null = null;
  if (input.market === "US_NASDAQ") {
    try { usBuyingPower = await client.getOverseasBuyingPower(input.stockCode, input.price); }
    catch { return blocked(input, "US_BUYING_POWER_UNVERIFIED"); }
    if (!Number.isFinite(usBuyingPower.checkedAt) || Date.now() - usBuyingPower.checkedAt > 30_000 ||
        Date.now() < usBuyingPower.checkedAt) return blocked(input, "US_BUYING_POWER_STALE");
  }
  // Recheck shared reservations after the asynchronous buying-power lookup.
  if (state.vtsOrders.some((o) => o.status === "UNKNOWN")) return blocked(input, "ORDER_RECONCILIATION_REQUIRED");
  const heldKeys = new Set(state.agentOwnedPositions.filter((p) => p.quantity > 0).map((p) => key(p.market, p.stockCode)));
  for (const order of state.vtsOrders.filter((o) => o.side === "BUY" && isPending(o))) heldKeys.add(key(order.market, order.stockCode));
  if (heldKeys.size >= MAX_POSITIONS) return blocked(input, "MAX_POSITIONS");
  const valuation = strategyValuation();
  if (!valuation.valid) return blocked(input, "STRATEGY_LEDGER_NEEDS_VERIFIED_FILLS");
  if (valuation.pnl <= -PRINCIPAL_KRW * 0.20 || dailyLossExceeded(valuation.pnl)) return blocked(input, "STRATEGY_LOSS_LIMIT");
  let quantity = sizeForRisk({ budget: PRINCIPAL_KRW, price: input.price * rate(input.market), stopFraction: input.stopFraction,
    committed: valuation.committed, dailyRemaining: DAILY_BUY_CAP - todayBuyNotional() }, input.market);
  if (input.market === "DOMESTIC") {
    const pending = state.vtsOrders.filter((o) => o.market === "DOMESTIC" && o.side === "BUY" && isPending(o))
      .reduce((sum, o) => sum + (o.quantity - o.filledQuantity) * o.referencePrice * 1.01, 0);
    quantity = Math.min(quantity, Math.floor(Math.max(0, (state.balanceSnapshot?.cash ?? 0) - pending) / (input.price * 1.01)));
  } else if (usBuyingPower) {
    const pendingUsd = state.vtsOrders.filter((o) => o.market === "US_NASDAQ" && o.side === "BUY" && isPending(o))
      .reduce((sum, o) => sum + (o.quantity - o.filledQuantity) * o.referencePrice * 1.01, 0);
    quantity = Math.min(quantity, usBuyingPower.quantity,
      Math.floor(Math.max(0, usBuyingPower.amountUsd - pendingUsd) / (input.price * 1.01)));
    if (quantity < 1) return blocked(input, "US_ORDERABLE_FUNDS_OR_BUDGET_CAP");
  }
  if (input.side === "BUY") {
    const newsGate = researchBuyNewsBlock(input.market, input.stockCode);
    if (newsGate.block) {
      const detail = newsGate.headline ?? newsGate.reason;
      addLog("SIGNAL", `NEWS_DEFEND ${input.market} ${input.stockCode} ${detail}`, "WARN");
      return blocked(input, "NEWS_DEFEND");
    }
  }
  return quantity > 0 ? submitOrder(client, input, quantity) : blocked(input, "POSITION_OR_DAILY_BUDGET_CAP");
}
export async function enforceRiskExits(client: KisVtsClient): Promise<void> {
  if (!state.isRunning || !state.settings.autoExitEnabled) return;
  const valuation = strategyValuation();
  const kill = valuation.valid && valuation.pnl <= -PRINCIPAL_KRW * 0.20;
  for (const position of [...state.positions, ...state.overseasPositions]) {
    const gate = getOrderDecision(position.market);
    if (!gate.allowed || !freshBalance(position.market)) continue;
    const lot = ownedLot(state.vtsOrders, position.market, position.stockCode);
    const quantity = sellableQuantity(state.vtsOrders, position.market, position.stockCode, position.quantity);
    if (quantity <= 0 || !lot.priceVerified || !lot.positionId) continue;
    if (state.vtsOrders.some((o) => o.market === position.market && o.stockCode === position.stockCode && isPending(o))) continue;
    const decision = kill ? { quantity, reason: "STRATEGY_DRAWDOWN_20" } : exitDecision({ quantity,
      averagePrice: lot.averagePrice, currentPrice: position.currentPrice, stopFraction: lot.stopFraction, partialTaken: lot.partialTaken });
    if (decision) await submitOrder(client, { ...position, side: "SELL", confidence: 100, price: position.currentPrice,
      signalId: `exit-${lot.positionId}-${decision.reason}` }, decision.quantity, decision.reason, lot.positionId);
  }
}
async function submitOrder(client: KisVtsClient, input: ExecuteVtsOrderInput, quantity: number,
  exitReason?: string, positionId?: string): Promise<VtsOrder> {
  const symbolKey = key(input.market, input.stockCode);
  if (submitting.has(symbolKey)) return blocked(input, "ORDER_IN_FLIGHT");
  submitting.add(symbolKey);
  try {
    const gate = getOrderDecision(input.market);
    if (!gate.allowed || !state.isRunning || !freshBalance(input.market)) return blocked(input, "FINAL_SAFETY_GATE");
    if (state.vtsOrders.some((o) => o.market === input.market && o.stockCode === input.stockCode && isPending(o))) return blocked(input, "ORDER_ALREADY_PENDING");
    if (input.side === "SELL") quantity = Math.min(quantity, sellableQuantity(state.vtsOrders, input.market,
      input.stockCode, positionFor(input)?.quantity ?? 0));
    if (!Number.isInteger(quantity) || quantity < 1) return blocked(input, "NO_SELLABLE_QUANTITY");
    const order = makeOrder(input, quantity); order.exitReason = exitReason; order.positionId = positionId;
    persist(order); // Durable intent before network I/O: never blindly retry a timeout/crash.
    try {
      const accepted = input.market === "US_NASDAQ"
        ? await client.submitOverseasMockOrder({ stockCode: input.stockCode, side: order.side, quantity, limitPrice: input.price })
        : await client.submitMockOrder({ stockCode: input.stockCode, side: order.side, quantity });
      order.kisOrderNo = accepted.orderNo; order.kisBranchNo = accepted.branchNo;
      order.status = "SUBMITTED"; state.lastCycleSummary.ordersPlaced += 1;
    } catch (error) {
      const rejected = error instanceof Error && ["KIS_VTS_ORDER_REJECTED", "ORDER_GATE_CLOSED"].includes(error.message);
      order.status = rejected ? "REJECTED" : "UNKNOWN";
      order.blockedReason = rejected ? "KIS_VTS_ORDER_REJECTED" : "CHECK_BROKER_BEFORE_RETRY";
      addLog("RISK", rejected ? "모의주문 거절" : "주문 결과 미확인: 증권사 체결 확인 전 재주문 차단", "WARN");
    }
    return persist(order);
  } finally { submitting.delete(symbolKey); }
}
export async function reconcileAgentOwnedFills(client: KisVtsClient): Promise<void> {
  const groups = new Map<string, VtsOrder[]>();
  for (const order of state.vtsOrders.filter((o) => o.kisOrderNo &&
      (isPending(o) || (o.filledQuantity > 0 && !(o.averageFillPrice! > 0))))) {
    const groupKey = `${order.market}:${order.orderDate}`;
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), order]);
  }
  for (const orders of groups.values()) {
    const first = orders[0];
    const executions = first.market === "DOMESTIC" ? await client.getTodayExecutions(first.orderDate)
      : await client.getOverseasTodayExecutions(first.orderDate);
    for (const order of orders) {
      const execution = executions.find((e) => e.orderDate === order.orderDate && e.orderNo === order.kisOrderNo &&
        e.stockCode === order.stockCode && (!order.kisBranchNo || !e.branchNo || e.branchNo === order.kisBranchNo));
      if (!execution) { order.status = "UNKNOWN"; order.blockedReason = "FILL_NOT_FOUND_REVIEW_REQUIRED"; continue; }
      order.filledQuantity = Math.max(order.filledQuantity, Math.min(order.quantity, execution.filledQuantity));
      if (execution.averageFillPrice > 0) order.averageFillPrice = execution.averageFillPrice;
      order.status = order.filledQuantity >= order.quantity ? "FILLED" : order.orderDate < marketDate(order.market)
        ? "EXPIRED" : order.filledQuantity > 0 ? "PARTIALLY_FILLED" : "SUBMITTED";
      order.blockedReason = null;
    }
    saveState();
  }
  rebuildAgentOwnedPositions(); saveState();
}
export const VTS_ORDER_LIMITS = { maxPositions: MAX_POSITIONS, maxNameFraction: 0.10, firstTrancheFraction: 0.10,
  principalKrw: PRINCIPAL_KRW, dailyBuyCapKrw: DAILY_BUY_CAP, perOrderCapKrw: 300_000, riskPerTradeFraction: 0.005,
  usPerOrderCapUsd: US_ORDER_CAP_USD, usMaxNameFraction: marketRiskLimits("US_NASDAQ").nameFraction,
  usRiskPerTradeFraction: marketRiskLimits("US_NASDAQ").riskFraction,
  usdKrwSafetyRate: USD_KRW_SAFETY_RATE, sellScope: "AGENT_CREATED_ONLY" as const, usOrderType: "LIMIT" as const,
  strategyVersion: STRATEGY_VERSION, validationStatus: "UNVALIDATED_PAPER_ONLY",
  usMarketHours: "America/New_York 09:30-16:00 ET weekdays (not KST)" };
