export const VTS_BASE_URL = "https://openapivts.koreainvestment.com:29443";

/** Conservative USD→KRW rate for combined daily buy cap (domestic + US). */
export const USD_KRW_SAFETY_RATE = 1_500;

export type TradingMarket = "DOMESTIC" | "US_NASDAQ";

export type OrderCurrency = "KRW" | "USD";

export type SafetyMode =
  | "SAFE_LOCKED"
  | "VTS_AUTO_READY"
  | "VTS_AUTO_ARMED"
  | "REAL_BLOCKED"
  | "ERROR";

export type DiagnosticPhase =
  | "token"
  | "domesticCandle"
  | "domesticPrice"
  | "domesticBalance"
  | "overseasCandle"
  | "overseasPrice"
  | "overseasBalance"
  | "paperOrder"
  | "vtsOrder"
  | "vtsExecution"
  | "overseasExecution";

export interface KisLastError {
  phase: DiagnosticPhase;
  stockCode: string | null;
  endpointPath: string;
  trId: string | null;
  server: "vts";
  httpStatus: number | null;
  rt_cd: string | null;
  msg_cd: string | null;
  msg1: string;
  probableCauses: string[];
  timestamp: string;
}

export interface CycleSummary {
  stocksAnalyzed: number;
  usStocksAnalyzed: number;
  signalsGenerated: number;
  ordersPlaced: number;
  tokenSuccess: number;
  tokenFailed: number;
  candleSuccess: number;
  candleFailed: number;
  priceSuccess: number;
  priceFailed: number;
  balanceSuccess: number;
  balanceFailed: number;
  overseasCandleSuccess: number;
  overseasCandleFailed: number;
  overseasPriceSuccess: number;
  overseasPriceFailed: number;
  overseasBalanceSuccess: number;
  overseasBalanceFailed: number;
  paperOrderSuccess: number;
  paperOrderFailed: number;
  vtsOrderSuccess: number;
  vtsOrderFailed: number;
}

export interface SafetySettings {
  effectiveSafetyMode: SafetyMode;
  tradingMode: "DEMO";
  orderExecutionMode: "VTS_MOCK";
  killSwitchEnabled: boolean;
  autoDomesticOrderEnabled: boolean;
  autoOverseasOrderEnabled: boolean;
  autoExitEnabled: boolean;
  allowRealDomesticOrder: false;
  allowRealOverseasOrder: false;
  allowStrategyTestOrder: boolean;
  allowRealFallback: false;
  pipelineTestEnabled: boolean;
}

export interface KisSecrets {
  appKey: string;
  appSecret: string;
  accountNo: string;
  productCode: string;
}

export interface PublicKisConfig {
  configured: boolean;
  appKeyLoaded: boolean;
  appSecretLoaded: boolean;
  accountLoaded: boolean;
  productCodeLoaded: boolean;
  baseUrlType: "vts";
  configSource: "env" | "encrypted-file";
  missingKeys: string[];
  allowRealFallback: false;
  isDemo: true;
}

export interface WatchlistItem {
  id: string;
  market: TradingMarket;
  stockCode: string;
  stockName: string;
  currency: OrderCurrency;
  candleStatus: "PENDING" | "SUCCESS" | "FAILED";
  priceStatus: "PENDING" | "SUCCESS" | "FAILED";
  analysis: "BUY" | "SELL" | "HOLD";
  confidence: number;
  buyScore: number;
  sellScore: number;
  blockedReason: string;
  currentPrice: number | null;
}

export interface Position {
  id: string;
  market: "DOMESTIC";
  stockCode: string;
  stockName: string;
  quantity: number;
  averagePrice: number;
  currentPrice: number;
  evaluation: number;
  purchaseAmount: number;
  profitLoss: number;
  profitRate: number;
  currency: "KRW";
  source: "KIS_BALANCE";
  lastSyncedAt: string;
}

export interface OverseasPosition {
  id: string;
  market: "US_NASDAQ";
  stockCode: string;
  stockName: string;
  exchange: "NASD";
  quantity: number;
  averagePrice: number;
  currentPrice: number;
  evaluation: number;
  purchaseAmount: number;
  profitLoss: number;
  profitRate: number;
  currency: "USD";
  source: "KIS_OVERSEAS_BALANCE";
  lastSyncedAt: string;
}

export interface BalanceSnapshot {
  cash: number;
  totalEvaluation: number;
  stockEvaluation: number;
  purchaseAmount: number;
  profitLoss: number;
  profitRate: number;
  holdingCount: number;
  syncedAt: string;
}

export interface OverseasBalanceSnapshot {
  cashUsd: number | null;
  totalEvaluationUsd: number;
  stockEvaluationUsd: number;
  purchaseAmountUsd: number;
  profitLossUsd: number;
  profitRate: number;
  holdingCount: number;
  currency: "USD";
  exchange: "NASD";
  syncedAt: string;
}

