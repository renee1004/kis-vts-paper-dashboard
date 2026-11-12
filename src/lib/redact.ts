const ACCOUNT_PLACEHOLDER = "[REDACTED]";

/** Mask account-like numbers: 8-2 (CANO-product), 10 digits, then 8 digits. */
export function redactSensitiveText(value: string): string {
  return value
    .replace(/\d{8}-\d{2}/g, ACCOUNT_PLACEHOLDER)
    .replace(/\d{10}/g, ACCOUNT_PLACEHOLDER)
    .replace(/(?<!\d)\d{8}(?!\d)/g, ACCOUNT_PLACEHOLDER);
}

type SanitizeCtx = { inLastError: boolean; key?: string };

function shouldRedactString(ctx: SanitizeCtx): boolean {
  if (ctx.inLastError) return true;
  return (
    ctx.key === "error" ||
    ctx.key === "lastError" ||
    ctx.key === "msg1" ||
    ctx.key === "message" ||
    ctx.key === "probableCauses"
  );
}

function sanitize(value: unknown, ctx: SanitizeCtx): unknown {
  if (typeof value === "string") {
    return shouldRedactString(ctx) ? redactSensitiveText(value) : value;
  }
  if (Array.isArray(value)) {
    const inLastError =
      ctx.inLastError || ctx.key === "lastError" || ctx.key === "probableCauses";
    return value.map((item) =>
      sanitize(item, { inLastError, key: ctx.key }),
    );
  }
  if (value && typeof value === "object") {
    const inLastError = ctx.inLastError || ctx.key === "lastError";
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        sanitize(item, { inLastError, key }),
      ]),
    );
  }
  return value;
}

/** Redact lastError objects and error/msg1/message strings before JSON responses. */
export function sanitizeApiPayload<T>(value: T): T {
  return sanitize(value, { inLastError: false }) as T;
}

export function sanitizeLastError<T>(error: T): T {
  return sanitize(error, { inLastError: true }) as T;
}
