import { apiJson } from "@/lib/api-response";
import { stopAgent } from "@/lib/agent";

export async function POST() {
  stopAgent();
  return apiJson({ success: true, message: "에이전트가 중지되었습니다." });
}
