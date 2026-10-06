import "server-only";

import {
  BalanceSnapshot,
  DiagnosticPhase,
  KisLastError,
  OverseasBalanceSnapshot,
  OverseasPosition,
  Position,
  VTS_BASE_URL,
} from "@/lib/domain";
import { addLog, loadSecrets, saveSecrets, setLastError, state } from "@/lib/store";
import { completedBars, type DailyBar } from "@/lib/strategy";
import { domesticMarketDate, usMarketDate } from "@/lib/market-hours";
import { assertSafeEnvironment, getOrderDecision } from "@/lib/safety";

interface KisEnvelope {
  rt_cd?: unknown;
  msg_cd?: unknown;
  msg1?: unknown;
  output?: unknown;
  output1?: unknown;
  output2?: unknown;
  access_token?: unknown;
  expires_in?: unknown;
}

export interface VtsOrderAcceptance {
  orderNo: string;
  branchNo: string;
  orderTime: string;
}

export interface VtsExecution {
  orderDate: string;
  orderNo: string;
  branchNo: string;
  stockCode: string;
  filledQuantity: number;
  averageFillPrice: number;
}

let tokenCache: { token: string; expiresAt: number } | null = null;

export function clearTokenCache(): void {
  tokenCache = null;
}
let requestQueue = Promise.resolve();
let lastRequestAt = 0;

function safeText(value: unknown, fallback = ""): string {
  if (typeof value !== "string" && typeof value !== "number") return fallback;
  // Diagnostic text is bounded and strips header-like secret material.
  return String(value)
    .replace(/(?:authorization|appkey|appsecret|access_token)\s*[:=]\s*\S+/gi, "[REDACTED]")
    .slice(0, 180);
}

function safeNumber(value: unknown): number {
  const parsed = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function records(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter(
      (row): row is Record<string, unknown> => Boolean(row) && typeof row === "object",
    );
  }
  return value && typeof value === "object"
    ? [value as Record<string, unknown>]
    : [];
}

function probableCauses(phase: DiagnosticPhase, httpStatus: number | null, body?: KisEnvelope | null): string[] {
  const common = [
    "KIS VTS 서버 일시 오류",
    "TR ID 또는 endpoint mismatch",
    "모의투자에서 지원하지 않는 조회",
    "계좌상품코드 오류",
    "토큰은 발급됐으나 조회 권한/환경 불일치",
  ];
  const code = safeText(body?.msg_cd);
  if (code === "EGW00201") {
    return ["KIS VTS 초당 거래건수 제한(EGW00201)", "연속 조회 간격을 늘린 뒤 재시도"];
  }
  if (code === "EGW00121" || code === "EGW00123") {
    return [
      "같은 App Key를 다른 PC나 서버에서 함께 사용하면 토큰이 서로 무효화됨",
      "한 곳에서만 실행한 뒤 다시 시도",
    ];
  }
  if (code === "OPSQ2000") {
    return [
      "모의 대회 계좌와 Open API에 등록한 계좌가 다를 수 있음",
      "KIS Developers > 나의 신청내역에서 앱키에 묶인 8자리 계좌를 확인",
      "국내주식 모의 상품코드는 보통 01, 선물옵션 모의는 03",
    ];
  }
  if (phase === "token") {
    return [
      "모의투자 App Key 또는 App Secret 불일치",
      "KIS VTS 토큰 발급 제한",
      "KIS VTS 서버 일시 오류",
    ];
  }
  return httpStatus === 429 ? ["KIS VTS 초당 거래건수 제한(EGW00201)", ...common] : common;
}

// The same App Key can only hold one live token, so another process issuing
// one invalidates ours. Re-issue instead of surfacing a token error.
function isTokenRejected(body: KisEnvelope | null): boolean {
  const code = safeText(body?.msg_cd);
  return code === "EGW00121" || code === "EGW00123";
}

function isRateLimited(body: KisEnvelope | null): boolean {
  const code = safeText(body?.msg_cd);
  const message = safeText(body?.msg1);
  return code === "EGW00201" || message.includes("초당 거래건수");
}

