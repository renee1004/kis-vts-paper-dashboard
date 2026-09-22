import { NextResponse } from "next/server";
import { state } from "@/lib/store";
import { todayBuyNotional, VTS_ORDER_LIMITS } from "@/lib/vts-execution";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    success: true,
    data: {
      orders: state.vtsOrders,
      agentOwnedPositions: state.agentOwnedPositions,
      limits: VTS_ORDER_LIMITS,
      todayBuyNotional: todayBuyNotional(),
      blockedReasonCounts: state.vtsOrders
        .filter((order) => order.status === "BLOCKED" && order.blockedReason)
        .reduce<Record<string, number>>((counts, order) => {
          const reason = order.blockedReason as string;
          counts[reason] = (counts[reason] ?? 0) + 1;
          return counts;
        }, {}),
      server: "vts",
      realFallback: false,
    },
  });
}
