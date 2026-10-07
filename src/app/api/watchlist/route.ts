import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { TradingMarket } from "@/lib/domain";
import { KisVtsClient } from "@/lib/kis-vts-client";
import { addLog, saveState, state } from "@/lib/store";
import { addWatchlistItem, normalizeSymbol, removeWatchlistItem } from "@/lib/watchlist";

export const dynamic = "force-dynamic";

const marketSchema = z.enum(["DOMESTIC", "US_NASDAQ"]).default("DOMESTIC");
const addSchema = z.object({
  market: marketSchema,
  stockCode: z.string().trim().min(1).max(10),
  stockName: z.string().trim().max(40).optional(),
});
const removeSchema = z.object({
  market: marketSchema,
  stockCode: z.string().trim().min(1).max(10),
  force: z.boolean().optional(),
});

export async function GET() {
  return NextResponse.json({ success: true, data: { domestic: state.watchlist, us: state.usWatchlist } });
}

async function quote(market: TradingMarket, stockCode: string): Promise<number | null> {
  try {
    const client = new KisVtsClient();
    return market === "DOMESTIC" ? await client.getPrice(stockCode) : await client.getOverseasPrice(stockCode, "NAS");
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  const parsed = addSchema.safeParse(await request.json().catch(() => null));
  const stockCode = parsed.success ? normalizeSymbol(parsed.data.market, parsed.data.stockCode) : null;
  if (!parsed.success || !stockCode) {
    return NextResponse.json({ success: false, error: "INVALID_WATCHLIST_ITEM: 국내 6자리 코드 또는 NASDAQ 티커(1~5자 영문)" }, { status: 400 });
  }
  const { market } = parsed.data;
  const existing = (market === "DOMESTIC" ? state.watchlist : state.usWatchlist).find((i) => i.stockCode === stockCode);
  if (existing) return NextResponse.json({ success: true, message: "이미 관심종목에 있습니다.", data: existing });

  // Validate with a live VTS quote so typos don't sit in the agent loop.
  const price = await quote(market, stockCode);
  if (!price) {
    return NextResponse.json({ success: false, error: `KIS 시세 조회 실패: ${stockCode} (${market === "DOMESTIC" ? "국내" : "NASDAQ"})` }, { status: 422 });
  }
  const result = addWatchlistItem({ market, stockCode, stockName: parsed.data.stockName, source: "USER", currentPrice: price });
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 400 });
  addLog("INFO", `관심종목 추가: ${result.item.stockName}(${stockCode}) ${market}`);
  saveState();
  return NextResponse.json({ success: true, message: `${result.item.stockName}(${stockCode}) 추가됨. 다음 사이클부터 분석합니다.`, data: result.item }, { status: 201 });
}

export async function DELETE(request: NextRequest) {
  const url = new URL(request.url);
  const body = await request.json().catch(() => null);
  const parsed = removeSchema.safeParse(body ?? {
    market: url.searchParams.get("market") ?? undefined,
    stockCode: url.searchParams.get("stockCode") ?? "",
    force: url.searchParams.get("force") === "true",
  });
  if (!parsed.success) return NextResponse.json({ success: false, error: "INVALID_WATCHLIST_ITEM" }, { status: 400 });
  const result = removeWatchlistItem(parsed.data);
  if (!result.ok) {
    if (result.error === "HELD_POSITION_CONFIRM_REQUIRED") {
      return NextResponse.json({ success: false, error: result.error, heldQuantity: result.heldQuantity,
        message: `보유 중(${result.heldQuantity}주)인 종목입니다. 삭제해도 손절·익절은 계속 감시되지만 추세 이탈 매도 신호는 더 이상 갱신되지 않습니다.` }, { status: 409 });
    }
    return NextResponse.json({ success: false, error: result.error }, { status: result.error === "NOT_FOUND" ? 404 : 400 });
  }
  addLog("INFO", `관심종목 삭제: ${result.item.stockName}(${result.item.stockCode}) ${result.item.market}`);
  saveState();
  return NextResponse.json({ success: true, message: `${result.item.stockName}(${result.item.stockCode}) 삭제됨.`, data: result.item });
}
