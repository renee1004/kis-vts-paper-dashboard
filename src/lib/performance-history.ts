export interface PerformancePoint {
  at: string;
  pnlKrw: number;
  budgetKrw: number;
  strategyVersion: string;
}

// Hourly observations of the same tracked ledger, not full-account equity.
export function recordPerformance(history: PerformancePoint[], point: PerformancePoint): PerformancePoint[] {
  if (![point.pnlKrw, point.budgetKrw].every(Number.isFinite) || point.budgetKrw <= 0 ||
      !Number.isFinite(Date.parse(point.at))) return history;
  const last = history.at(-1);
  if (last && Date.parse(point.at) <= Date.parse(last.at)) return history;
  if (last && last.strategyVersion === point.strategyVersion && last.budgetKrw === point.budgetKrw &&
      Date.parse(point.at) - Date.parse(last.at) < 3600_000) return history;
  return [...history, point].slice(-2160);
}

export function sevenDayPerformance(history: PerformancePoint[], current: PerformancePoint | null) {
  const unavailable = (reason: string) => ({ status: "INSUFFICIENT_DATA", reason,
    pnlKrw: null, returnPct: null, sampledMaxDrawdownPct: null });
  if (!current) return unavailable("CURRENT_VALUATION_UNAVAILABLE");
  const end = Date.parse(current.at), start = end - 7 * 86400_000;
  const compatible = history.filter(p => p.strategyVersion === current.strategyVersion &&
    p.budgetKrw === current.budgetKrw && Number.isFinite(p.pnlKrw) && Date.parse(p.at) <= end)
    .sort((a,b) => Date.parse(a.at) - Date.parse(b.at));
  const baseline = compatible.filter(p => Date.parse(p.at) <= start).at(-1);
  if (!baseline || start - Date.parse(baseline.at) > 2 * 3600_000) return unavailable("SEVEN_DAY_BASELINE_MISSING");
  const points = [baseline, ...compatible.filter(p => Date.parse(p.at) > Date.parse(baseline.at)), current];
  if (points.some((p,i) => i > 0 && Date.parse(p.at) - Date.parse(points[i-1].at) > 2 * 3600_000)) {
    return unavailable("OBSERVATION_GAP_OVER_TWO_HOURS");
  }
  let peak = baseline.budgetKrw + baseline.pnlKrw, drawdown = 0;
  if (points.some(p => p.budgetKrw + p.pnlKrw <= 0)) return unavailable("NONPOSITIVE_TRACKED_EQUITY");
  for (const p of points) {
    const equity = p.budgetKrw + p.pnlKrw;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, (peak - equity) / peak * 100);
  }
  const pnl = current.pnlKrw - baseline.pnlKrw;
  return { status: "AVAILABLE", reason: null, from: baseline.at, to: current.at,
    pnlKrw: pnl, returnPct: pnl / (baseline.budgetKrw + baseline.pnlKrw) * 100,
    sampledMaxDrawdownPct: drawdown };
}
