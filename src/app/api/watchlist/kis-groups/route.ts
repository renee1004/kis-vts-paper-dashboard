import { NextResponse } from "next/server";
import { KisVtsClient } from "@/lib/kis-vts-client";

export const dynamic = "force-dynamic";

/** Read-only diagnostic: does KIS 관심종목 그룹조회 answer on the VTS host? */
export async function GET() {
  try {
    const result = await new KisVtsClient().probeInterestGroups();
    return NextResponse.json({ success: true, data: { ...result, supported: result.rt_cd === "0" } });
  } catch {
    return NextResponse.json({ success: false, error: "KIS_NOT_CONFIGURED" }, { status: 400 });
  }
}
