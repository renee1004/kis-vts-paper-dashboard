import { NextResponse } from "next/server";
import { chartSeries, decisionEngineCutover, scorecardsView } from "@/lib/scorecard-data";
import { DECISION_ENGINE_VERSION } from "@/lib/scorecard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Read-only. No order endpoints here.
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const market = url.searchParams.get("market"), code = url.searchParams.get("stockCode");
    const chart = (market === "DOMESTIC" || market === "US_NASDAQ") && code && /^[A-Z0-9.]{1,20}$/i.test(code) ? chartSeries(market, code) : null;
    return NextResponse.json({ success: true, data: { version: DECISION_ENGINE_VERSION, cutover: decisionEngineCutover(), cards: scorecardsView(), chart } });
  } catch {
    return NextResponse.json({ success: false, error: "점수판을 읽을 수 없습니다." }, { status: 500 });
  }
}
