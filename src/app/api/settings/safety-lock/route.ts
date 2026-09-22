import { NextResponse } from "next/server";
import { forceSafetyLock } from "@/lib/safety";

export async function POST() {
  forceSafetyLock("USER_REQUESTED");
  return NextResponse.json({
    success: true,
    effectiveSafetyMode: "SAFE_LOCKED",
    canPlaceDomesticOrderNow: false,
  });
}
