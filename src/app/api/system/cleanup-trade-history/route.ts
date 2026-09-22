import { NextRequest, NextResponse } from "next/server";
import { resetHistory, state } from "@/lib/store";

export async function GET() {
  return NextResponse.json({
    success: true,
    data: {
      tradeHistory: state.tradeHistory.length,
      agentLog: state.logs.length,
      preserved: [
        "Position",
        "AppSetting",
        "TradingSettings",
        "KisConfig",
        "MarketData",
        "Watchlist",
        "UserSettings",
      ],
    },
  });
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { confirm?: string };
  if (body.confirm !== "RESET_TRADE_AND_LOG_HISTORY") {
    return NextResponse.json(
      { success: false, error: "CONFIRMATION_REQUIRED" },
      { status: 400 },
    );
  }
  return NextResponse.json({ success: true, deleted: resetHistory() });
}
