import "server-only";
import type { VtsOrder } from "@/lib/domain";
import { ownedLot } from "@/lib/ownership";
import { addLog, rebuildAgentOwnedPositions, saveState, state } from "@/lib/store";
import { strategyValuation } from "@/lib/vts-execution";
import { findStopOverride, REBASE_STOP_FRACTION, rebasedStopPrice, TREND_CONFIRM_AFTER_KST, type StopOverride } from "@/lib/stop-rebase";

/**
 * One-time, auditable import of KIS VTS fills that the pre-2026-09-11 dashboard
 * placed through the API before the ownership ledger existed. Values come from
 * KIS VTS inquire-daily-ccld (VTTC0081R), queried 2026-10-06. Order numbers are
 * masked to the last 4 digits. Unknown-origin fills (2026-09-01) are excluded.
 */
export const PRE_0911_IMPORT_SOURCE = "KIS_VTS_FILL_IMPORT_PRE_0911";
export const PRE_0911_APPLY_CONFIRM = "IMPORT_PRE_0911_VTS_FILLS";
export const PRE_0911_REVERT_CONFIRM = "REVERT_PRE_0911_VTS_FILLS";
export const REBASE_STOPS_CONFIRM = "REBASE_IMPORTED_STOPS";
const LEGACY_STOP_FRACTION = 0.05;

// [stockCode, stockName, side, KST date, KST time, quantity, total fill amount KRW, order no last 4]
type Fill = [string, string, "BUY" | "SELL", string, string, number, number, string];
const FILLS: Fill[] = [
  ["000720", "현대건설", "BUY", "20260909", "083028", 2, 268600, "0256"],
  ["000720", "현대건설", "BUY", "20260909", "093236", 2, 275200, "1129"],
  ["000720", "현대건설", "BUY", "20260909", "110957", 2, 269800, "1963"],
  ["000720", "현대건설", "BUY", "20260909", "124856", 2, 267600, "9125"],
  ["000720", "현대건설", "BUY", "20260909", "144030", 2, 263800, "7737"],
  ["000720", "현대건설", "BUY", "20260910", "101821", 29, 3697200, "6106"],
  ["000720", "현대건설", "BUY", "20260910", "101932", 18, 2298500, "6278"],
  ["005930", "삼성전자", "BUY", "20260909", "083523", 1, 269500, "0465"],
  ["005930", "삼성전자", "BUY", "20260909", "093927", 1, 270250, "1962"],
  ["005930", "삼성전자", "BUY", "20260909", "111551", 1, 273250, "2482"],
  ["005930", "삼성전자", "BUY", "20260909", "125401", 1, 269500, "0010"],
  ["005930", "삼성전자", "BUY", "20260909", "144310", 1, 269500, "7903"],
  ["005930", "삼성전자", "BUY", "20260910", "101801", 14, 3695000, "6077"],
  ["005930", "삼성전자", "BUY", "20260910", "102018", 9, 2378250, "6387"],
  ["000660", "SK하이닉스", "BUY", "20260909", "083004", 1, 1795000, "0057"],
  ["000660", "SK하이닉스", "BUY", "20260909", "093204", 1, 1816000, "1054"],
  ["000660", "SK하이닉스", "BUY", "20260909", "110720", 1, 1856000, "1732"],
  ["000660", "SK하이닉스", "BUY", "20260909", "124637", 1, 1856500, "8980"],
  ["000660", "SK하이닉스", "BUY", "20260909", "143645", 1, 1851000, "7488"],
  ["069500", "KODEX 200", "BUY", "20260909", "113445", 2, 225770, "3623"],
  ["069500", "KODEX 200", "BUY", "20260910", "113307", 34, 3760520, "2802"],
  ["069500", "KODEX 200", "BUY", "20260910", "113457", 32, 3542105, "3069"],
  ["069500", "KODEX 200", "SELL", "20260915", "082905", 60, 6286200, "0041"],
];