function isSharedQuoteTrId(trId: string): boolean {
  return trId.startsWith("HHDFS") || trId.startsWith("FHKST");
}

function assertVtsTrId(trId: string, allowSharedQuote = false): void {
  if (allowSharedQuote && isSharedQuoteTrId(trId)) return;
  if (!trId.startsWith("V")) {
    throw new Error("REAL_TR_ID_FORBIDDEN");
  }
}

function bumpPhase(phase: DiagnosticPhase, success: boolean): void {
  const suffix = success ? "Success" : "Failed";
  if (phase === "domesticPrice") state.lastCycleSummary[`price${suffix}`] += 1;
  if (phase === "domesticCandle") state.lastCycleSummary[`candle${suffix}`] += 1;
  if (phase === "domesticBalance") state.lastCycleSummary[`balance${suffix}`] += 1;
  if (phase === "overseasPrice") state.lastCycleSummary[`overseasPrice${suffix}`] += 1;
  if (phase === "overseasCandle") state.lastCycleSummary[`overseasCandle${suffix}`] += 1;
  if (phase === "overseasBalance") state.lastCycleSummary[`overseasBalance${suffix}`] += 1;
  if (phase === "vtsOrder") state.lastCycleSummary[`vtsOrder${suffix}`] += 1;
}

function recordError(input: {
  phase: DiagnosticPhase;
  stockCode?: string | null;
  endpointPath: string;
  trId?: string | null;
  httpStatus: number | null;
  body?: KisEnvelope | null;
  fallbackMessage: string;
}): KisLastError {
  const error: KisLastError = {
    phase: input.phase,
    stockCode: input.stockCode ?? null,
    endpointPath: input.endpointPath,
    trId: input.trId ?? null,
    server: "vts",
    httpStatus: input.httpStatus,
    rt_cd: safeText(input.body?.rt_cd, "") || null,
    msg_cd: safeText(input.body?.msg_cd, "") || null,
    msg1: safeText(input.body?.msg1, input.fallbackMessage),
    probableCauses: probableCauses(input.phase, input.httpStatus, input.body),
    timestamp: new Date().toISOString(),
  };
  setLastError(error);
  addLog("KIS_DIAGNOSTIC", `${input.phase} 요청 실패`, "ERROR");
  return error;
}

