import { NextResponse } from "next/server";
import type { TradingMarket } from "@/lib/domain";
import { dryRunExit } from "@/lib/vts-execution";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Read-only what-if evaluation of exit rules. Never calls KIS and never places orders.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const market = (url.searchParams.get("market") ?? "DOMESTIC") as TradingMarket;
  const stockCode = url.searchParams.get("code") ?? "";
  const prices = (url.searchParams.get("prices") ?? "").split(",").map(Number).filter((v) => v > 0);
  const times = (url.searchParams.get("times") ?? "").split(",").filter(Boolean);
  const trendMaParam = Number(url.searchParams.get("trendMa"));
  if (!["DOMESTIC", "US_NASDAQ"].includes(market) || !stockCode || !prices.length || !times.length)
    return NextResponse.json({ success: false, error: "market, code, prices, times(ISO) required" }, { status: 400 });
  const results = [];
  for (const time of times) {
    const at = new Date(time);
    if (!Number.isFinite(at.getTime())) return NextResponse.json({ success: false, error: "INVALID_TIME" }, { status: 400 });
    for (const price of prices) results.push(dryRunExit({ market, stockCode, price, at,
      trendMa: trendMaParam > 0 ? trendMaParam : undefined }));
  }
  return NextResponse.json({ success: true, data: { dryRun: true, ordersPlaced: 0, results } });
}