"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Database,
  KeyRound,
  LockKeyhole,
  Play,
  RefreshCw,
  Shield,
  Square,
  TerminalSquare,
  Wallet,
  Wifi,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { VTS_BASE_URL } from "@/lib/domain";
import { NewsResearchPanel } from "@/components/news-research-panel";

interface DashboardData {
  health: {
    runtime: string;
    database: { connected: boolean; provider: string };
    kis: {
      configured: boolean;
      appKeyLoaded: boolean;
      appSecretLoaded: boolean;
      accountLoaded: boolean;
      productCodeLoaded: boolean;
      baseUrlType: string;
      configSource: string;
      allowRealFallback: boolean;
      lastError: Record<string, unknown> | null;
    };
    safety: {
      effectiveSafetyMode: string;
      tradingMode: string;
      orderExecutionMode: string;
      killSwitchEnabled: boolean;
      autoDomesticOrderEnabled: boolean;
      autoOverseasOrderEnabled: boolean;
      canPlaceDomesticOrderNow: boolean;
      canPlaceOverseasOrderNow: boolean;
      domesticOrderBlockedReason: string | null;
      overseasOrderBlockedReason: string | null;
      usMarketStatus: string;
      usMarketHoursKo?: string;
    };
    version: { gitCommitSha: string; gitBranch: string };
  };
  agent: {
    strategy?: {
      estimatedPnlKrw: number | null; estimatedReturnPct: number | null;
      paperBudgetKrw: number; unresolvedOrders: number;
    };
    isRunning: boolean;
    lastCycleAt: string | null;
    lastCycleSummary: Record<string, number>;
    runtimeDecision: {
      canRunAnalysisNow: boolean;
      canPlaceDomesticOrderNow: boolean;
      canPlaceOverseasOrderNow: boolean;
      domesticOrderBlockedReason: string | null;
      overseasOrderBlockedReason: string | null;
      usMarketStatus: string;
      usMarketHoursKo?: string;
    };
    positions: Array<Record<string, string | number>>;
    overseasPositions: Array<Record<string, string | number>>;
    agentOwnedPositions: Array<Record<string, string | number>>;
    balanceSnapshot: {
      cash: number;
      totalEvaluation: number;
      stockEvaluation: number;
      purchaseAmount: number;
      profitLoss: number;
      profitRate: number;
      holdingCount: number;
      syncedAt: string;
    } | null;
    overseasBalanceSnapshot: {
      cashUsd: number | null;
      totalEvaluationUsd: number;
      stockEvaluationUsd: number;
      purchaseAmountUsd: number;
      profitLossUsd: number;
      profitRate: number;
      holdingCount: number;
      currency: string;
      exchange: string;
      syncedAt: string;
    } | null;
    watchlist: Array<Record<string, string | number | null>>;
    usWatchlist: Array<Record<string, string | number | null>>;
    recentLogs: Array<Record<string, string>>;
  };
  orders: Array<Record<string, string | number | null>>;
  todayBuyNotional: number;
  limits: { maxPositions?: number; maxNameFraction?: number; firstTrancheFraction?: number; principalKrw?: number; usdKrwSafetyRate?: number } | null;
  blockedReasonCounts: Record<string, number>;
}

