import "server-only";

import { analyzeTrend, STRATEGY_VERSION, type DailyBar } from "@/lib/strategy";
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
import { enforceRiskExits, executeVtsMockOrder, reconcileAgentOwnedFills } from "@/lib/vts-execution";
import { observeResearch, refreshResearchNews } from "@/lib/news-research";

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
  item.confidence = signal.confidence;
  item.buyScore = signal.buyScore;
  item.sellScore = signal.sellScore;
  item.blockedReason =
    signal.side === "HOLD" ? signal.reason : "Rule Engine 검증 대기";
  state.lastCycleSummary.signalsGenerated += 1;

  if (price && signal.side !== "HOLD") {
    const lastDate = bars.at(-1)?.date ?? "";
    const ageDays = lastDate ? (Date.now() - Date.parse(lastDate.slice(0, 4) + "-" + lastDate.slice(4, 6) + "-" + lastDate.slice(6, 8) + "T00:00:00Z")) / 86400_000 : Infinity;
    if (ageDays > 7 || (signal.side === "BUY" && Math.abs(price / bars.at(-1)!.close - 1) > 0.02)) {
      item.blockedReason = "STALE_CANDLES_OR_ENTRY_GAP"; return;
    }
    const signalId = [STRATEGY_VERSION, item.market, item.stockCode, lastDate, signal.side].join(":");
    const order = await executeVtsMockOrder(client, {
      market: item.market,
      stockCode: item.stockCode,
      stockName: item.stockName,
      side: signal.side,
      confidence: signal.confidence,
      price,
      signalId,
      signalDate: signal.signalDate ?? undefined,
      stopFraction: signal.stopFraction,
      trendMa: signal.trendMa,
    });
    item.blockedReason = order?.blockedReason ?? "";
  }
}

export async function runAgentCycle(): Promise<void> {
  if (!state.isRunning || globalAgent.__vtsAgentRunningCycle) return;
  globalAgent.__vtsAgentRunningCycle = true;
  state.lastCycleSummary = { ...EMPTY_CYCLE_SUMMARY };

  try {
    const client = new KisVtsClient();
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

    for (const item of state.watchlist) {
      await analyzeWatchlistItem(client, item);
    }

    for (const item of state.usWatchlist) {
      await analyzeWatchlistItem(client, item);
    }

    addLog("SIGNAL", "국내·미국 관심종목 분석 사이클이 완료되었습니다.");
  } catch {
    addLog("ERROR", "분석 사이클을 시작하지 못했습니다.", "ERROR");
  } finally {
    globalAgent.__vtsAgentRunningCycle = false;
    state.lastCycleAt = new Date().toISOString();
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
