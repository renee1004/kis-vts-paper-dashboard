import "server-only";

import crypto from "node:crypto";
import { ownedLot } from "@/lib/ownership";
import fs from "node:fs";
import path from "node:path";
import {
  AgentOwnedPosition,
  AgentLog,
  BalanceSnapshot,
  CycleSummary,
  DEFAULT_SAFETY_SETTINGS,
  EMPTY_CYCLE_SUMMARY,
  KisLastError,
  KisSecrets,
  OrderCurrency,
  OverseasBalanceSnapshot,
  OverseasPosition,
  PaperOrder,
  Position,
  SafetySettings,
  TradingMarket,
  US_NASDAQ_WATCHLIST,
  VtsOrder,
  WatchlistItem,
} from "@/lib/domain";

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), ".data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const KEY_FILE = path.join(DATA_DIR, "master.key");
const SECRET_FILE = path.join(DATA_DIR, "kis-config.enc");

const DEFAULT_WATCHLIST: Array<[string, string]> = [
  ["005930", "삼성전자"],
  ["000660", "SK하이닉스"],
  ["035420", "NAVER"],
  ["005380", "현대차"],
  ["051910", "LG화학"],
  ["006400", "삼성SDI"],
  ["003670", "포스코홀딩스"],
  ["000720", "현대건설"],
  ["069500", "KODEX 200"],
  ["005935", "삼성전자우"],
];

interface RuntimeState {
  strategyRisk: { date: string; startPnl: number };
  isRunning: boolean;
  sessionId: string | null;
  settings: SafetySettings;
  prepared: boolean;
  lastCycleSummary: CycleSummary;
  lastError: KisLastError | null;
  lastCycleAt: string | null;
  watchlist: WatchlistItem[];
  usWatchlist: WatchlistItem[];
  positions: Position[];
  overseasPositions: OverseasPosition[];
  balanceSnapshot: BalanceSnapshot | null;
  overseasBalanceSnapshot: OverseasBalanceSnapshot | null;
  paperOrders: PaperOrder[];
  tradeHistory: PaperOrder[];
  vtsOrders: VtsOrder[];
  agentOwnedPositions: AgentOwnedPosition[];
  logs: AgentLog[];
  updatedAt: string;
}

function initialDomesticWatchlist(): WatchlistItem[] {
  return DEFAULT_WATCHLIST.map(([stockCode, stockName]) => ({
    id: crypto.randomUUID(),
    market: "DOMESTIC" as const,
    stockCode,
    stockName,
    currency: "KRW" as const,
    candleStatus: "PENDING",
    priceStatus: "PENDING",
    analysis: "HOLD",
    confidence: 0,
    buyScore: 0,
    sellScore: 0,
    blockedReason: "SAFE_LOCKED",
    currentPrice: null,
  }));
}

function initialUsWatchlist(): WatchlistItem[] {
  return US_NASDAQ_WATCHLIST.map(([stockCode, stockName]) => ({
    id: crypto.randomUUID(),
    market: "US_NASDAQ" as const,
    stockCode,
    stockName,
    currency: "USD" as const,
    candleStatus: "PENDING",
    priceStatus: "PENDING",
    analysis: "HOLD",
    confidence: 0,
    buyScore: 0,
    sellScore: 0,
    blockedReason: "SAFE_LOCKED",
    currentPrice: null,
  }));
}

function initialState(): RuntimeState {
  return {
    strategyRisk: { date: "", startPnl: 0 },
    isRunning: false,
    sessionId: null,
    settings: { ...DEFAULT_SAFETY_SETTINGS },
    prepared: false,
    lastCycleSummary: { ...EMPTY_CYCLE_SUMMARY },
    lastError: null,
    lastCycleAt: null,
    watchlist: initialDomesticWatchlist(),
    usWatchlist: initialUsWatchlist(),
    positions: [],
    overseasPositions: [],
    balanceSnapshot: null,
    overseasBalanceSnapshot: null,
    paperOrders: [],
    tradeHistory: [],
    vtsOrders: [],
    agentOwnedPositions: [],
    logs: [],
    updatedAt: new Date().toISOString(),
  };
}

function migrateWatchlistItem(
  item: Partial<WatchlistItem> & { stockCode: string; stockName: string },
  market: TradingMarket,
  currency: OrderCurrency,
): WatchlistItem {
  return {
    id: item.id ?? crypto.randomUUID(),
    market: item.market ?? market,
    stockCode: item.stockCode,
    stockName: item.stockName,
    currency: item.currency ?? currency,
    candleStatus: item.candleStatus ?? "PENDING",
    priceStatus: item.priceStatus ?? "PENDING",
    analysis: item.analysis ?? "HOLD",
    confidence: item.confidence ?? 0,
    buyScore: item.buyScore ?? 0,
    sellScore: item.sellScore ?? 0,
    blockedReason: item.blockedReason ?? "SAFE_LOCKED",
    currentPrice: item.currentPrice ?? null,
  };
}

