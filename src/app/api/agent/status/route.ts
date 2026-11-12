import { apiJson } from "@/lib/api-response";
import {
  computeSafetyMode,
  getOrderDecision,
  getPublicKisConfig,
} from "@/lib/safety";
import {
  usMarketStatusLabel,
  usRegularHoursDescriptionKo,
} from "@/lib/market-hours";
import { state } from "@/lib/store";
import { effectiveStops, strategyValuation, VTS_ORDER_LIMITS } from "@/lib/vts-execution";
import { CAPITAL_BASIS, INITIAL_ACCOUNT_BALANCE_KRW } from "@/lib/trading-limits";
import { sevenDayPerformance } from "@/lib/performance-history";
import { MARKET_CALENDAR_INFO, marketSession } from "@/lib/market-calendar";
import { calendarCrosscheckView } from "@/lib/research-display";
import { FX_ASSUMPTION_SOURCE } from "@/lib/domain";
import { FX_LIMITS_NOTE, formatUsdKrwDisplay, currentUsdKrwSnapshot } from "@/lib/fx-rate";
import { usFxPnlFromOrders } from "@/lib/fx-pnl";

export const dynamic = "force-dynamic";

export async function GET() {
  const domesticDecision = getOrderDecision("DOMESTIC");
  const overseasDecision = getOrderDecision("US_NASDAQ");
  const kis = getPublicKisConfig();
  const valuation = strategyValuation();
  const usdKrw = currentUsdKrwSnapshot();
  const usMarks = Object.fromEntries(
    state.overseasPositions
      .filter((position) => position.currentPrice > 0)
      .map((position) => [position.stockCode, position.currentPrice]),
  );
  return apiJson({
    success: true,
    data: {
      strategy: {
        capitalBasis: CAPITAL_BASIS,
        initialAccountBalanceKrw: INITIAL_ACCOUNT_BALANCE_KRW,
        version: VTS_ORDER_LIMITS.strategyVersion,
        validationStatus: VTS_ORDER_LIMITS.validationStatus,
        paperBudgetKrw: VTS_ORDER_LIMITS.principalKrw,
        estimatedPnlKrw: valuation.valid ? valuation.pnl : null,
        estimatedReturnPct: valuation.valid ? valuation.pnl / VTS_ORDER_LIMITS.principalKrw * 100 : null,
        unresolvedOrders: state.vtsOrders.filter((o) => o.status === "UNKNOWN").length,
        costAssumptionBpsPerSide: 15,
        fxAssumption: FX_ASSUMPTION_SOURCE,
        usdKrw: {
          rate: usdKrw.rate,
          capturedAt: usdKrw.capturedAt,
          source: usdKrw.source,
          status: usdKrw.status,
          display: formatUsdKrwDisplay(usdKrw),
          limitsUseSafetyRate: VTS_ORDER_LIMITS.usdKrwSafetyRate,
          limitsNote: FX_LIMITS_NOTE,
        },
        usFxPnl: usFxPnlFromOrders(state.vtsOrders, usMarks, usdKrw),
        performanceScope: "ALL_TRACKED_FILLS_INCLUDING_LEGACY_NOT_WHOLE_ACCOUNT",
        sevenDayPerformance: sevenDayPerformance(state.performanceHistory, valuation.valid ? {
          at: new Date().toISOString(), pnlKrw: valuation.pnl,
          budgetKrw: VTS_ORDER_LIMITS.principalKrw, strategyVersion: VTS_ORDER_LIMITS.strategyVersion,
        } : null),
      },
      isRunning: state.isRunning,
      lastCycleAt: state.lastCycleAt,
      lastCycleSummary: state.lastCycleSummary,
      runtimeDecision: {
        marketCalendar: { ...MARKET_CALENDAR_INFO, domestic: marketSession("DOMESTIC"), overseas: marketSession("US_NASDAQ") },
        calendarMismatches: calendarCrosscheckView().messages,
        canRunAnalysisNow: kis.configured,
        canPlaceDomesticOrderNow: domesticDecision.allowed,
        canPlaceOverseasOrderNow: overseasDecision.allowed,
        domesticOrderBlockedReason: domesticDecision.allowed ? null : domesticDecision.reason,
        overseasOrderBlockedReason: overseasDecision.allowed ? null : overseasDecision.reason,
        usMarketStatus: usMarketStatusLabel(),
        usMarketHoursKo: usRegularHoursDescriptionKo(),
      },
      safety: {
        ...state.settings,
        effectiveSafetyMode: computeSafetyMode(),
      },
      kisDiagnostics: {
        configured: kis.configured,
        baseUrlType: "vts",
        allowRealFallback: false,
        isDemo: true,
        lastError: state.lastError,
      },
      positions: state.positions,
      overseasPositions: state.overseasPositions,
      balanceSnapshot: state.balanceSnapshot,
      overseasBalanceSnapshot: state.overseasBalanceSnapshot,
      agentOwnedPositions: state.agentOwnedPositions,
      effectiveStops: effectiveStops(),
      stopOverrides: state.stopOverrides,
      vtsOrders: state.vtsOrders.slice(0, 50),
      watchlist: state.watchlist,
      usWatchlist: state.usWatchlist,
      recentLogs: state.logs.slice(0, 20),
    },
  });
}
