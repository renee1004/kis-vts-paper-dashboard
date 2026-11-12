import { apiJson } from "@/lib/api-response";
import { isLocalRequestHeaders } from "@/lib/loopback";

export { isLocalRequestHeaders } from "@/lib/loopback";

/**
 * True only for a browser on this PC (http://localhost:3939 or 127.0.0.1).
 * Phone/LAN/Tailscale browsers send their own Host (Tailscale IP, MagicDNS name,
 * LAN IP) and a browser cannot forge Host/Origin, so they stay off key-save/arm/start.
 * This is an extra layer, not authentication: a crafted request can still send
 * Host: localhost. Shared-token auth in proxy.ts is the actual /api gate.
 */
export function isLocalRequest(request: Request): boolean {
  return isLocalRequestHeaders({
    host: request.headers.get("host"),
    origin: request.headers.get("origin"),
    secFetchSite: request.headers.get("sec-fetch-site"),
  });
}

/** Secret entry and arming/start controls stay on the PC (localhost) only. */
export function localOnlyResponse() {
  return apiJson(
    {
      success: false,
      error:
        "LOCALHOST_ONLY: 이 작업은 PC의 http://localhost:3939 에서만 할 수 있습니다. 원격(휴대폰·LAN·Tailscale)에서는 조회·안전잠금·중지만 가능합니다.",
    },
    { status: 403 },
  );
}
