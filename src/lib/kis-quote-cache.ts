/** In-memory cache of non-secret KIS quote fields (valuation, investor flows) for the scorecard. */
export interface KisFundamentals { per: number | null; pbr: number | null; marketCapKrw: number; at: string }
export interface KisFlows { foreignNetKrw: number; institutionNetKrw: number; days: number; asOf: string; at: string }
const g = globalThis as typeof globalThis & { __kisFund?: Map<string, KisFundamentals>; __kisFlows?: Map<string, KisFlows>; __kisFlowsFail?: Map<string, number> };
const fund = (g.__kisFund ??= new Map()), flows = (g.__kisFlows ??= new Map()), fails = (g.__kisFlowsFail ??= new Map());
export function setKisQuoteFundamentals(code: string, v: KisFundamentals): void { fund.set(code, v); }
export function kisFundamentals(code: string, now = Date.now()): KisFundamentals | null {
  const v = fund.get(code); return v && now - Date.parse(v.at) <= 36 * 3600_000 ? v : null;
}
export function setKisFlows(code: string, v: KisFlows): void { flows.set(code, v); fails.delete(code); }
export function noteKisFlowsFailure(code: string, now = Date.now()): void { fails.set(code, now); }
export function kisFlows(code: string, now = Date.now()): KisFlows | null {
  const v = flows.get(code); return v && now - Date.parse(v.at) <= 6 * 3600_000 ? v : null;
}
/** Refresh at most every 6h per symbol; after a failure wait 6h too (VTS may not serve the TR). */
export function kisFlowsDue(code: string, now = Date.now()): boolean {
  const failedAt = fails.get(code);
  return !kisFlows(code, now) && !(failedAt && now - failedAt < 6 * 3600_000);
}