async function throttle(): Promise<void> {
  const run = requestQueue.then(async () => {
    const wait = Math.max(0, 700 - (Date.now() - lastRequestAt));
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
  });
  requestQueue = run.catch(() => undefined);
  return run;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJsonSafe(response: Response): Promise<KisEnvelope> {
  try {
    return (await response.json()) as KisEnvelope;
  } catch {
    return {};
  }
}

export class KisVtsClient {
  private readonly secrets = loadSecrets();

  constructor() {
    assertSafeEnvironment();
    if (!this.secrets) throw new Error("KIS_NOT_CONFIGURED");
  }

  async ensureToken(): Promise<string> {
    if (tokenCache && tokenCache.expiresAt > Date.now() + 300_000) {
      return tokenCache.token;
    }

    const endpointPath = "/oauth2/tokenP";
    await throttle();
    let response: Response;
    try {
      response = await fetch(`${VTS_BASE_URL}${endpointPath}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "client_credentials",
          appkey: this.secrets!.appKey,
          appsecret: this.secrets!.appSecret,
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      state.lastCycleSummary.tokenFailed += 1;
      recordError({
        phase: "token",
        endpointPath,
        httpStatus: null,
        fallbackMessage: "KIS VTS 연결 실패",
      });
      throw new Error("KIS_TOKEN_NETWORK_ERROR");
    }

    const body = await readJsonSafe(response);
    if (!response.ok || typeof body.access_token !== "string") {
      state.lastCycleSummary.tokenFailed += 1;
      recordError({
        phase: "token",
        endpointPath,
        httpStatus: response.status,
        body,
        fallbackMessage: `HTTP ${response.status}`,
      });
      throw new Error("KIS_TOKEN_FAILED");
    }

    tokenCache = {
      token: body.access_token,
      expiresAt: Date.now() + Math.max(60, safeNumber(body.expires_in)) * 1000,
    };
    state.lastCycleSummary.tokenSuccess += 1;
    setLastError(null);
    return tokenCache.token;
  }

  private async get(
    phase: DiagnosticPhase,
    endpointPath: string,
    trId: string,
    params: URLSearchParams,
    stockCode: string | null,
  ): Promise<KisEnvelope> {
    assertVtsTrId(trId, isSharedQuoteTrId(trId));
    let lastBody: KisEnvelope | null = null;
    let lastStatus: number | null = null;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const token = await this.ensureToken();
      await throttle();
      let response: Response;
      try {
        response = await fetch(`${VTS_BASE_URL}${endpointPath}?${params}`, {
          method: "GET",
          headers: {
            authorization: `Bearer ${token}`,
            appkey: this.secrets!.appKey,
            appsecret: this.secrets!.appSecret,
            tr_id: trId,
            custtype: "P",
          },
          cache: "no-store",
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        bumpPhase(phase, false);
        recordError({
          phase,
          stockCode,
          endpointPath,
          trId,
          httpStatus: null,
          fallbackMessage: "KIS VTS 연결 실패",
        });
        throw new Error("KIS_NETWORK_ERROR");
      }

      const body = await readJsonSafe(response);
      lastBody = body;
      lastStatus = response.status;
      if (response.ok && String(body.rt_cd ?? "") === "0") {
        bumpPhase(phase, true);
        setLastError(null);
        return body;
      }
      if (attempt === 3) break;
      if (isTokenRejected(body)) {
        tokenCache = null;
        continue;
      }
      if (!isRateLimited(body)) break;
      await sleep(1200 * (attempt + 1));
    }

    bumpPhase(phase, false);
    recordError({
      phase,
      stockCode,
      endpointPath,
      trId,
      httpStatus: lastStatus,
      body: lastBody,
      fallbackMessage: `HTTP ${lastStatus ?? "unknown"}`,
    });
    throw new Error(`KIS_${phase.toUpperCase()}_FAILED`);
  }

  private async post(
    phase: DiagnosticPhase,
    endpointPath: string,
    trId: string,
    payload: Record<string, string>,
    stockCode: string,
  ): Promise<KisEnvelope> {
    assertVtsTrId(trId);
    let lastBody: KisEnvelope | null = null;
    let lastStatus = 0;

    // A rejected token means KIS refused the request before it reached the
    // order book, so re-issuing and retrying cannot duplicate an order.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.ensureToken();
      await throttle();
      const orderMarket = trId.startsWith("VTTT") ? "US_NASDAQ" : "DOMESTIC";
      if (!state.isRunning || !getOrderDecision(orderMarket).allowed) throw new Error("ORDER_GATE_CLOSED");
      let response: Response;
      try {
        response = await fetch(`${VTS_BASE_URL}${endpointPath}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            appkey: this.secrets!.appKey,
            appsecret: this.secrets!.appSecret,
            tr_id: trId,
            custtype: "P",
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
          cache: "no-store",
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        bumpPhase(phase, false);
        recordError({
          phase,
          stockCode,
          endpointPath,
          trId,
          httpStatus: null,
          fallbackMessage: "KIS VTS 주문 연결 실패",
        });
        throw new Error("KIS_VTS_ORDER_NETWORK_ERROR");
      }

      const body = await readJsonSafe(response);
      lastBody = body;
      lastStatus = response.status;
      if (response.ok && String(body.rt_cd ?? "") === "0") {
        bumpPhase(phase, true);
        setLastError(null);
        return body;
      }
      if (attempt === 0 && isTokenRejected(body)) {
        tokenCache = null;
        continue;
      }
      break;
    }

    bumpPhase(phase, false);
    recordError({
      phase,
      stockCode,
      endpointPath,
      trId,
      httpStatus: lastStatus,
      body: lastBody,
      fallbackMessage: `HTTP ${lastStatus}`,
    });
    throw new Error("KIS_VTS_ORDER_REJECTED");
  }

  async getOverseasPrice(stockCode: string, excd = "NAS"): Promise<number> {
    const trId = "HHDFS00000300";
    assertVtsTrId(trId, true);
    const body = await this.get(
      "overseasPrice",
      "/uapi/overseas-price/v1/quotations/price",
      trId,
      new URLSearchParams({ AUTH: "", EXCD: excd, SYMB: stockCode }),
      stockCode,
    );
    const output = (body.output ?? {}) as Record<string, unknown>;
    const price = safeNumber(output.last ?? output.t_xprc);
    if (price <= 0) throw new Error("KIS_OVERSEAS_PRICE_EMPTY");
    return price;
  }

  async getOverseasDailyCandles(stockCode: string, excd = "NAS"): Promise<number[]> {
    return (await this.getOverseasDailyBars(stockCode, excd)).map((bar) => bar.close).reverse();
  }
  async getOverseasDailyBars(stockCode: string, excd = "NAS"): Promise<DailyBar[]> {
    const trId = "HHDFS76240000";
    assertVtsTrId(trId, true);
    const body = await this.get(
      "overseasCandle",
      "/uapi/overseas-price/v1/quotations/dailyprice",
      trId,
      new URLSearchParams({
        AUTH: "",
        EXCD: excd,
        SYMB: stockCode,
        GUBN: "0",
        BYMD: "",
        MODP: "1",
      }),
      stockCode,
    );
    const rows = Array.isArray(body.output2) ? body.output2 : [];
    return completedBars(rows.map((raw) => {
      const row = raw as Record<string, unknown>;
      return { date: safeText(row.xymd), close: safeNumber(row.clos) };
    }), usMarketDate());
  }

  async getOverseasBalance(): Promise<{
    positions: OverseasPosition[];
    cashUsd: number | null;
    totalEvaluationUsd: number;
    stockEvaluationUsd: number;
    purchaseAmountUsd: number;
    profitLossUsd: number;
  }> {
    const trId = "VTTS3012R";
    assertVtsTrId(trId);
    const { cano, productCode } = this.accountParts();
    const body = await this.get(
      "overseasBalance",
      "/uapi/overseas-stock/v1/trading/inquire-balance",
      trId,
      new URLSearchParams({
        CANO: cano,
        ACNT_PRDT_CD: productCode,
        OVRS_EXCG_CD: "NASD",
        TR_CRCY_CD: "USD",
        CTX_AREA_FK200: "",
        CTX_AREA_NK200: "",
      }),
      null,
    );
    // VTTS3012R: output1 is the position list, output2 is the account summary
    // (verified against KIS VTS on 2026-10-06; the swapped read showed 0 US holdings).
    const rows = records(body.output1);
    const output2 = Array.isArray(body.output2)
      ? body.output2[0]
      : body.output2;
    const summary =
      output2 && typeof output2 === "object"
        ? (output2 as Record<string, unknown>)
        : {};

    const now = new Date().toISOString();
    const positions = rows
      .map((raw) => raw)
      .filter((row) => safeNumber(row.ovrs_cblc_qty) > 0)
      .map((row) => {
        const quantity = safeNumber(row.ovrs_cblc_qty);
        const averagePrice = safeNumber(row.pchs_avg_pric);
        const currentPrice = safeNumber(row.now_pric2);
        const evaluation = safeNumber(row.ovrs_stck_evlu_amt);
        const purchaseAmount = safeNumber(row.frcr_pchs_amt1);
        const profitLoss = safeNumber(row.frcr_evlu_pfls_amt);
        const stockCode = safeText(row.ovrs_pdno);
        return {
          id: stockCode,
          market: "US_NASDAQ" as const,
          stockCode,
          stockName: safeText(row.ovrs_item_name ?? row.prdt_name, stockCode),
          exchange: "NASD" as const,
          quantity,
          averagePrice,
          currentPrice,
          evaluation,
          purchaseAmount,
          profitLoss,
          profitRate: safeNumber(row.evlu_pfls_rt),
          currency: "USD" as const,
          source: "KIS_OVERSEAS_BALANCE" as const,
          lastSyncedAt: now,
        };
      });

    const stockEvaluationUsd = positions.reduce(
      (sum, position) => sum + position.evaluation,
      0,
    );
    const purchaseAmountUsd =
      safeNumber(summary.frcr_buy_amt_smtl1) ||
      positions.reduce((sum, position) => sum + position.purchaseAmount, 0);
    const profitLossUsd =
      safeNumber(summary.tot_evlu_pfls_amt) ||
      positions.reduce((sum, position) => sum + position.profitLoss, 0);

    return {
      positions,
      // VTTS3012R does not return USD cash. Do not present a fabricated zero.
      cashUsd: null,
      totalEvaluationUsd: stockEvaluationUsd,
      stockEvaluationUsd,
      purchaseAmountUsd,
      profitLossUsd,
    };
  }

  async getOverseasBuyingPower(stockCode: string, limitPrice: number) {
    if (!/^[A-Z]{1,5}$/.test(stockCode) || !Number.isFinite(limitPrice) || limitPrice <= 0)
      throw new Error("INVALID_OVERSEAS_BUYING_POWER_INPUT");
    const { cano, productCode } = this.accountParts();
    const body = await this.get("overseasBalance", "/uapi/overseas-stock/v1/trading/inquire-psamount",
      "VTTS3007R", new URLSearchParams({ CANO: cano, ACNT_PRDT_CD: productCode,
        OVRS_EXCG_CD: "NASD", OVRS_ORD_UNPR: limitPrice.toFixed(2), ITEM_CD: stockCode }), stockCode);
    const { parseOverseasBuyingPower } = await import("@/lib/trading-limits");
    const raw = Array.isArray(body.output) ? body.output[0] : body.output;
    return { ...parseOverseasBuyingPower((raw ?? {}) as Record<string, unknown>), checkedAt: Date.now() };
  }

  async submitOverseasMockOrder(input: {
    stockCode: string;
    side: "BUY" | "SELL";
    quantity: number;
    limitPrice: number;
  }): Promise<VtsOrderAcceptance> {
    assertSafeEnvironment();
    if (!/^[A-Z]{1,5}$/.test(input.stockCode)) throw new Error("INVALID_OVERSEAS_STOCK_CODE");
    if (!Number.isInteger(input.quantity) || input.quantity < 1) {
      throw new Error("INVALID_ORDER_QUANTITY");
    }
    if (!Number.isFinite(input.limitPrice) || input.limitPrice <= 0) {
      throw new Error("INVALID_LIMIT_PRICE");
    }
    const trId = input.side === "BUY" ? "VTTT1002U" : "VTTT1001U";
    assertVtsTrId(trId);
    const { cano, productCode } = this.accountParts();
    const body = await this.post(
      "vtsOrder",
      "/uapi/overseas-stock/v1/trading/order",
      trId,
      {
        CANO: cano,
        ACNT_PRDT_CD: productCode,
        OVRS_EXCG_CD: "NASD",
        PDNO: input.stockCode,
        ORD_QTY: String(input.quantity),
        OVRS_ORD_UNPR: input.limitPrice.toFixed(2),
        CTAC_TLNO: "",
        MGCO_APTM_ODNO: "",
        SLL_TYPE: input.side === "SELL" ? "00" : "",
        ORD_SVR_DVSN_CD: "0",
        ORD_DVSN: "00",
      },
      input.stockCode,
    );
    const output = (body.output ?? {}) as Record<string, unknown>;
    const orderNo = safeText(output.ODNO ?? output.odno);
    const branchNo = safeText(
      output.KRX_FWDG_ORD_ORGNO ??
        output.krx_fwdg_ord_orgno ??
        output.ORD_GNO_BRNO ??
        output.ord_gno_brno,
    );
    if (!orderNo) throw new Error("KIS_VTS_ORDER_NUMBER_MISSING");
    return {
      orderNo,
      branchNo,
      orderTime: safeText(output.ORD_TMD ?? output.ord_tmd),
    };
  }

  async getOverseasTodayExecutions(requestedDate = usMarketDate()): Promise<VtsExecution[]> {
    const trId = "VTTS3035R";
    assertVtsTrId(trId);
    const { cano, productCode } = this.accountParts();
    const orderDate = requestedDate;
    const body = await this.get(
      "overseasExecution",
      "/uapi/overseas-stock/v1/trading/inquire-ccnl",
      trId,
      new URLSearchParams({
        CANO: cano,
        ACNT_PRDT_CD: productCode,
        PDNO: "",
        ORD_STRT_DT: orderDate,
        ORD_END_DT: orderDate,
        SLL_BUY_DVSN: "00",
        CCLD_NCCS_DVSN: "00",
        OVRS_EXCG_CD: "",
        SORT_SQN: "DS",
        ORD_DT: "",
        ORD_GNO_BRNO: "",
        ODNO: "",
        CTX_AREA_NK200: "",
        CTX_AREA_FK200: "",
      }),
      null,
    );
    const rows = Array.isArray(body.output) ? body.output : [];
    return rows.map((raw) => {
      const row = raw as Record<string, unknown>;
      return {
        orderDate: safeText(row.ord_dt, orderDate),
        orderNo: safeText(row.odno),
        branchNo: safeText(row.ord_gno_brno),
        stockCode: safeText(row.pdno),
        filledQuantity: safeNumber(row.ft_ccld_qty),
        averageFillPrice: safeNumber(row.ft_ccld_unpr3),
      };
    });
  }

  async getPrice(stockCode: string): Promise<number> {
    const body = await this.get(
      "domesticPrice",
      "/uapi/domestic-stock/v1/quotations/inquire-price",
      "FHKST01010100",
      new URLSearchParams({ FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: stockCode }),
      stockCode,
    );
    const output = (body.output ?? {}) as Record<string, unknown>;
    const price = safeNumber(output.stck_prpr);
    if (price <= 0) throw new Error("KIS_PRICE_EMPTY");
    return price;
  }

  async getDailyCandles(stockCode: string): Promise<number[]> {
    return (await this.getDailyBars(stockCode)).map((bar) => bar.close).reverse();
  }
  async getDailyBars(stockCode: string): Promise<DailyBar[]> {
    const today = new Date();
    const start = new Date(today);
    start.setDate(start.getDate() - 200);
    const ymd = (date: Date) =>
      `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
    const body = await this.get(
      "domesticCandle",
      "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
      "FHKST03010100",
      new URLSearchParams({
        FID_COND_MRKT_DIV_CODE: "J",
        FID_INPUT_ISCD: stockCode,
        FID_INPUT_DATE_1: ymd(start),
        FID_INPUT_DATE_2: ymd(today),
        FID_PERIOD_DIV_CODE: "D",
        FID_ORG_ADJ_PRC: "0",
      }),
      stockCode,
    );
    const rows = Array.isArray(body.output2) ? body.output2 : [];
    return completedBars(rows.map((raw) => {
      const row = raw as Record<string, unknown>;
      return { date: safeText(row.stck_bsop_date), close: safeNumber(row.stck_clpr) };
    }), domesticMarketDate());
  }

  private accountParts(): { cano: string; productCode: string } {
    const digits = this.secrets!.accountNo.replace(/\D/g, "");
    if (digits.length >= 10) {
      return { cano: digits.slice(0, 8), productCode: digits.slice(8, 10) };
    }
    return {
      cano: digits.slice(0, 8),
      productCode: this.secrets!.productCode.replace(/\D/g, "").slice(0, 2),
    };
  }

  async getBalance(): Promise<{
    positions: Position[];
    totalEvaluation: number;
    stockEvaluation: number;
    purchaseAmount: number;
    profitLoss: number;
    cash: number;
  }> {
    const { cano, productCode } = this.accountParts();
    const codes = [...new Set([productCode, "01", "03"].filter((code) => code.length === 2))];
    let body: KisEnvelope | null = null;
    let lastError: unknown = null;

    for (const code of codes) {
      try {
        body = await this.get(
          "domesticBalance",
          "/uapi/domestic-stock/v1/trading/inquire-balance",
          "VTTC8434R",
          new URLSearchParams({
            CANO: cano,
            ACNT_PRDT_CD: code,
            AFHR_FLPR_YN: "N",
            OFL_YN: "",
            INQR_DVSN: "02",
            UNPR_DVSN: "01",
            FUND_STTL_ICLD_YN: "N",
            FNCG_AMT_AUTO_RDPT_YN: "N",
            PRCS_DVSN: "00",
            CTX_AREA_FK100: "",
            CTX_AREA_NK100: "",
          }),
          null,
        );
        if (code !== productCode) {
          saveSecrets({
            appKey: this.secrets!.appKey,
            appSecret: this.secrets!.appSecret,
            accountNo: cano,
            productCode: code,
          });
        }
        break;
      } catch (error) {
        lastError = error;
        const failedCode = state.lastError?.msg_cd;
        if (failedCode !== "OPSQ2000") throw error;
        await sleep(1500);
      }
    }

    if (!body) throw lastError instanceof Error ? lastError : new Error("KIS_DOMESTICBALANCE_FAILED");
    const rows = Array.isArray(body.output1) ? body.output1 : [];
    const output2 = Array.isArray(body.output2)
      ? body.output2[0]
      : body.output2;
    const summary =
      output2 && typeof output2 === "object"
        ? (output2 as Record<string, unknown>)
        : {};

    const now = new Date().toISOString();
    const positions = rows
      .map((raw) => raw as Record<string, unknown>)
      .filter((row) => safeNumber(row.hldg_qty) > 0)
      .map((row) => ({
        id: String(row.pdno ?? ""),
        market: "DOMESTIC" as const,
        stockCode: String(row.pdno ?? ""),
        stockName: safeText(row.prdt_name, "종목명 없음"),
        quantity: safeNumber(row.hldg_qty),
        averagePrice: safeNumber(row.pchs_avg_pric),
        currentPrice: safeNumber(row.prpr),
        evaluation: safeNumber(row.evlu_amt),
        purchaseAmount: safeNumber(row.pchs_amt),
        profitLoss: safeNumber(row.evlu_pfls_amt),
        profitRate: safeNumber(row.evlu_pfls_rt),
        currency: "KRW" as const,
        source: "KIS_BALANCE" as const,
        lastSyncedAt: now,
      }));

    const stockEvaluation =
      safeNumber(summary.evlu_amt_smtl_amt) || safeNumber(summary.scts_evlu_amt);
    const purchaseAmount = safeNumber(summary.pchs_amt_smtl_amt);

    return {
      positions,
      totalEvaluation:
        safeNumber(summary.tot_evlu_amt) || safeNumber(summary.nass_amt),
      stockEvaluation,
      purchaseAmount,
      profitLoss:
        safeNumber(summary.evlu_pfls_smtl_amt) || stockEvaluation - purchaseAmount,
      cash: safeNumber(summary.dnca_tot_amt),
    };
  }

  async submitMockOrder(input: {
    stockCode: string;
    side: "BUY" | "SELL";
    quantity: number;
  }): Promise<VtsOrderAcceptance> {
    assertSafeEnvironment();
    if (!/^\d{6,7}$/.test(input.stockCode)) throw new Error("INVALID_STOCK_CODE");
    if (!Number.isInteger(input.quantity) || input.quantity < 1) {
      throw new Error("INVALID_ORDER_QUANTITY");
    }
    const { cano, productCode } = this.accountParts();
    // Current official KIS sample: demo cash sell/buy = VTTC0011U / VTTC0012U.
    const trId = input.side === "BUY" ? "VTTC0012U" : "VTTC0011U";
    assertVtsTrId(trId);
    const body = await this.post(
      "vtsOrder",
      "/uapi/domestic-stock/v1/trading/order-cash",
      trId,
      {
        CANO: cano,
        ACNT_PRDT_CD: productCode,
        PDNO: input.stockCode,
        ORD_DVSN: "01",
        ORD_QTY: String(input.quantity),
        ORD_UNPR: "0",
        EXCG_ID_DVSN_CD: "KRX",
        SLL_TYPE: input.side === "SELL" ? "01" : "",
        CNDT_PRIC: "",
      },
      input.stockCode,
    );
    const output = (body.output ?? {}) as Record<string, unknown>;
    const orderNo = safeText(output.ODNO ?? output.odno);
    const branchNo = safeText(output.KRX_FWDG_ORD_ORGNO ?? output.krx_fwdg_ord_orgno);
    if (!orderNo) throw new Error("KIS_VTS_ORDER_NUMBER_MISSING");
    return {
      orderNo,
      branchNo,
      orderTime: safeText(output.ORD_TMD ?? output.ord_tmd),
    };
  }

  async getTodayExecutions(requestedDate = domesticMarketDate()): Promise<VtsExecution[]> {
    const { cano, productCode } = this.accountParts();
    const orderDate = requestedDate;
    const body = await this.get(
      "vtsExecution",
      "/uapi/domestic-stock/v1/trading/inquire-daily-ccld",
      "VTTC0081R",
      new URLSearchParams({
        CANO: cano,
        ACNT_PRDT_CD: productCode,
        INQR_STRT_DT: orderDate,
        INQR_END_DT: orderDate,
        SLL_BUY_DVSN_CD: "00",
        PDNO: "",
        CCLD_DVSN: "00",
        INQR_DVSN: "00",
        INQR_DVSN_3: "00",
        ORD_GNO_BRNO: "",
        ODNO: "",
        INQR_DVSN_1: "",
        CTX_AREA_FK100: "",
        CTX_AREA_NK100: "",
        EXCG_ID_DVSN_CD: "KRX",
      }),
      null,
    );
    const rows = Array.isArray(body.output1) ? body.output1 : [];
    return rows.map((raw) => {
      const row = raw as Record<string, unknown>;
      return {
        orderDate: safeText(row.ord_dt, orderDate),
        orderNo: safeText(row.odno),
        branchNo: safeText(row.ord_gno_brno),
        stockCode: safeText(row.pdno),
        filledQuantity: safeNumber(row.tot_ccld_qty),
        averageFillPrice: safeNumber(row.avg_prvs),
      };
    });
  }
}

export function toBalanceSnapshot(
  balance: Awaited<ReturnType<KisVtsClient["getBalance"]>>,
): BalanceSnapshot {
  return {
    cash: balance.cash,
    totalEvaluation: balance.totalEvaluation,
    stockEvaluation: balance.stockEvaluation,
    purchaseAmount: balance.purchaseAmount,
    profitLoss: balance.profitLoss,
    profitRate: balance.purchaseAmount
      ? (balance.profitLoss / balance.purchaseAmount) * 100
      : 0,
    holdingCount: balance.positions.length,
    syncedAt: new Date().toISOString(),
  };
}

export function toOverseasBalanceSnapshot(
  balance: Awaited<ReturnType<KisVtsClient["getOverseasBalance"]>>,
): OverseasBalanceSnapshot {
  return {
    cashUsd: balance.cashUsd,
    totalEvaluationUsd: balance.totalEvaluationUsd,
    stockEvaluationUsd: balance.stockEvaluationUsd,
    purchaseAmountUsd: balance.purchaseAmountUsd,
    profitLossUsd: balance.profitLossUsd,
    profitRate: balance.purchaseAmountUsd
      ? (balance.profitLossUsd / balance.purchaseAmountUsd) * 100
      : 0,
    holdingCount: balance.positions.length,
    currency: "USD",
    exchange: "NASD",
    syncedAt: new Date().toISOString(),
  };
}

export async function testVtsConnection(stockCode = "005930"): Promise<{
  token: true;
  price: true;
  candle: true;
  balance: true;
  overseasPrice: true;
  overseasCandle: true;
  overseasBalance: true;
}> {
  const client = new KisVtsClient();
  await client.ensureToken();
  await client.getPrice(stockCode);
  await client.getDailyCandles(stockCode);
  await client.getBalance();
  await client.getOverseasPrice("AAPL");
  await client.getOverseasDailyCandles("AAPL");
  await client.getOverseasBalance();
  return {
    token: true,
    price: true,
    candle: true,
    balance: true,
    overseasPrice: true,
    overseasCandle: true,
    overseasBalance: true,
  };
}