function kstToIso(date: string, time: string): string {
  return new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}+09:00`).toISOString();
}

export function pre0911ImportRows(): VtsOrder[] {
  return FILLS.map(([stockCode, stockName, side, date, time, quantity, amount, last4]) => ({
    id: `import-pre0911-${stockCode}-${date}-${last4}`,
    timestamp: kstToIso(date, time), orderDate: date, market: "DOMESTIC", exchange: "KRX", currency: "KRW",
    stockCode, stockName, side, quantity, filledQuantity: quantity, referencePrice: amount / quantity,
    orderType: "MARKET", status: "FILLED", blockedReason: null, kisOrderNo: `******${last4}`, kisBranchNo: "00950",
    signalId: `${PRE_0911_IMPORT_SOURCE}:${stockCode}:${date}:${last4}`, sessionId: null,
    ownershipScope: "AGENT_CREATED_ONLY", averageFillPrice: amount / quantity,
    stopFraction: side === "BUY" ? LEGACY_STOP_FRACTION : undefined,
    strategyVersion: "legacy-dashboard-pre-0911", importSource: PRE_0911_IMPORT_SOURCE,
  }));
}

export function previewPre0911Import() {
  const rows = pre0911ImportRows();
  const imported = state.vtsOrders.some((o) => o.importSource === PRE_0911_IMPORT_SOURCE);
  const merged = imported ? state.vtsOrders : [...state.vtsOrders, ...rows];
  const symbols = [...new Set(rows.map((r) => r.stockCode))];
  const lots = symbols.map((stockCode) => {
    const lot = ownedLot(merged, "DOMESTIC", stockCode);
    const brokerQuantity = state.positions.find((p) => p.stockCode === stockCode)?.quantity ?? 0;
    return { stockCode, ownedQuantity: lot.quantity, averagePrice: lot.averagePrice, brokerQuantity,
      fits: lot.quantity <= brokerQuantity };
  });
  return { source: PRE_0911_IMPORT_SOURCE, alreadyImported: imported, rowCount: rows.length, lots,
    stopOverrides: state.stopOverrides.filter((o) => o.source === PRE_0911_IMPORT_SOURCE) };
}

export function applyPre0911Import() {
  const preview = previewPre0911Import();
  if (preview.alreadyImported) return { ...preview, applied: false, reason: "ALREADY_IMPORTED" };
  const age = Date.now() - Date.parse(state.balanceSnapshot?.syncedAt ?? "");
  if (!Number.isFinite(age) || age < 0 || age > 600_000) throw new Error("STALE_DOMESTIC_BALANCE");
  if (preview.lots.some((lot) => !lot.fits)) throw new Error("IMPORT_EXCEEDS_BROKER_HOLDING");
  state.vtsOrders.push(...pre0911ImportRows());
  rebuildAgentOwnedPositions();
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10).replaceAll("-", "");
  // Historical P&L of imported lots is not today's loss: re-baseline the daily loss check.
  if (state.strategyRisk.date === today) state.strategyRisk.startPnl = strategyValuation().pnl;
  addLog("RISK", `과거 KIS 체결 ${preview.rowCount}건을 에이전트 보유로 등록 (${PRE_0911_IMPORT_SOURCE})`, "WARN");
  rebaseImportedStops();
  saveState();
  return { ...previewPre0911Import(), applied: true };
}

export function revertPre0911Import() {
  const before = state.vtsOrders.length;
  state.vtsOrders = state.vtsOrders.filter((o) => o.importSource !== PRE_0911_IMPORT_SOURCE);
  state.stopOverrides = state.stopOverrides.filter((o) => o.source !== PRE_0911_IMPORT_SOURCE);
  rebuildAgentOwnedPositions();
  addLog("RISK", `과거 KIS 체결 등록 취소 (${PRE_0911_IMPORT_SOURCE})`, "WARN");
  saveState();
  return { removed: before - state.vtsOrders.length };
}
/**
 * Imported lots that were already below their average-cost stop get a rebased
 * stop (reference price x 0.95) instead of being dumped at the next open.
 * Reference price = latest KIS balance price (prpr). One override per lot.
 */
export function rebaseImportedStops(now = new Date()) {
  const age = now.getTime() - Date.parse(state.balanceSnapshot?.syncedAt ?? "");
  if (!Number.isFinite(age) || age < 0 || age > 600_000) throw new Error("STALE_DOMESTIC_BALANCE");
  const created: StopOverride[] = [];
  const kstDay = new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10).replaceAll("-", "");
  for (const position of state.positions) {
    const lot = ownedLot(state.vtsOrders, "DOMESTIC", position.stockCode);
    if (!lot.quantity || !lot.positionId) continue;
    if (state.vtsOrders.find((o) => o.id === lot.positionId)?.importSource !== PRE_0911_IMPORT_SOURCE) continue;
    if (findStopOverride(state.stopOverrides, "DOMESTIC", position.stockCode, lot.positionId)) continue;
    const originalStopPrice = lot.averagePrice * (1 - lot.stopFraction);
    if (!(position.currentPrice > 0) || position.currentPrice > originalStopPrice) continue;
    const override: StopOverride = { market: "DOMESTIC", stockCode: position.stockCode, stockName: position.stockName,
      positionId: lot.positionId, source: PRE_0911_IMPORT_SOURCE, reason: "IMPORTED_POSITION_ALREADY_BELOW_STOP",
      averagePrice: lot.averagePrice, originalStopPrice, referencePrice: position.currentPrice,
      referencePriceSource: "KIS_BALANCE_PRPR", referenceDate: kstDay, referenceAt: position.lastSyncedAt,
      stopFraction: REBASE_STOP_FRACTION, stopPrice: rebasedStopPrice(position.currentPrice),
      trendConfirmAfterKst: TREND_CONFIRM_AFTER_KST, createdAt: now.toISOString() };
    state.stopOverrides.push(override); created.push(override);
    addLog("SIGNAL", `재설정 손절 적용 ${override.stockName}(${override.stockCode}): 평균 ${Math.round(override.averagePrice).toLocaleString("ko-KR")} 기존 손절선 ${Math.round(originalStopPrice).toLocaleString("ko-KR")} 이미 하회 → 기준가 ${override.referencePrice.toLocaleString("ko-KR")}(${kstDay}) × 0.95 = 새 손절선 ${override.stopPrice.toLocaleString("ko-KR")}. 개장 즉시 손절 없음, ${TREND_CONFIRM_AFTER_KST} 이후 20일선 아래 확인 또는 새 손절선 도달 시 전량 매도`);
  }
  if (created.length) saveState();
  return { created, stopOverrides: state.stopOverrides };
}
