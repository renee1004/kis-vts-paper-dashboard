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
 * This is an extra layer on key-save/arm/start, not dashboard authentication.
 * Host/Origin can be spoofed on a crafted non-browser request.
 */
export function isLocalRequestHeaders(input: {
  host: string | null;
  origin: string | null;
  secFetchSite: string | null;
}): boolean {
  const host = hostnameOf(input.host);
  if (!host || !LOOPBACK_HOSTS.has(host)) return false;
  if (input.origin !== null) {
    const originHost = hostnameOf(input.origin);
    if (!originHost || !LOOPBACK_HOSTS.has(originHost)) return false;
  }
  return input.secFetchSite !== "cross-site";
}
