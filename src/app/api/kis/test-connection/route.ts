import { apiJson } from "@/lib/api-response";
import { testVtsConnection } from "@/lib/kis-vts-client";
import { getPublicKisConfig } from "@/lib/safety";
import { state } from "@/lib/store";

export async function POST() {
  if (!getPublicKisConfig().configured) {
    return apiJson(
      { success: false, error: "KIS_NOT_CONFIGURED" },
      { status: 400 },
    );
  }

  try {
    const checks = await testVtsConnection();
    return apiJson({
      success: true,
      server: "vts",
      allowRealFallback: false,
      checks,
    });
  } catch {
    return apiJson(
      {
        success: false,
        error: "VTS_CONNECTION_FAILED",
        lastError: state.lastError,
      },
      { status: 502 },
    );
  }
}
