import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { saveState, state } from "@/lib/store";

const schema = z.object({
  stockCode: z.string().trim().regex(/^\d{6}$/),
  stockName: z.string().trim().min(1).max(40),
});

export async function GET() {
  return NextResponse.json({ success: true, data: state.watchlist });
}

export async function POST(request: NextRequest) {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "INVALID_WATCHLIST_ITEM" },
      { status: 400 },
    );
  }
  const existing = state.watchlist.find(
    (item) => item.stockCode === parsed.data.stockCode,
  );
  if (existing) return NextResponse.json({ success: true, data: existing });

  const item = {
    id: crypto.randomUUID(),
    market: "DOMESTIC" as const,
    ...parsed.data,
    currency: "KRW" as const,
    candleStatus: "PENDING" as const,
    priceStatus: "PENDING" as const,
    analysis: "HOLD" as const,
    confidence: 0,
    buyScore: 0,
    sellScore: 0,
    blockedReason: "SAFE_LOCKED",
    currentPrice: null,
  };
  state.watchlist.push(item);
  saveState();
  return NextResponse.json({ success: true, data: item }, { status: 201 });
}
