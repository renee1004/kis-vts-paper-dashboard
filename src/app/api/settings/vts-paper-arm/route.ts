import { NextRequest, NextResponse } from "next/server";
import { startAgent } from "@/lib/agent";
import { testVtsConnection } from "@/lib/kis-vts-client";
import {
  armVtsPaper,
  computeSafetyMode,
  getOrderDecision,
  markVtsReady,
} from "@/lib/safety";
import { state } from "@/lib/store";

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
    confirm?: string;
  };

  try {
    let started = false;
    if (body.action === "PREPARE") {
      await testVtsConnection();
      markVtsReady();
    } else if (body.action === "ARM") {
      armVtsPaper(body.confirm ?? "");
    } else if (body.action === "ARM_AND_START") {
      // One explicit confirmation still gates every KIS order path below.
      if (!state.prepared) {
        await testVtsConnection();
        markVtsReady();
      }
      armVtsPaper(body.confirm ?? "");
      startAgent();
      started = true;
    } else {
      return NextResponse.json(
        { success: false, error: "UNSUPPORTED_ACTION" },
        { status: 400 },
      );
    }

    const decision = getOrderDecision();
    return NextResponse.json({
      success: true,
      effectiveSafetyMode: computeSafetyMode(),
      canPlaceDomesticOrderNow: decision.allowed,
      blockedReason: decision.allowed ? null : decision.reason,
      agentRunning: state.isRunning,
      message: started
        ? "VTS 모의 자동매매를 활성화하고 에이전트를 시작했습니다."
        : undefined,
      vtsMockOrders: true,
      sellScope: "AGENT_CREATED_ONLY",
      realOrderApiAvailable: false,
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "VTS_AUTO_TRANSITION_FAILED",
        effectiveSafetyMode: computeSafetyMode(),
        lastError: state.lastError,
      },
      { status: 400 },
    );
  }
}
