import { NextResponse } from "next/server";
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

export const dynamic = "force-dynamic";

export async function GET() {
  const domesticDecision = getOrderDecision("DOMESTIC");
  const overseasDecision = getOrderDecision("US_NASDAQ");
  const kis = getPublicKisConfig();
  const valuation = strategyValuation();
  return NextResponse.json({
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
        fxAssumption: "FIXED_1500_NOT_ACTUAL_FX",
      },
      isRunning: state.isRunning,
      lastCycleAt: state.lastCycleAt,
      lastCycleSummary: state.lastCycleSummary,
      runtimeDecision: {
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
