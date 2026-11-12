import { NextRequest } from "next/server";
import { apiJson } from "@/lib/api-response";
import { resetHistory, state } from "@/lib/store";
import { isLocalRequest, localOnlyResponse } from "@/lib/local-request";

export async function GET() {
  return apiJson({
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
  if (!isLocalRequest(request)) return localOnlyResponse();
  const body = (await request.json().catch(() => ({}))) as { confirm?: string };
  if (body.confirm !== "RESET_TRADE_AND_LOG_HISTORY") {
    return apiJson(
      { success: false, error: "CONFIRMATION_REQUIRED" },
      { status: 400 },
    );
  }
  return apiJson({ success: true, deleted: resetHistory() });
}
