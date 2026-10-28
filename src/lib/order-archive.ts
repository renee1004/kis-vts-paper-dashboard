import "server-only";
import fs from "node:fs";
import path from "node:path";
import type { VtsOrder } from "./domain";

/** Archive before eviction. On write failure the caller keeps its full history.
 * A crash before state saving can repeat an archived ID; consumers must dedupe by id.
 * Records deleted before this feature cannot be recovered.
 */
export function retainRecentBlockedOrders(orders: VtsOrder[], dataDir: string, limit = 100): VtsOrder[] {
  if (!Number.isInteger(limit) || limit < 0) throw new Error("INVALID_BLOCKED_RETENTION_LIMIT");
  let count = 0;
  const retained: VtsOrder[] = [], archived: VtsOrder[] = [];
  for (const order of orders) {
    if (order.status === "BLOCKED" && ++count > limit) archived.push(order);
    else retained.push(order);
  }
  if (archived.length) {
    fs.mkdirSync(dataDir, { recursive: true });
    const file = path.join(dataDir, "blocked-orders.jsonl");
    const fd = fs.openSync(file, "a", 0o600);
    try {
      fs.writeFileSync(fd, archived.map(order => JSON.stringify(order)).join("\n") + "\n", "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  return retained;
}