function migrateVtsOrder(order: Partial<VtsOrder> & Pick<VtsOrder, "id" | "stockCode" | "stockName">): VtsOrder {
  const isUs = /^[A-Z]{1,5}$/.test(order.stockCode);
  const market = order.market ?? (isUs ? "US_NASDAQ" : "DOMESTIC");
  const currency = order.currency ?? (market === "US_NASDAQ" ? "USD" : "KRW");
  return {
    id: order.id,
    timestamp: order.timestamp ?? new Date().toISOString(),
    orderDate: order.orderDate ?? "",
    market,
    exchange:
      order.exchange ??
      (market === "US_NASDAQ" ? "NASD" : market === "DOMESTIC" ? "KRX" : null),
    currency,
    stockCode: order.stockCode,
    stockName: order.stockName,
    side: order.side ?? "BUY",
    quantity: order.quantity ?? 0,
    filledQuantity: order.filledQuantity ?? 0,
    referencePrice: order.referencePrice ?? 0,
    orderType:
      order.orderType ?? (market === "US_NASDAQ" ? "LIMIT" : "MARKET"),
    status: order.status ?? "BLOCKED",
    blockedReason: order.blockedReason ?? null,
    kisOrderNo: order.kisOrderNo ?? null,
    kisBranchNo: order.kisBranchNo ?? null,
    signalId: order.signalId ?? null,
    sessionId: order.sessionId ?? null,
    ownershipScope: "AGENT_CREATED_ONLY",
    averageFillPrice: order.averageFillPrice,
    exitReason: order.exitReason,
    positionId: order.positionId,
    stopFraction: order.stopFraction,
    strategyVersion: order.strategyVersion,
    signalDate: order.signalDate,
  };
}

function migratePosition(position: Partial<Position> & { stockCode: string }): Position {
  return {
    id: position.id ?? position.stockCode,
    market: "DOMESTIC",
    stockCode: position.stockCode,
    stockName: position.stockName ?? "종목명 없음",
    quantity: position.quantity ?? 0,
    averagePrice: position.averagePrice ?? 0,
    currentPrice: position.currentPrice ?? 0,
    evaluation: position.evaluation ?? 0,
    purchaseAmount: position.purchaseAmount ?? 0,
    profitLoss: position.profitLoss ?? 0,
    profitRate: position.profitRate ?? 0,
    currency: "KRW",
    source: "KIS_BALANCE",
    lastSyncedAt: position.lastSyncedAt ?? new Date().toISOString(),
  };
}

function migrateRuntimeState(parsed: Partial<RuntimeState>): RuntimeState {
  const base = initialState();
  const settings = {
    ...DEFAULT_SAFETY_SETTINGS,
    ...(parsed.settings ?? {}),
    killSwitchEnabled: true,
    autoDomesticOrderEnabled: false,
    autoOverseasOrderEnabled: false,
    autoExitEnabled: false,
    allowStrategyTestOrder: false,
    pipelineTestEnabled: false,
    effectiveSafetyMode: "SAFE_LOCKED" as const,
    allowRealDomesticOrder: false as const,
    allowRealOverseasOrder: false as const,
    allowRealFallback: false as const,
    tradingMode: "DEMO" as const,
    orderExecutionMode: "VTS_MOCK" as const,
  };

  const watchlist =
    parsed.watchlist?.length
      ? parsed.watchlist.map((item) =>
          migrateWatchlistItem(item, "DOMESTIC", "KRW"),
        )
      : base.watchlist;

  const usWatchlist =
    parsed.usWatchlist?.length
      ? parsed.usWatchlist.map((item) =>
          migrateWatchlistItem(item, "US_NASDAQ", "USD"),
        )
      : base.usWatchlist;

  const vtsOrders = (parsed.vtsOrders ?? []).map((order) => migrateVtsOrder(order));
  const positions = (parsed.positions ?? []).map((position) => migratePosition(position));

  return {
    ...base,
    ...parsed,
    strategyRisk: parsed.strategyRisk ?? base.strategyRisk,
    isRunning: false,
    sessionId: null,
    prepared: false,
    settings,
    lastCycleSummary: {
      ...EMPTY_CYCLE_SUMMARY,
      ...(parsed.lastCycleSummary ?? {}),
      ordersPlaced: 0,
    },
    watchlist,
    usWatchlist,
    positions,
    overseasPositions: parsed.overseasPositions ?? [],
    overseasBalanceSnapshot: parsed.overseasBalanceSnapshot ?? null,
    vtsOrders,
    agentOwnedPositions: (parsed.agentOwnedPositions ?? []).map((position) => ({
      market: position.market ?? (/^\d{6}$/.test(position.stockCode) ? "DOMESTIC" : "US_NASDAQ"),
      stockCode: position.stockCode,
      stockName: position.stockName,
      quantity: position.quantity,
      currency: position.currency ?? (/^\d{6}$/.test(position.stockCode) ? "KRW" : "USD"),
      updatedAt: position.updatedAt ?? new Date().toISOString(),
    })),
    paperOrders: (parsed.paperOrders ?? []).map((order) => ({
      ...order,
      market: order.market ?? "DOMESTIC",
    })),
    tradeHistory: (parsed.tradeHistory ?? []).map((order) => ({
      ...order,
      market: order.market ?? "DOMESTIC",
    })),
    logs: parsed.logs ?? [],
  };
}

