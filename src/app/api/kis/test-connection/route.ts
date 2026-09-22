import { NextResponse } from "next/server";
import { testVtsConnection } from "@/lib/kis-vts-client";
import { getPublicKisConfig } from "@/lib/safety";
import { state } from "@/lib/store";

export async function POST() {
  if (!getPublicKisConfig().configured) {
    return NextResponse.json(
      { success: false, error: "KIS_NOT_CONFIGURED" },
      { status: 400 },
    );
  }

  try {
    const checks = await testVtsConnection();
    return NextResponse.json({
      success: true,
      server: "vts",
      allowRealFallback: false,
      checks,
    });
  } catch {
    return NextResponse.json(
      {
        success: false,
        error: "VTS_CONNECTION_FAILED",
        lastError: state.lastError,
      },
      { status: 502 },
    );
  }
}
