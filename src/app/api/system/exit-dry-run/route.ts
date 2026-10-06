import { NextResponse } from "next/server";
import type { TradingMarket } from "@/lib/domain";
import { dryRunExit } from "@/lib/vts-execution";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Read-only what-if evaluation of exit rules. Never calls KIS and never places orders.
// prices/times: intraday checks. closes: simulated COMPLETED daily closes (next-session decision).
export async function GET(request: Request) {
  const url = new URL(request.url);
  const market = (url.searchParams.get("market") ?? "DOMESTIC") as TradingMarket;
  const stockCode = url.searchParams.get("code") ?? "";
  const list = (name: string) => (url.searchParams.get(name) ?? "").split(",").map(Number).filter((v) => v > 0);
  const prices = list("prices"); const closes = list("closes");
  const times = (url.searchParams.get("times") ?? "").split(",").filter(Boolean);
  const recentLow = Number(url.searchParams.get("recentLow"));
  if (!["DOMESTIC", "US_NASDAQ"].includes(market) || !stockCode || (!prices.length && !closes.length))
    return NextResponse.json({ success: false, error: "market, code and prices(+times ISO) or closes required" }, { status: 400 });
  const results = [];
  for (const time of times.length ? times : [new Date().toISOString()]) {
    const at = new Date(time);
    if (!Number.isFinite(at.getTime())) return NextResponse.json({ success: false, error: "INVALID_TIME" }, { status: 400 });
    for (const price of prices) results.push(dryRunExit({ market, stockCode, price, at }));
  }
  for (const close of closes) results.push(dryRunExit({ market, stockCode, price: close, at: new Date(),
    simulatedClose: close, recentLow: recentLow > 0 ? recentLow : undefined }));
  return NextResponse.json({ success: true, data: { dryRun: true, ordersPlaced: 0, results } });
}