const initial: DashboardData = {
  health: {
    runtime: "local",
    database: { connected: false, provider: "checking" },
    kis: {
      configured: false,
      appKeyLoaded: false,
      appSecretLoaded: false,
      accountLoaded: false,
      productCodeLoaded: false,
      baseUrlType: "vts",
      configSource: "encrypted-file",
      allowRealFallback: false,
      lastError: null,
    },
    safety: {
      effectiveSafetyMode: "SAFE_LOCKED",
      tradingMode: "DEMO",
      orderExecutionMode: "VTS_MOCK",
      killSwitchEnabled: true,
      autoDomesticOrderEnabled: false,
      autoOverseasOrderEnabled: false,
      canPlaceDomesticOrderNow: false,
      canPlaceOverseasOrderNow: false,
      domesticOrderBlockedReason: "SAFE_LOCKED",
      overseasOrderBlockedReason: "SAFE_LOCKED",
      usMarketStatus: "CLOSED",
      usMarketHoursKo:
        "미국 동부시간(ET) 평일 09:30–16:00 · 한국시간으로 환산 (서머타임 반영, 한국 오전 9:30 아님)",
    },
    version: { gitCommitSha: "checking", gitBranch: "checking" },
  },
  agent: {
    isRunning: false,
    lastCycleAt: null,
    lastCycleSummary: {},
    runtimeDecision: {
      canRunAnalysisNow: false,
      canPlaceDomesticOrderNow: false,
      canPlaceOverseasOrderNow: false,
      domesticOrderBlockedReason: "SAFE_LOCKED",
      overseasOrderBlockedReason: "SAFE_LOCKED",
      usMarketStatus: "CLOSED",
    },
    positions: [],
    overseasPositions: [],
    agentOwnedPositions: [],
    balanceSnapshot: null,
    overseasBalanceSnapshot: null,
    watchlist: [],
    usWatchlist: [],
    recentLogs: [],
  },
  orders: [],
  todayBuyNotional: 0,
  limits: null,
  blockedReasonCounts: {},
};

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-block size-2 rounded-full ${ok ? "bg-emerald-500" : "bg-rose-500"}`}
    />
  );
}

function StateBadge({ value }: { value: string }) {
  const style =
    value === "VTS_AUTO_ARMED" ||
    value === "SUCCESS" ||
    value === "FILLED" ||
    value === "SUBMITTED"
      ? "bg-violet-100 text-violet-700"
      : value === "SAFE_LOCKED" ||
          value === "BLOCKED" ||
          value === "FAILED" ||
          value === "REJECTED" ||
          value === "EXPIRED"
        ? "bg-rose-100 text-rose-700"
        : value === "VTS_AUTO_READY"
          ? "bg-blue-100 text-blue-700"
          : "bg-slate-100 text-slate-700";
  return <Badge className={style}>{value}</Badge>;
}

function formatPrice(value: number | null, currency: string): string {
  if (value == null) return "-";
  if (currency === "USD") {
    return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return `${value.toLocaleString()}원`;
}

function WatchlistTable({
  items,
  currency,
}: {
  items: Array<Record<string, string | number | null>>;
  currency: "KRW" | "USD";
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>종목</TableHead>
          <TableHead>캔들</TableHead>
          <TableHead>현재가</TableHead>
          <TableHead>신호</TableHead>
          <TableHead>조건 충족 점수</TableHead>
          <TableHead>BUY/SELL</TableHead>
          <TableHead>차단 사유</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => (
          <TableRow key={String(item.id)}>
            <TableCell>
              <div className="font-medium">{String(item.stockName)}</div>
              <div className="font-mono text-xs text-slate-500">
                {String(item.stockCode)}
              </div>
            </TableCell>
            <TableCell>
              <StateBadge value={String(item.candleStatus)} />
            </TableCell>
            <TableCell>
              <StateBadge value={String(item.priceStatus)} />
              {item.currentPrice != null && (
                <div className="mt-1 text-xs">
                  {formatPrice(Number(item.currentPrice), currency)}
                </div>
              )}
            </TableCell>
            <TableCell className="font-semibold">{String(item.analysis)}</TableCell>
            <TableCell>{String(item.confidence)}/100</TableCell>
            <TableCell>
              {String(item.buyScore)} / {String(item.sellScore)}
            </TableCell>
            <TableCell className="max-w-40 text-xs text-slate-500">
              {String(item.blockedReason)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function Dashboard() {
  const [data, setData] = useState<DashboardData>(initial);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState("");
  const [message, setMessage] = useState("");
  const [editingConfig, setEditingConfig] = useState(false);
  const [form, setForm] = useState({
    appKey: "",
    appSecret: "",
    accountNo: "",
    productCode: "01",
  });

  const refresh = useCallback(async () => {
    try {
      const [healthRes, agentRes, orderRes] = await Promise.all([
        fetch("/api/system/local-health", { cache: "no-store" }),
        fetch("/api/agent/status", { cache: "no-store" }),
        fetch("/api/vts-orders", { cache: "no-store" }),
      ]);
      const health = await healthRes.json();
      const agent = await agentRes.json();
      const orders = await orderRes.json();
      setData({
        health,
        agent: agent.data,
        orders: orders.data?.orders ?? [],
        todayBuyNotional: orders.data?.todayBuyNotional ?? 0,
        limits: orders.data?.limits ?? null,
        blockedReasonCounts: orders.data?.blockedReasonCounts ?? {},
      });
    } catch {
      setMessage("대시보드 상태를 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initialTimer = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => void refresh(), 5_000);
    return () => {
      clearTimeout(initialTimer);
      clearInterval(timer);
    };
  }, [refresh]);

  async function post(url: string, body?: object) {
    setAction(url);
    setMessage("");
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const result = await response.json();
      setMessage(
        result.success
          ? result.message ?? "완료되었습니다."
          : result.error ?? "요청이 실패했습니다.",
      );
      await refresh();
      return result;
    } finally {
      setAction("");
    }
  }

  async function saveConfig(event: FormEvent) {
    event.preventDefault();
    const result = await post("/api/kis/save-config", {
      ...form,
      baseUrl: VTS_BASE_URL,
    });
    if (result?.success) {
      setForm({ appKey: "", appSecret: "", accountNo: "", productCode: "01" });
      setEditingConfig(false);
    }
  }

  const safety = data.health.safety;
  const stats = data.agent.lastCycleSummary;

  return (
    <main className="min-h-screen bg-slate-100 text-slate-950">
      <header className="border-b border-slate-800 bg-slate-950 text-white">
        <div className="mx-auto flex max-w-[1600px] flex-col gap-3 px-5 py-5 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-xs font-semibold tracking-[0.22em] text-blue-400">
              KIS VTS · MOCK AUTO TRADING
            </p>
            <h1 className="mt-1 text-2xl font-bold">모의 자동매매 안전 대시보드</h1>
            <p className="mt-2 text-sm text-amber-200">추세·돌파 전략 v1 · 수익성 미검증 · 점수는 승률이 아닙니다.</p>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <StateBadge value={safety.effectiveSafetyMode} />
            <Badge variant="outline" className="border-slate-700 text-slate-200">
              실전 주문: 차단됨
            </Badge>
            <Badge variant="outline" className="border-slate-700 text-slate-200">
              서버: VTS
            </Badge>
            <Badge variant="outline" className="border-slate-700 text-slate-200">
              주문: VTS 모의
            </Badge>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1600px] space-y-4 p-4 lg:p-6">
        <Card>
          <CardHeader>
            <CardTitle>전략 검증 상태: 모의 관찰 중</CardTitle>
            <CardDescription>완료된 65개 이상 일봉으로 추세·돌파를 확인합니다. 매수는 하루 동일 신호 1회, 추가 매수 없이 진행합니다.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>계좌 초기잔고 기준 3,000만 원(사용자 확인) · 국내 1회 30만 원 / 미국 1회 3,000달러 · 최대 5종목 · 전체 투자 비중 최대 50%</p>
            <p>앱 거래 기준 추정 손익: {data.agent.strategy?.estimatedPnlKrw == null
              ? "체결가·잔고 확인 필요"
              : `${Math.round(data.agent.strategy.estimatedPnlKrw).toLocaleString()}원 (${data.agent.strategy.estimatedReturnPct?.toFixed(2)}%)`}</p>
            <p className="text-slate-500">손익은 편도 비용 0.15%, 달러당 1,500원 가정입니다. 실제 수수료·세금·환율 반영 수익률과 다르며 전략 우위를 뜻하지 않습니다.</p>
            {(data.agent.strategy?.unresolvedOrders ?? 0) > 0 && <p className="text-red-700">주문 결과 미확인 {data.agent.strategy?.unresolvedOrders}건: 증권사 주문·체결 확인 전 신규 매수를 차단합니다.</p>}
          </CardContent>
        </Card>
        <Alert
          className={
            safety.effectiveSafetyMode === "VTS_AUTO_ARMED"
              ? "border-violet-300 bg-violet-50"
              : "border-rose-300 bg-rose-50"
          }
        >
          <Shield className="size-4" />
          <AlertTitle>
            현재 상태: {safety.effectiveSafetyMode}
          </AlertTitle>
          <AlertDescription>
            활성화하면 KIS VTS 모의계좌에 국내·미국(NASDAQ) 모의주문을
            제출합니다. 하루 합산 신규 매수 최대 450만 원입니다. 국내 1회 최대 30만 원, 미국 1회 최대 3,000달러·미국 종목당 초기잔고의 15%입니다. 미국 주문 전 KIS 주문가능금액·수량을 확인합니다.
            변동성에 따라 진입 시 3~8% 손절 기준을 정하고, +10% 부분 익절은 보유 회차당 한 번,
            +20%에서는 잔여 수량을 매도합니다. 손절가는 체결 보장 가격이 아닙니다.
            실전 호스트는 차단되며, 이 앱의 체결로 확인한 보유 수량만 매도합니다.
            미국 주문은 한국 오전 9:30이 아닙니다.
            {safety.usMarketHoursKo ??
              "미국 동부시간(ET) 평일 09:30–16:00 · 한국시간은 보통 밤 22:30 또는 23:30에 시작해 다음날 새벽까지"}
            . 그 구간에만 제출됩니다. 해외 잔고와 보유종목은 오른쪽 열 아래에서
            확인할 수 있습니다.
          </AlertDescription>
        </Alert>

        {message && (
          <Alert className="border-blue-200 bg-blue-50">
            <Activity className="size-4" />
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        )}

        <NewsResearchPanel running={data.agent.isRunning} targets={[
          ...data.agent.watchlist.map((item) => ({ market: "DOMESTIC" as const, stockCode: String(item.stockCode), stockName: String(item.stockName) })),
          ...data.agent.usWatchlist.map((item) => ({ market: "US_NASDAQ" as const, stockCode: String(item.stockCode), stockName: String(item.stockName) })),
        ]} />
        <section className="grid gap-4 xl:grid-cols-[330px_minmax(0,1fr)_360px]">
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <KeyRound className="size-4" /> KIS API 설정
                </CardTitle>
                <CardDescription>
                  계좌는 KIS Developers 신청내역에 앱키와 함께 표시된 8자리입니다.
                  모의투자 웹의 상시대회 계좌와 다를 수 있습니다. 저장 후 원문과
                  일부 마스킹 값은 다시 표시하지 않습니다.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {data.health.kis.configured && !editingConfig ? (
                  <div className="space-y-2 text-sm">
                    {[
                      ["appKeyLoaded", data.health.kis.appKeyLoaded],
                      ["appSecretLoaded", data.health.kis.appSecretLoaded],
                      ["accountLoaded", data.health.kis.accountLoaded],
                      ["productCodeLoaded", data.health.kis.productCodeLoaded],
                    ].map(([label, ok]) => (
                      <div key={String(label)} className="flex justify-between">
                        <span className="text-slate-600">{String(label)}</span>
                        <span className="flex items-center gap-2 font-mono">
                          <StatusDot ok={Boolean(ok)} /> {String(ok)}
                        </span>
                      </div>
                    ))}
                    <div className="flex justify-between">
                      <span className="text-slate-600">baseUrlType</span>
                      <span className="font-mono text-blue-700">vts</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-600">저장 위치</span>
                      <span className="font-mono text-xs">
                        {data.health.kis.configSource === "env"
                          ? ".env.local"
                          : ".data 암호화 파일"}
                      </span>
                    </div>
                    {data.health.kis.configSource === "env" && (
                      <p className="text-xs text-slate-500">
                        .env.local 값이 우선합니다. 계좌를 바꾸려면 npm run
                        kis:setup 을 다시 실행하세요.
                      </p>
                    )}
                    <Button
                      className="mt-2 w-full"
                      type="button"
                      variant="outline"
                      onClick={() => setEditingConfig(true)}
                    >
                      계좌·키 다시 입력
                    </Button>
                  </div>
                ) : (
                  <form className="space-y-3" onSubmit={saveConfig}>
                    <div className="space-y-1">
                      <Label htmlFor="appKey">KIS_APP_KEY</Label>
                      <Input
                        id="appKey"
                        type="password"
                        autoComplete="off"
                        value={form.appKey}
                        onChange={(e) => setForm({ ...form, appKey: e.target.value })}
                        required
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="appSecret">KIS_APP_SECRET</Label>
                      <Input
                        id="appSecret"
                        type="password"
                        autoComplete="off"
                        value={form.appSecret}
                        onChange={(e) =>
                          setForm({ ...form, appSecret: e.target.value })
                        }
                        required
                      />
                    </div>
                    <div className="grid grid-cols-[1fr_74px] gap-2">
                      <div className="space-y-1">
                        <Label htmlFor="account">KIS_ACCOUNT_NO (Open API 계좌)</Label>
                        <Input
                          id="account"
                          type="password"
                          inputMode="numeric"
                          autoComplete="off"
                          value={form.accountNo}
                          onChange={(e) =>
                            setForm({ ...form, accountNo: e.target.value })
                          }
                          required
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="product">상품코드</Label>
                        <Input
                          id="product"
                          inputMode="numeric"
                          value={form.productCode}
                          onChange={(e) =>
                            setForm({ ...form, productCode: e.target.value })
                          }
                          required
                        />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="baseUrl">KIS_BASE_URL (수정 불가)</Label>
                      <Input
                        id="baseUrl"
                        value={VTS_BASE_URL}
                        readOnly
                        className="bg-slate-100 text-xs"
                      />
                    </div>
                    <Button className="w-full" type="submit" disabled={Boolean(action)}>
                      설정 저장
                    </Button>
                  </form>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <LockKeyhole className="size-4" /> 안전모드 제어
                </CardTitle>
              </CardHeader>
              <CardContent className="grid gap-2">
                <Button
                  variant="outline"
                  onClick={() => void refresh()}
                  disabled={loading}
                >
                  <CheckCircle2 /> 1. KIS 설정 확인
                </Button>
                <Button
                  variant="outline"
                  onClick={() => void post("/api/kis/test-connection")}
                  disabled={!data.health.kis.configured || Boolean(action)}
                >
                  <Wifi /> 2. VTS 연결 테스트
                </Button>
                <Button
                  variant="outline"
                  onClick={() =>
                    void post("/api/settings/vts-paper-arm", { action: "PREPARE" })
                  }
                  disabled={!data.health.kis.configured || Boolean(action)}
                >
                  <Shield /> 3. VTS 자동주문 준비 (선택)
                </Button>
                <Button
                  className="bg-violet-600 hover:bg-violet-700"
                  onClick={() =>
                    void post("/api/settings/vts-paper-arm", {
                      action: "ARM_AND_START",
                      confirm: "ARM_VTS_AUTO_ONLY",
                    })
                  }
                  disabled={
                    !data.health.kis.configured ||
                    safety.effectiveSafetyMode === "VTS_AUTO_ARMED" ||
                    Boolean(action)
                  }
                >
                  <Play /> 4. VTS 모의 자동주문 활성화 후 시작
                </Button>
                <p className="-mt-1 text-xs text-slate-500">
                  {safety.effectiveSafetyMode === "VTS_AUTO_ARMED"
                    ? "이미 활성화되어 있습니다."
                    : data.health.kis.configured
                      ? "누르면 연결 확인, 활성화, 에이전트 시작까지 진행합니다."
                      : "먼저 KIS 설정을 저장해야 합니다."}
                </p>
                <Button
                  variant="destructive"
                  onClick={() => void post("/api/settings/safety-lock")}
                  disabled={Boolean(action)}
                >
                  <LockKeyhole /> 5. 즉시 안전잠금
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">에이전트 제어</CardTitle>
                <CardDescription>
                  활성화 후 시작하면 1분마다 분석하고 VTS 모의주문을 제출합니다.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex gap-2">
                  <Button
                    onClick={() => void post("/api/agent/start")}
                    disabled={
                      safety.effectiveSafetyMode !== "VTS_AUTO_ARMED" ||
                      data.agent.isRunning
                    }
                  >
                    <Play /> 시작
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => void post("/api/agent/stop")}
                    disabled={!data.agent.isRunning}
                  >
                    <Square /> 중지
                  </Button>
                </div>
                {safety.effectiveSafetyMode !== "VTS_AUTO_ARMED" ? (
                  <p className="text-xs text-slate-500">
                    4번이 활성화와 시작을 함께 처리합니다. 현재{" "}
                    {safety.effectiveSafetyMode}
                  </p>
                ) : (
                  <p className="text-xs text-slate-500">
                    에이전트 {data.agent.isRunning ? "실행 중" : "정지"}
                    {data.agent.lastCycleAt &&
                      ` · 마지막 분석 ${new Date(data.agent.lastCycleAt).toLocaleTimeString("ko-KR")}`}
                  </p>
                )}
                {data.limits && (
                  <p className="text-xs text-slate-500">
                    최대 {data.limits.maxPositions ?? 5}종목 · 국내 종목당{" "}
                    {Math.round((data.limits.maxNameFraction ?? 0.10) * 100)}% 이하 ·
                    미국 종목당 15% 이하 · 계좌 초기잔고 기준 {(data.limits.principalKrw ?? 30000000).toLocaleString()}원
                  </p>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">국내 관심종목 분석</CardTitle>
                <CardDescription>
                  Strategy Engine은 신호만 만들고 Rule Engine이 주문을 판정합니다.
                </CardDescription>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <WatchlistTable items={data.agent.watchlist} currency="KRW" />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">미국(NASDAQ) 관심종목 분석</CardTitle>
                <CardDescription>
                  AAPL, NVDA, AMD, AMZN, MSFT · 가격 USD · VTS 지정가(VTTT1002U/VTTT1001U)
                  · 장 상태: {data.health.safety.usMarketStatus ?? "CLOSED"}
                  · {data.health.safety.usMarketHoursKo ??
                    "미국 동부시간(ET) 09:30–16:00"}
                </CardDescription>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <WatchlistTable items={data.agent.usWatchlist ?? []} currency="USD" />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">KIS VTS 모의주문</CardTitle>
                <CardDescription>
                  SUBMITTED는 접수, FILLED는 체결 확인, UNKNOWN은 결과 미확인입니다.
                  BLOCKED는 전송되지 않았습니다.
                </CardDescription>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>시간</TableHead>
                      <TableHead>시장</TableHead>
                      <TableHead>종목</TableHead>
                      <TableHead>방향</TableHead>
                      <TableHead>수량</TableHead>
                      <TableHead>기준가</TableHead>
                      <TableHead>통화</TableHead>
                      <TableHead>상태</TableHead>
                      <TableHead>사유</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.orders.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={9} className="h-24 text-center text-slate-500">
                          VTS 모의주문 기록이 없습니다.
                        </TableCell>
                      </TableRow>
                    ) : (
                      data.orders.slice(0, 20).map((order) => (
                        <TableRow key={String(order.id)}>
                          <TableCell className="text-xs">
                            {new Date(String(order.timestamp)).toLocaleTimeString("ko-KR")}
                          </TableCell>
                          <TableCell className="text-xs font-mono">
                            {String(order.market ?? "DOMESTIC")}
                          </TableCell>
                          <TableCell>{String(order.stockName)}</TableCell>
                          <TableCell>{String(order.side)}</TableCell>
                          <TableCell>{String(order.quantity)}</TableCell>
                          <TableCell>
                            {formatPrice(
                              Number(order.referencePrice),
                              String(order.currency ?? "KRW"),
                            )}
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {String(order.currency ?? "KRW")}
                          </TableCell>
                          <TableCell>
                            <StateBadge value={String(order.status)} />
                          </TableCell>
                          <TableCell className="text-xs">
                            {String(order.blockedReason ?? "KIS_VTS")}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>

          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <TerminalSquare className="size-4" /> 시스템 상태
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {[
                  ["Runtime", data.health.runtime],
                  ["Git SHA", data.health.version.gitCommitSha],
                  ["Git branch", data.health.version.gitBranch],
                  ["DB", data.health.database.provider],
                  ["KIS server", "VTS"],
                  ["Safety", safety.effectiveSafetyMode],
                  ["Domestic order", String(safety.canPlaceDomesticOrderNow)],
                  ["Overseas order", String(safety.canPlaceOverseasOrderNow)],
                  ["US market", safety.usMarketStatus ?? "CLOSED"],
                  [
                    "US hours",
                    safety.usMarketHoursKo ??
                      "ET 09:30–16:00 (not KST 09:30)",
                  ],
                  ["Real fallback", "false"],
                ].map(([label, value]) => (
                  <div key={label} className="flex justify-between gap-3">
                    <span className="text-slate-500">{label}</span>
                    <span className="truncate font-mono text-xs">{value}</span>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Activity className="size-4" /> KIS 조회 진단
                </CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-2 text-xs">
                {[
                  ["token", stats.tokenSuccess, stats.tokenFailed],
                  ["candle", stats.candleSuccess, stats.candleFailed],
                  ["price", stats.priceSuccess, stats.priceFailed],
                  ["balance", stats.balanceSuccess, stats.balanceFailed],
                  ["us-candle", stats.overseasCandleSuccess, stats.overseasCandleFailed],
                  ["us-price", stats.overseasPriceSuccess, stats.overseasPriceFailed],
                  ["us-balance", stats.overseasBalanceSuccess, stats.overseasBalanceFailed],
                  ["vtsOrder", stats.vtsOrderSuccess, stats.vtsOrderFailed],
                ].map(([label, success, failed]) => (
                  <div key={String(label)} className="rounded-md border bg-slate-50 p-2">
                    <div className="font-semibold">{String(label)}</div>
                    <div className="mt-1 text-emerald-700">성공 {Number(success ?? 0)}</div>
                    <div className="text-rose-700">실패 {Number(failed ?? 0)}</div>
                  </div>
                ))}
              </CardContent>
            </Card>

            {data.health.kis.lastError && (
              <Card className="border-rose-200">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base text-rose-700">
                    <AlertTriangle className="size-4" /> 마지막 KIS 오류
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <pre className="overflow-x-auto whitespace-pre-wrap text-[11px] text-slate-700">
                    {JSON.stringify(data.health.kis.lastError, null, 2)}
                  </pre>
                </CardContent>
              </Card>
            )}

            <Card className="border-violet-200">
              <CardHeader>
                <CardTitle className="text-base">자동매매 소유 수량</CardTitle>
                <CardDescription>
                  이 시스템의 체결 매수분만 표시하며, 자동매도 상한으로 사용합니다.
                  기존 계좌 보유분은 포함하지 않습니다.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {data.agent.agentOwnedPositions.length === 0 ? (
                  <p className="text-sm text-slate-500">
                    자동화가 매수해 체결된 보유분 없음
                  </p>
                ) : (
                  <div className="space-y-2">
                    {data.agent.agentOwnedPositions.map((position) => (
                      <div
                        key={`${String(position.market)}:${String(position.stockCode)}`}
                        className="flex justify-between rounded-md border p-2 text-sm"
                      >
                        <span>
                          {String(position.stockName)}{" "}
                          <span className="font-mono text-xs text-slate-500">
                            {String(position.market ?? "DOMESTIC")}
                          </span>
                        </span>
                        <span className="font-mono">
                          {String(position.quantity)}
                          {String(position.currency ?? "KRW") === "USD" ? " sh" : "주"}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {Object.keys(data.blockedReasonCounts).length > 0 && (
                  <div className="mt-3 border-t pt-3">
                    <p className="mb-2 text-xs font-semibold text-slate-600">
                      매수되지 않은 이유
                    </p>
                    <div className="space-y-1">
                      {Object.entries(data.blockedReasonCounts)
                        .sort((a, b) => b[1] - a[1])
                        .map(([reason, count]) => (
                          <div
                            key={reason}
                            className="flex justify-between text-xs text-slate-500"
                          >
                            <span className="font-mono">{reason}</span>
                            <span>{count}건</span>
                          </div>
                        ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Wallet className="size-4" /> VTS 모의 잔고
                </CardTitle>
                <CardDescription>
                  Open API 계좌의 KIS 응답값입니다. 이 앱이 만든 숫자가 아닙니다.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {data.agent.balanceSnapshot ? (
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-slate-600">예수금</span>
                      <span className="font-mono">
                        {data.agent.balanceSnapshot.cash.toLocaleString()}원
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-600">주식 평가금액</span>
                      <span className="font-mono">
                        {data.agent.balanceSnapshot.stockEvaluation.toLocaleString()}원
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-600">총평가금액</span>
                      <span className="font-mono">
                        {data.agent.balanceSnapshot.totalEvaluation.toLocaleString()}원
                      </span>
                    </div>
                    <div className="flex justify-between border-t pt-2">
                      <span className="text-slate-600">매입금액</span>
                      <span className="font-mono">
                        {data.agent.balanceSnapshot.purchaseAmount.toLocaleString()}원
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-600">평가손익</span>
                      <span
                        className={`font-mono ${
                          data.agent.balanceSnapshot.profitLoss < 0
                            ? "text-blue-700"
                            : "text-rose-700"
                        }`}
                      >
                        {data.agent.balanceSnapshot.profitLoss.toLocaleString()}원 (
                        {data.agent.balanceSnapshot.profitRate.toFixed(2)}%)
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-600">보유 종목</span>
                      <span className="font-mono">
                        {data.agent.balanceSnapshot.holdingCount}종목
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-600">동기화</span>
                      <span className="font-mono text-xs">
                        {new Date(
                          data.agent.balanceSnapshot.syncedAt,
                        ).toLocaleString("ko-KR")}
                      </span>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-slate-500">
                    아직 잔고를 동기화하지 않았습니다.
                  </p>
                )}
                <Button
                  className="w-full"
                  variant="outline"
                  onClick={() => void post("/api/kis/balance")}
                  disabled={!data.health.kis.configured || Boolean(action)}
                >
                  <RefreshCw /> 잔고 동기화
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Wallet className="size-4" /> VTS 해외(미국) 모의 잔고
                </CardTitle>
                <CardDescription>
                  VTTS3012R · NASD/USD · Open API 계좌의 KIS 응답값입니다.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {data.agent.overseasBalanceSnapshot ? (
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-slate-600">예수금 (USD)</span>
                      <span className="font-mono">
                        {data.agent.overseasBalanceSnapshot.cashUsd == null
                          ? "VTTS3012R 미제공"
                          : `$${data.agent.overseasBalanceSnapshot.cashUsd.toLocaleString(
                              undefined,
                              {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              },
                            )}`}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-600">주식 평가 (USD)</span>
                      <span className="font-mono">
                        ${data.agent.overseasBalanceSnapshot.stockEvaluationUsd.toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </span>
                    </div>
                    <div className="flex justify-between border-t pt-2">
                      <span className="text-slate-600">평가손익</span>
                      <span
                        className={`font-mono ${
                          data.agent.overseasBalanceSnapshot.profitLossUsd < 0
                            ? "text-blue-700"
                            : "text-rose-700"
                        }`}
                      >
                        ${data.agent.overseasBalanceSnapshot.profitLossUsd.toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}{" "}
                        ({data.agent.overseasBalanceSnapshot.profitRate.toFixed(2)}%)
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-600">보유 종목</span>
                      <span className="font-mono">
                        {data.agent.overseasBalanceSnapshot.holdingCount}종목
                      </span>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-slate-500">
                    아직 해외 잔고를 동기화하지 않았습니다.
                  </p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">해외 Position 원장</CardTitle>
                <CardDescription>KIS 해외 잔고(VTTS3012R) 성공 시에만 동기화</CardDescription>
              </CardHeader>
              <CardContent>
                {(data.agent.overseasPositions ?? []).length === 0 ? (
                  <p className="text-sm text-slate-500">동기화된 해외 보유 종목 없음</p>
                ) : (
                  <div className="space-y-2">
                    {(data.agent.overseasPositions ?? []).map((position) => (
                      <div
                        key={String(position.id)}
                        className="rounded-md border p-2 text-sm"
                      >
                        <div className="flex justify-between">
                          <span>{String(position.stockName)}</span>
                          <span className="font-mono">{String(position.quantity)} sh</span>
                        </div>
                        <div className="mt-1 flex justify-between text-xs text-slate-500">
                          <span>
                            평균 ${Number(position.averagePrice).toFixed(2)} → 현재 $
                            {Number(position.currentPrice).toFixed(2)}
                          </span>
                          <span
                            className={
                              Number(position.profitLoss) < 0
                                ? "text-blue-700"
                                : "text-rose-700"
                            }
                          >
                            {Number(position.profitRate).toFixed(2)}%
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Position 원장</CardTitle>
                <CardDescription>KIS 잔고 성공 시에만 동기화</CardDescription>
              </CardHeader>
              <CardContent>
                {data.agent.positions.length === 0 ? (
                  <p className="text-sm text-slate-500">동기화된 보유 종목 없음</p>
                ) : (
                  <div className="space-y-2">
                    {data.agent.positions.map((position) => (
                      <div
                        key={String(position.id)}
                        className="rounded-md border p-2 text-sm"
                      >
                        <div className="flex justify-between">
                          <span>{String(position.stockName)}</span>
                          <span className="font-mono">{String(position.quantity)}주</span>
                        </div>
                        <div className="mt-1 flex justify-between text-xs text-slate-500">
                          <span>
                            평균 {Number(position.averagePrice).toLocaleString()} → 현재{" "}
                            {Number(position.currentPrice).toLocaleString()}
                          </span>
                          <span
                            className={
                              Number(position.profitLoss) < 0
                                ? "text-blue-700"
                                : "text-rose-700"
                            }
                          >
                            {Number(position.profitRate).toFixed(2)}%
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">최근 로그</CardTitle>
              </CardHeader>
              <CardContent>
                <ScrollArea className="h-64">
                  <div className="space-y-2">
                    {data.agent.recentLogs.length === 0 ? (
                      <p className="text-sm text-slate-500">로그 없음</p>
                    ) : (
                      data.agent.recentLogs.map((log) => (
                        <div key={String(log.id)} className="border-b pb-2 text-xs">
                          <div className="flex justify-between">
                            <span className="font-semibold">{String(log.type)}</span>
                            <span className="text-slate-400">
                              {new Date(String(log.createdAt)).toLocaleTimeString("ko-KR")}
                            </span>
                          </div>
                          <p className="mt-1 text-slate-600">{String(log.message)}</p>
                        </div>
                      ))
                    )}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>
          </div>
        </section>

        <footer className="flex items-center justify-between border-t pt-4 text-xs text-slate-500">
          <span className="flex items-center gap-2">
            <Database className="size-3" />
            Position = KIS 원장 · TradeHistory = 감사 기록
          </span>
          <Button variant="ghost" size="sm" onClick={() => void refresh()}>
            <RefreshCw className={loading ? "animate-spin" : ""} /> 상태 갱신
          </Button>
        </footer>
      </div>
    </main>
  );
}
