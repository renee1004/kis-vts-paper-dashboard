import { NextResponse } from "next/server";
import {
  applyPre0911Import,
  previewPre0911Import,
  PRE_0911_APPLY_CONFIRM,
  PRE_0911_REVERT_CONFIRM,
  REBASE_STOPS_CONFIRM,
  rebaseImportedStops,
  revertPre0911Import,
} from "@/lib/fill-import";
import { isLocalRequest, localOnlyResponse } from "@/lib/local-request";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ success: true, data: previewPre0911Import() });
}

export async function POST(request: Request) {
  if (!isLocalRequest(request)) return localOnlyResponse();
  const origin = request.headers.get("origin");
  let sameOrigin = !origin;
  try {
    sameOrigin = !origin || new URL(origin).host === (request.headers.get("host") ?? new URL(request.url).host);
  } catch { sameOrigin = false; }
  if (!sameOrigin || request.headers.get("sec-fetch-site") === "cross-site")
    return NextResponse.json({ success: false, error: "CROSS_SITE_REQUEST_BLOCKED" }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { action?: string; confirm?: string };
  try {
    if (body.action === "APPLY" && body.confirm === PRE_0911_APPLY_CONFIRM)
      return NextResponse.json({ success: true, data: applyPre0911Import() });
    if (body.action === "REBASE_STOPS" && body.confirm === REBASE_STOPS_CONFIRM)
      return NextResponse.json({ success: true, data: rebaseImportedStops() });
    if (body.action === "REVERT" && body.confirm === PRE_0911_REVERT_CONFIRM)
      return NextResponse.json({ success: true, data: revertPre0911Import() });
    return NextResponse.json({ success: false, error: "CONFIRMATION_REQUIRED" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "IMPORT_FAILED" }, { status: 400 });
  }
}