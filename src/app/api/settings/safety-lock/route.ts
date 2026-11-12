import { apiJson } from "@/lib/api-response";
import { forceSafetyLock } from "@/lib/safety";

export async function POST() {
  forceSafetyLock("USER_REQUESTED");
  return apiJson({
    success: true,
    effectiveSafetyMode: "SAFE_LOCKED",
    canPlaceDomesticOrderNow: false,
  });
}
