import { NextResponse } from "next/server";
import { startAgent } from "@/lib/agent";
import { computeSafetyMode, getPublicKisConfig } from "@/lib/safety";
import { isLocalRequest, localOnlyResponse } from "@/lib/local-request";

export async function POST(request: Request) {
  if (!isLocalRequest(request)) return localOnlyResponse();
  if (!getPublicKisConfig().configured) {
    return NextResponse.json(
      { success: false, error: "KIS_NOT_CONFIGURED" },
      { status: 400 },
    );
  }
  if (computeSafetyMode() !== "VTS_AUTO_ARMED") {
    return NextResponse.json(
      { success: false, error: "VTS_AUTO_NOT_ARMED" },
      { status: 400 },
    );
  }
  startAgent();
  return NextResponse.json({
    success: true,
    message:
      "VTS 모의 자동매매 시작. 에이전트가 새로 매수한 수량만 자동매도합니다.",
  });
}
