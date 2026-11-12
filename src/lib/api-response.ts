import { NextResponse } from "next/server";
import { sanitizeApiPayload } from "@/lib/redact";

/** JSON response with account-like numbers stripped from error/lastError text. */
export function apiJson(body: unknown, init?: ResponseInit): NextResponse {
  return NextResponse.json(sanitizeApiPayload(body), init);
}
