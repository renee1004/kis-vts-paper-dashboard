import { NextResponse } from "next/server";
import { state } from "@/lib/store";
import { refreshResearchNews, researchView } from "@/lib/news-research";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET() {
  try { return NextResponse.json({ success: true, data: researchView([...state.watchlist, ...state.usWatchlist]) }); }
  catch { return NextResponse.json({ success: false, error: "뉴스 비교 원장을 읽을 수 없습니다. 자동 초기화하지 않습니다." }, { status: 500 }); }
}
export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  let sameOrigin = !origin;
  try {
    // Next may construct request.url using the internal bind hostname.
    // Browser Origin must match the incoming Host, not that internal URL.
    sameOrigin = !origin || new URL(origin).host === (request.headers.get("host") ?? new URL(request.url).host);
  } catch { sameOrigin = false; }
  if (!sameOrigin || request.headers.get("sec-fetch-site") === "cross-site")
    return NextResponse.json({ success: false, error: "다른 사이트에서 보낸 요청은 허용하지 않습니다." }, { status: 403 });
  try {
    await refreshResearchNews([...state.watchlist, ...state.usWatchlist]);
    return GET();
  } catch { return NextResponse.json({ success: false, error: "뉴스 수집·저장 실패. 기존 원장을 확인하세요." }, { status: 500 }); }
}
