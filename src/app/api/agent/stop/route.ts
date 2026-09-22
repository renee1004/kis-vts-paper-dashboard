import { NextResponse } from "next/server";
import { stopAgent } from "@/lib/agent";

export async function POST() {
  stopAgent();
  return NextResponse.json({ success: true, message: "에이전트가 중지되었습니다." });
}
