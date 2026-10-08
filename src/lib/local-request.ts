import { NextResponse } from "next/server";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function hostnameOf(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value.includes("://") ? value : `http://${value}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * True only for a browser on this PC (http://localhost:3939 or 127.0.0.1).
 * Phone/LAN/Tailscale browsers send their own Host (Tailscale IP, MagicDNS name,
 * LAN IP) and a browser cannot forge Host/Origin, so they get read-only access.
 * The dashboard has no login: this is not a defence against a hand-crafted
 * non-browser request from inside the private network.
 */
export function isLocalRequest(request: Request): boolean {
  const host = hostnameOf(request.headers.get("host"));
  if (!host || !LOOPBACK_HOSTS.has(host)) return false;
  const origin = request.headers.get("origin");
  if (origin !== null) {
    const originHost = hostnameOf(origin);
    if (!originHost || !LOOPBACK_HOSTS.has(originHost)) return false;
  }
  return request.headers.get("sec-fetch-site") !== "cross-site";
}

/** Secret entry and arming/start controls stay on the PC (localhost) only. */
export function localOnlyResponse(): NextResponse {
  return NextResponse.json(
    {
      success: false,
      error:
        "LOCALHOST_ONLY: 이 작업은 PC의 http://localhost:3939 에서만 할 수 있습니다. 원격(휴대폰·LAN·Tailscale)에서는 조회·안전잠금·중지만 가능합니다.",
    },
    { status: 403 },
  );
}
