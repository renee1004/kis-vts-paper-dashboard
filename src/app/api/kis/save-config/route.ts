import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { VTS_BASE_URL } from "@/lib/domain";
import { forceSafetyLock, getPublicKisConfig } from "@/lib/safety";
import { clearTokenCache } from "@/lib/kis-vts-client";
import { resetDiagnostics, saveSecrets } from "@/lib/store";

const schema = z.object({
  appKey: z.string().trim().min(1).max(200),
  appSecret: z.string().trim().min(1).max(300),
  accountNo: z.string().trim().regex(/^\d{8}$/, "계좌번호는 8자리 숫자입니다."),
  productCode: z.string().trim().regex(/^\d{2}$/, "상품코드는 2자리 숫자입니다."),
  baseUrl: z.literal(VTS_BASE_URL),
});

export async function GET() {
  return NextResponse.json({ success: true, data: getPublicKisConfig() });
}

export async function POST(request: NextRequest) {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error: "INVALID_KIS_CONFIG",
        fields: parsed.error.issues.map((issue) => issue.path.join(".")),
      },
      { status: 400 },
    );
  }

  saveSecrets({
    appKey: parsed.data.appKey,
    appSecret: parsed.data.appSecret,
    accountNo: parsed.data.accountNo,
    productCode: parsed.data.productCode,
  });
  resetDiagnostics();
  clearTokenCache();
  forceSafetyLock("KIS_CONFIG_CHANGED");

  return NextResponse.json({
    success: true,
    data: getPublicKisConfig(),
    message: "설정 저장 완료. 민감정보는 응답에 포함되지 않습니다.",
  });
}
