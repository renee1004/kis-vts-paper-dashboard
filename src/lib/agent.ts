import "server-only";

import { analyzeTrend, completedBars, livePaperOrderIntent, STRATEGY_VERSION, type DailyBar } from "@/lib/strategy";
import { decideScorecard, eventStatus, referencePsr, scoreFlows, scoreFundamentals,
  scoreMacro, scoreNews, scoreTechnical, technicalLevels, UNKNOWN_PSR } from "@/lib/scorecard";
import { eventCalendar, recordDecisionEngineCutover, scorecardData, setScorecard, writeScorecardUniverse } from "@/lib/scorecard-data";
import { ownedLot } from "@/lib/ownership";
import { kisFlows, kisFlowsDue, kisFundamentals, noteKisFlowsFailure, setKisFlows } from "@/lib/kis-quote-cache";
import { domesticMarketDate, usMarketDate } from "@/lib/market-hours";
import { USD_KRW_SAFETY_RATE } from "@/lib/domain";
import { EMPTY_CYCLE_SUMMARY, WatchlistItem } from "@/lib/domain";
import {
  KisVtsClient,
  toBalanceSnapshot,
  toOverseasBalanceSnapshot,
} from "@/lib/kis-vts-client";
import {
  addLog,
  saveState,
  setBalanceSnapshot,
  setOverseasBalanceSnapshot,
  state,
} from "@/lib/store";
import { enforceRiskExits, evaluateRebasedTrend, executeVtsMockOrder, reconcileAgentOwnedFills, strategyValuation, VTS_ORDER_LIMITS } from "@/lib/vts-execution";
import { recordPerformance } from "@/lib/performance-history";
import { marketRiskLimits, PAPER_CAPITAL_KRW } from "@/lib/trading-limits";
import { observeResearch, refreshResearchNews, researchHeadlinesFor } from "@/lib/news-research";

const globalAgent = globalThis as typeof globalThis & {
  __vtsAgentTimer?: ReturnType<typeof setInterval>;
  __vtsAgentRunningCycle?: boolean;
};

async function analyzeWatchlistItem(
  client: KisVtsClient,
  item: WatchlistItem,
): Promise<void> {
  if (!item.stockCode) return;

  const isUs = item.market === "US_NASDAQ";
  if (isUs) {
    state.lastCycleSummary.usStocksAnalyzed += 1;
  } else {
    state.lastCycleSummary.stocksAnalyzed += 1;
  }

  let price: number | null = null;
  let priceObservedAt: string | null = null;
  let bars: DailyBar[] = [];

  try {
    price = isUs
      ? await client.getOverseasPrice(item.stockCode)
      : await client.getPrice(item.stockCode);
    item.currentPrice = price;
    priceObservedAt = new Date().toISOString();
    item.priceStatus = "SUCCESS";
  } catch {
    item.priceStatus = "FAILED";
  }

  try {
    bars = isUs
      ? await client.getOverseasDailyBars(item.stockCode)
      : await client.getDailyBars(item.stockCode);
    item.candleStatus = bars.length >= 65 ? "SUCCESS" : "FAILED";
  } catch {
    item.candleStatus = "FAILED";
  }

  const signal = analyzeTrend(bars);
  if (price && priceObservedAt && Date.now() - Date.parse(priceObservedAt) <= 30_000) {
    try {
      observeResearch({ target: { market: item.market, stockCode: item.stockCode, stockName: item.stockName },
        universe: [...state.watchlist, ...state.usWatchlist], signal, price,
        previousClose: bars.at(-1)?.close ?? 0, at: priceObservedAt });
    } catch {
      addLog("ERROR", "뉴스 가상 비교 기록 실패. 뉴스 화면의 저장 상태를 확인하세요.", "WARN");
    }
  }
  item.analysis = signal.side;
  item.trendMa = signal.trendMa ?? null;
  if (!isUs && item.candleStatus === "SUCCESS") {
    try { evaluateRebasedTrend(item, bars); } catch { addLog("RISK", "재설정 손절 일봉 평가 실패", "WARN"); }
  }
  item.confidence = signal.confidence;
  item.buyScore = signal.buyScore;
  item.sellScore = signal.sellScore;
  item.blockedReason =
    signal.side === "HOLD" ? signal.reason : "Rule Engine 검증 대기";
  state.lastCycleSummary.signalsGenerated += 1;

  // Scorecard + reference indicators are display/research only and must not
  // change order side, quantity, or whether a paper order is submitted.
  try {
    if (!isUs && kisFlowsDue(item.stockCode)) {
      try { setKisFlows(item.stockCode, { ...(await client.getInvestorFlows(item.stockCode)), at: new Date().toISOString() }); }
      catch { noteKisFlowsFailure(item.stockCode); } // falls back to Naver/pykrx cache
    }
    buildScorecard(item, price, bars);
  } catch {
    addLog("ERROR", "점수판 표시 갱신 실패. 모의주문은 추세 돌파 신호를 사용합니다.", "WARN");
  }

  const intent = livePaperOrderIntent(signal);
  if (price && intent.side !== "HOLD") {
    const lastDate = bars.at(-1)?.date ?? "";
    const ageDays = lastDate ? (Date.now() - Date.parse(lastDate.slice(0, 4) + "-" + lastDate.slice(4, 6) + "-" + lastDate.slice(6, 8) + "T00:00:00Z")) / 86400_000 : Infinity;
    if (ageDays > 7 || (intent.side === "BUY" && Math.abs(price / bars.at(-1)!.close - 1) > 0.02)) {
      item.blockedReason = "STALE_CANDLES_OR_ENTRY_GAP"; return;
    }
    const signalId = [STRATEGY_VERSION, item.market, item.stockCode, lastDate, intent.side].join(":");
    const order = await executeVtsMockOrder(client, {
      market: item.market,
      stockCode: item.stockCode,
      stockName: item.stockName,
      side: intent.side,
      confidence: intent.confidence,
      price,
      signalId,
      signalDate: intent.signalDate ?? undefined,
      stopFraction: intent.stopFraction,
      trendMa: intent.trendMa,
    });
    item.blockedReason = order?.blockedReason ?? "";
  }
}

