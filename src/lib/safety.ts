import "server-only";

import { PublicKisConfig, SafetyMode, TradingMarket } from "@/lib/domain";
import { isUsRegularMarketOpen, isDomesticRegularMarketOpen } from "@/lib/market-hours";
import { addLog, loadSecrets, saveState, state } from "@/lib/store";

const REAL_HOST_MARKER = "openapi.koreainvestment.com";

export function getPublicKisConfig(): PublicKisConfig {
  const config = loadSecrets();
  const fromEnv = Boolean(
    process.env.KIS_APP_KEY &&
      process.env.KIS_APP_SECRET &&
      process.env.KIS_ACCOUNT_NO &&
      process.env.KIS_ACCOUNT_PRODUCT_CODE,
  );
  const missingKeys: string[] = [];
  if (!config?.appKey) missingKeys.push("KIS_APP_KEY");
  if (!config?.appSecret) missingKeys.push("KIS_APP_SECRET");
  if (!config?.accountNo) missingKeys.push("KIS_ACCOUNT_NO");
  if (!config?.productCode) missingKeys.push("KIS_ACCOUNT_PRODUCT_CODE");

  return {
    configured: missingKeys.length === 0,
    appKeyLoaded: Boolean(config?.appKey),
    appSecretLoaded: Boolean(config?.appSecret),
    accountLoaded: Boolean(config?.accountNo),
    productCodeLoaded: Boolean(config?.productCode),
    baseUrlType: "vts",
    configSource: fromEnv ? "env" : "encrypted-file",
    missingKeys,
    allowRealFallback: false,
    isDemo: true,
  };
}

export function assertSafeEnvironment(): void {
  const unsafeValues = [
    process.env.KIS_BASE_URL,
    process.env.TRADING_MODE,
    process.env.ORDER_EXECUTION_MODE,
  ].filter(Boolean);

  if (
    unsafeValues.some((value) => value?.includes(REAL_HOST_MARKER)) ||
    process.env.TRADING_MODE === "REAL" ||
    process.env.ORDER_EXECUTION_MODE === "LIVE" ||
    process.env.ALLOW_REAL_DOMESTIC_ORDER === "true" ||
    process.env.ALLOW_REAL_OVERSEAS_ORDER === "true" ||
    process.env.KIS_ALLOW_REAL_FALLBACK === "true"
  ) {
    forceSafetyLock("REAL_CONFIGURATION_BLOCKED", "REAL_BLOCKED");
    throw new Error("REAL_CONFIGURATION_BLOCKED");
  }
}

export function computeSafetyMode(): SafetyMode {
  const kis = getPublicKisConfig();
  if (!kis.configured) return "SAFE_LOCKED";
  if (state.settings.allowRealDomesticOrder || state.settings.allowRealOverseasOrder) {
    return "REAL_BLOCKED";
  }
  if (
    state.prepared &&
    state.settings.pipelineTestEnabled &&
    !state.settings.killSwitchEnabled &&
    (state.settings.autoDomesticOrderEnabled ||
      state.settings.autoOverseasOrderEnabled) &&
    state.settings.allowStrategyTestOrder
  ) {
    return "VTS_AUTO_ARMED";
  }
  if (state.prepared) return "VTS_AUTO_READY";
  return "SAFE_LOCKED";
}

function baseOrderGate(): { allowed: boolean; reason: string } {
  const kis = getPublicKisConfig();
  if (!kis.configured) return { allowed: false, reason: "KIS_NOT_CONFIGURED" };
  if (state.settings.tradingMode !== "DEMO") {
    return { allowed: false, reason: "TRADING_MODE_NOT_DEMO" };
  }
  if (state.settings.orderExecutionMode !== "VTS_MOCK") {
    return { allowed: false, reason: "EXECUTION_MODE_NOT_VTS_MOCK" };
  }
  if (state.settings.allowRealFallback) {
    return { allowed: false, reason: "REAL_FALLBACK_BLOCKED" };
  }
  if (state.settings.allowRealDomesticOrder || state.settings.allowRealOverseasOrder) {
    return { allowed: false, reason: "REAL_ORDER_FLAGS_BLOCKED" };
  }
  if (!state.prepared) return { allowed: false, reason: "VTS_NOT_PREPARED" };
  if (state.settings.killSwitchEnabled) {
    return { allowed: false, reason: "SAFE_LOCKED" };
  }
  if (!state.settings.pipelineTestEnabled || !state.settings.allowStrategyTestOrder) {
    return { allowed: false, reason: "PIPELINE_TEST_NOT_ARMED" };
  }
  return { allowed: true, reason: "VTS_MOCK_ONLY" };
}