function ensureDataDir(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

function loadState(): RuntimeState {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as Partial<RuntimeState>;
    return migrateRuntimeState(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return initialState();
    throw new Error("STATE_FILE_UNREADABLE_RESTORE_BACKUP_BEFORE_TRADING");
  }
}

const globalState = globalThis as typeof globalThis & {
  __vtsPaperState?: RuntimeState;
};

export const state = globalState.__vtsPaperState ?? loadState();
globalState.__vtsPaperState = state;

export function saveState(): void {
  ensureDataDir();
  state.updatedAt = new Date().toISOString();
  const temporaryFile = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(state, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(temporaryFile, STATE_FILE);
}

function getMasterKey(): Buffer {
  ensureDataDir();
  if (fs.existsSync(KEY_FILE)) {
    const key = fs.readFileSync(KEY_FILE);
    if (key.length === 32) return key;
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, key, { mode: 0o600 });
  return key;
}

export function saveSecrets(secrets: KisSecrets): void {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getMasterKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(secrets), "utf8"),
    cipher.final(),
  ]);
  const payload = {
    v: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64"),
  };
  fs.writeFileSync(SECRET_FILE, JSON.stringify(payload), {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function loadSecrets(): KisSecrets | null {
  const env = {
    appKey: process.env.KIS_APP_KEY ?? "",
    appSecret: process.env.KIS_APP_SECRET ?? "",
    accountNo: process.env.KIS_ACCOUNT_NO ?? "",
    productCode: process.env.KIS_ACCOUNT_PRODUCT_CODE ?? "",
  };
  if (Object.values(env).every(Boolean)) return env;

  try {
    const payload = JSON.parse(fs.readFileSync(SECRET_FILE, "utf8")) as {
      iv: string;
      tag: string;
      data: string;
    };
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      getMasterKey(),
      Buffer.from(payload.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(payload.data, "base64")),
      decipher.final(),
    ]);
    return JSON.parse(decrypted.toString("utf8")) as KisSecrets;
  } catch {
    return null;
  }
}

export function addLog(
  type: AgentLog["type"],
  message: string,
  level: AgentLog["level"] = "INFO",
): void {
  // Messages are fixed server-side strings. Never pass KIS bodies or credentials here.
  state.logs.unshift({
    id: crypto.randomUUID(),
    type,
    level,
    message: message.slice(0, 240),
    createdAt: new Date().toISOString(),
  });
  state.logs = state.logs.slice(0, 100);
  saveState();
}

export function setLastError(error: KisLastError | null): void {
  state.lastError = error;
  saveState();
}

export function setBalanceSnapshot(snapshot: BalanceSnapshot): void {
  state.balanceSnapshot = snapshot;
  saveState();
}

export function setOverseasBalanceSnapshot(snapshot: OverseasBalanceSnapshot): void {
  state.overseasBalanceSnapshot = snapshot;
  saveState();
}

// Counters describe the current credentials. Changing them must not leave old failures on screen.
export function resetDiagnostics(): void {
  state.lastCycleSummary = { ...EMPTY_CYCLE_SUMMARY };
  state.lastError = null;
  state.balanceSnapshot = null;
  state.overseasBalanceSnapshot = null;
  state.positions = [];
  state.overseasPositions = [];
  saveState();
}

export function rebuildAgentOwnedPositions(): void {
  const symbols = new Map(state.vtsOrders.map((o) => [o.market + ":" + o.stockCode, o]));
  state.agentOwnedPositions = [...symbols.values()].flatMap((o) => {
    const lot = ownedLot(state.vtsOrders, o.market, o.stockCode);
    return lot.quantity > 0 ? [{ market: o.market, stockCode: o.stockCode, stockName: o.stockName,
      currency: o.currency, quantity: lot.quantity, updatedAt: new Date().toISOString() }] : [];
  });
  saveState();
}

export function resetHistory(): { tradeHistory: number; agentLog: number } {
  const deleted = {
    tradeHistory: state.tradeHistory.length,
    agentLog: state.logs.length,
  };
  state.tradeHistory = [];
  state.logs = [];
  saveState();
  return deleted;
}

export function findAgentOwnedQuantity(market: TradingMarket, stockCode: string): number {
  return (
    state.agentOwnedPositions.find(
      (position) => position.market === market && position.stockCode === stockCode,
    )?.quantity ?? 0
  );
}