function buildScorecard(item: WatchlistItem, price: number | null, kisBars: DailyBar[]) {
  const universe = [...state.watchlist, ...state.usWatchlist];
  const target = { market: item.market, stockCode: item.stockCode, stockName: item.stockName };
  const data = scorecardData(item.market, item.stockCode);
  const marketDate = item.market === "US_NASDAQ" ? usMarketDate() : domesticMarketDate();
  const cacheBars = completedBars(data.symbol?.bars ?? [], marketDate);
  const technicalBars = cacheBars.length >= 200 ? cacheBars : completedBars(kisBars, marketDate);
  const technical = technicalLevels(technicalBars);
  const lot = ownedLot(state.vtsOrders, item.market, item.stockCode);
  const limits = marketRiskLimits(item.market);
  const fx = item.market === "US_NASDAQ" ? USD_KRW_SAFETY_RATE : 1;
  const kisFund = item.market === "DOMESTIC" && !data.symbol?.isEtf ? kisFundamentals(item.stockCode) : null;
  const kisFlow = item.market === "DOMESTIC" ? kisFlows(item.stockCode) : null;
  const views = {
    fundamentals: scoreFundamentals(kisFund ? { ...kisFund, source: "KIS" } : data.symbol?.fundamentals ?? null),
    flows: scoreFlows(kisFlow ? { ...kisFlow, source: "KIS" } : data.symbol?.flows ?? null),
    technical: scoreTechnical(technical),
    // Structurally isolated: headlines + feed freshness only, no price/chart input.
    news: scoreNews(researchHeadlinesFor(target, universe)),
    macro: scoreMacro(data.macro),
  };
  const stopFraction = lot.quantity > 0 && lot.stopFraction > 0 ? lot.stopFraction : analyzeTrend(technicalBars.slice(-80)).stopFraction;
  const card = decideScorecard({
    ...target, price, views, technical, stopFraction,
    holding: lot.quantity > 0 ? { quantity: lot.quantity, averagePrice: lot.averagePrice } : null,
    portfolio: { heldNames: state.agentOwnedPositions.filter((p) => p.quantity > 0).length, maxNames: VTS_ORDER_LIMITS.maxPositions,
      nameWeight: price ? (lot.quantity * price * fx) / PAPER_CAPITAL_KRW : null, maxNameFraction: limits.nameFraction },
    events: eventStatus(eventCalendar(), item.market, item.stockCode, marketDate),
  });
  const kisPsr = kisFund ? referencePsr({ psr: kisFund.psr ?? null, psrSource: "KIS" }) : UNKNOWN_PSR;
  const full = { ...card, stopFraction, at: new Date().toISOString(), market: item.market, stockCode: item.stockCode, stockName: item.stockName,
    dataGeneratedAt: data.generatedAt, technicalDate: technical?.lastDate ?? null, levels: technical,
    references: { psr: kisPsr.psr != null ? kisPsr : (data.symbol?.psr ?? UNKNOWN_PSR) } };
  setScorecard(full);
  return full;
}