export function getOrderDecision(market: TradingMarket = "DOMESTIC"): {
  allowed: boolean;
  reason: string;
} {
  const gate = baseOrderGate();
  if (!gate.allowed) return gate;
  if (market === "DOMESTIC" && !isDomesticRegularMarketOpen()) return { allowed: false, reason: "DOMESTIC_MARKET_CLOSED" };
  if (market === "DOMESTIC" && !state.settings.autoDomesticOrderEnabled) {
    return { allowed: false, reason: "AUTO_DOMESTIC_ORDER_DISABLED" };
  }
  if (market === "US_NASDAQ" && !state.settings.autoOverseasOrderEnabled) {
    return { allowed: false, reason: "AUTO_OVERSEAS_ORDER_DISABLED" };
  }
  if (market === "US_NASDAQ" && !isUsRegularMarketOpen()) {
    return { allowed: false, reason: "US_MARKET_CLOSED" };
  }
  return { allowed: true, reason: "VTS_MOCK_ONLY" };
}

export function getOverseasOrderDecision(): { allowed: boolean; reason: string } {
  return getOrderDecision("US_NASDAQ");
}

export function canPlaceDomesticOrderNow(): boolean {
  return getOrderDecision("DOMESTIC").allowed;
}

export function canPlaceOverseasOrderNow(): boolean {
  return getOrderDecision("US_NASDAQ").allowed;
}

export function markVtsReady(): void {
  assertSafeEnvironment();
  if (!getPublicKisConfig().configured) throw new Error("KIS_NOT_CONFIGURED");
  state.prepared = true;
  state.settings = {
    ...state.settings,
    effectiveSafetyMode: "VTS_AUTO_READY",
    killSwitchEnabled: true,
    autoDomesticOrderEnabled: false,
    autoOverseasOrderEnabled: false,
    allowStrategyTestOrder: false,
    pipelineTestEnabled: false,
  };
  addLog("RISK", "VTS 연결 확인 완료. 모의 자동주문 준비 상태이며 주문은 잠겨 있습니다.");
  saveState();
}

export function armVtsPaper(confirm: string): void {
  assertSafeEnvironment();
  if (confirm !== "ARM_VTS_AUTO_ONLY") throw new Error("ARM_CONFIRMATION_REQUIRED");
  if (!state.prepared) throw new Error("VTS_NOT_PREPARED");
  if (!getPublicKisConfig().configured) throw new Error("KIS_NOT_CONFIGURED");
  state.settings = {
    ...state.settings,
    effectiveSafetyMode: "VTS_AUTO_ARMED",
    killSwitchEnabled: false,
    autoDomesticOrderEnabled: true,
    autoOverseasOrderEnabled: true,
    autoExitEnabled: true,
    allowStrategyTestOrder: true,
    pipelineTestEnabled: true,
  };
  addLog(
    "RISK",
    "KIS VTS 모의 자동주문이 활성화되었습니다. 국내·미국(NASDAQ) 모의주문 대상이며 에이전트가 매수·체결한 수량만 자동매도합니다.",
    "WARN",
  );
  saveState();
}

export function forceSafetyLock(
  reason = "USER_REQUESTED",
  mode: SafetyMode = "SAFE_LOCKED",
): void {
  state.isRunning = false;
  state.sessionId = null;
  state.prepared = false;
  state.settings = {
    ...state.settings,
    effectiveSafetyMode: mode,
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
  addLog("RISK", `즉시 안전잠금: ${reason}`, "WARN");
  saveState();
}

/** The production transport remains an executable invariant. */
export function submitRealDomesticOrder(): never {
  throw new Error("REAL_ORDER_DISABLED");
}