export type VtsOrderType = "MARKET" | "LIMIT";

export interface VtsOrder {
  id: string;
  timestamp: string;
  orderDate: string;
  market: TradingMarket;
  exchange: "KRX" | "NASD" | null;
  currency: OrderCurrency;
  stockCode: string;
  stockName: string;
  side: "BUY" | "SELL";
  quantity: number;
  filledQuantity: number;
  referencePrice: number;
  orderType: VtsOrderType;
  status:
    | "UNKNOWN"
    | "SUBMITTED"
    | "PARTIALLY_FILLED"
    | "FILLED"
    | "REJECTED"
    | "EXPIRED"
    | "BLOCKED";
  blockedReason: string | null;
  kisOrderNo: string | null;
  kisBranchNo: string | null;
  signalId: string | null;
  sessionId: string | null;
  ownershipScope: "AGENT_CREATED_ONLY";
  averageFillPrice?: number;
  exitReason?: string;
  positionId?: string;
  stopFraction?: number;
  strategyVersion?: string;
  signalDate?: string;
  /** Set only on rows imported from KIS fill history (auditable, reversible). */
  importSource?: string;
}

export interface AgentOwnedPosition {
  market: TradingMarket;
  stockCode: string;
  stockName: string;
  quantity: number;
  currency: OrderCurrency;
  updatedAt: string;
}

export interface PaperOrder {
  id: string;
  timestamp: string;
  market: TradingMarket;
  stockCode: string;
  stockName: string;
  side: "BUY" | "SELL";
  quantity: number;
  price: number;
  orderType: "MARKET_SIMULATED";
  executionMode: "PAPER";
  status: "SIMULATED" | "BLOCKED";
  blockedReason: string | null;
  signalId: string | null;
  sessionId: string | null;
}

export interface AgentLog {
  id: string;
  level: "INFO" | "WARN" | "ERROR";
  type:
    | "INFO"
    | "WARN"
    | "ERROR"
    | "RISK"
    | "SIGNAL"
    | "PAPER_ORDER"
    | "BLOCKED_ORDER"
    | "KIS_DIAGNOSTIC";
  message: string;
  createdAt: string;
}

export const US_NASDAQ_WATCHLIST: Array<[string, string]> = [
  ["AAPL", "Apple"],
  ["NVDA", "NVIDIA"],
  ["AMD", "AMD"],
  ["AMZN", "Amazon"],
  ["MSFT", "Microsoft"],
];

export const EMPTY_CYCLE_SUMMARY: CycleSummary = {
  stocksAnalyzed: 0,
  usStocksAnalyzed: 0,
  signalsGenerated: 0,
  ordersPlaced: 0,
  tokenSuccess: 0,
  tokenFailed: 0,
  candleSuccess: 0,
  candleFailed: 0,
  priceSuccess: 0,
  priceFailed: 0,
  balanceSuccess: 0,
  balanceFailed: 0,
  overseasCandleSuccess: 0,
  overseasCandleFailed: 0,
  overseasPriceSuccess: 0,
  overseasPriceFailed: 0,
  overseasBalanceSuccess: 0,
  overseasBalanceFailed: 0,
  paperOrderSuccess: 0,
  paperOrderFailed: 0,
  vtsOrderSuccess: 0,
  vtsOrderFailed: 0,
};

export const DEFAULT_SAFETY_SETTINGS: SafetySettings = {
  effectiveSafetyMode: "SAFE_LOCKED",
  tradingMode: "DEMO",
  orderExecutionMode: "VTS_MOCK",
  killSwitchEnabled: true,
  autoDomesticOrderEnabled: false,
  autoOverseasOrderEnabled: false,
  autoExitEnabled: false,
  allowRealDomesticOrder: false,
  allowRealOverseasOrder: false,
  allowStrategyTestOrder: false,
  allowRealFallback: false,
  pipelineTestEnabled: false,
};

export function agentPositionKey(market: TradingMarket, stockCode: string): string {
  return `${market}:${stockCode}`;
}

export function buyNotionalKrw(
  order: Pick<VtsOrder, "side" | "status" | "quantity" | "filledQuantity" | "referencePrice" | "currency">,
): number {
  if (order.side !== "BUY") return 0;
  if (["REJECTED", "BLOCKED"].includes(order.status)) return 0;
  const qty =
    order.status === "SUBMITTED" || order.status === "PARTIALLY_FILLED" || order.status === "UNKNOWN"
      ? order.quantity
      : Math.max(order.filledQuantity, 0);
  const notional =
    order.currency === "USD"
      ? qty * order.referencePrice * USD_KRW_SAFETY_RATE
      : qty * order.referencePrice;
  return notional;
}