export async function runAgentCycle(): Promise<void> {
  if (!state.isRunning || globalAgent.__vtsAgentRunningCycle) return;
  globalAgent.__vtsAgentRunningCycle = true;
  state.lastCycleSummary = { ...EMPTY_CYCLE_SUMMARY };

  try {
    const client = new KisVtsClient();
    recordDecisionEngineCutover();
    writeScorecardUniverse([...state.watchlist, ...state.usWatchlist]);
    void refreshResearchNews([...state.watchlist, ...state.usWatchlist]).catch(() => {
      addLog("ERROR", "뉴스 수집·저장 실패. 뉴스 비교 화면을 확인하세요.", "WARN");
    });

    try {
      await reconcileAgentOwnedFills(client);
    } catch {
      addLog(
        "KIS_DIAGNOSTIC",
        "체결 동기화 실패. 미확인 주문은 소유 수량에 포함하지 않습니다.",
        "WARN",
      );
    }

    try {
      const balance = await client.getBalance();
      state.positions = balance.positions;
      setBalanceSnapshot(toBalanceSnapshot(balance));
    } catch {
      addLog(
        "KIS_DIAGNOSTIC",
        "국내 잔고 동기화 실패. 기존 Position 원장을 유지합니다.",
        "WARN",
      );
    }

    try {
      const overseasBalance = await client.getOverseasBalance();
      state.overseasPositions = overseasBalance.positions;
      setOverseasBalanceSnapshot(toOverseasBalanceSnapshot(overseasBalance));
    } catch {
      addLog(
        "KIS_DIAGNOSTIC",
        "해외 잔고 동기화 실패. 기존 해외 Position 원장을 유지합니다.",
        "WARN",
      );
    }

    try {
      await enforceRiskExits(client);
    } catch {
      addLog("RISK", "손절·익절 점검에 실패했습니다.", "WARN");
    }

    // Snapshot: the dashboard may add/remove entries while this cycle awaits KIS calls.
    for (const item of [...state.watchlist]) {
      await analyzeWatchlistItem(client, item);
    }

    for (const item of [...state.usWatchlist]) {
      await analyzeWatchlistItem(client, item);
    }

    addLog("SIGNAL", "국내·미국 관심종목 분석 사이클이 완료되었습니다.");
  } catch {
    addLog("ERROR", "분석 사이클을 시작하지 못했습니다.", "ERROR");
  } finally {
    globalAgent.__vtsAgentRunningCycle = false;
    state.lastCycleAt = new Date().toISOString();
    const valuation = strategyValuation();
    if (valuation.valid) state.performanceHistory = recordPerformance(state.performanceHistory, {
      at: state.lastCycleAt, pnlKrw: valuation.pnl, budgetKrw: PAPER_CAPITAL_KRW, strategyVersion: STRATEGY_VERSION,
    });
    saveState();
  }
}

export function startAgent(): void {
  if (!state.isRunning) {
    state.isRunning = true;
    state.sessionId = globalThis.crypto.randomUUID();
    addLog("INFO", "VTS 모의 자동매매 에이전트가 시작되었습니다.");
    saveState();
  }
  if (!globalAgent.__vtsAgentTimer) {
    void runAgentCycle();
    globalAgent.__vtsAgentTimer = setInterval(() => {
      if (state.isRunning) void runAgentCycle();
    }, 60_000);
  }
}

export function stopAgent(): void {
  state.isRunning = false;
  state.sessionId = null;
  if (globalAgent.__vtsAgentTimer) {
    clearInterval(globalAgent.__vtsAgentTimer);
    globalAgent.__vtsAgentTimer = undefined;
  }
  addLog("INFO", "분석 에이전트가 중지되었습니다.");
  saveState();
}
