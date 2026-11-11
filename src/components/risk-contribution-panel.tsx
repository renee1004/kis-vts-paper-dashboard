"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Holding = {
  market: string; stockCode: string; stockName: string;
  weightPct: number | null; volatilityPct: number | null; riskContributionPct: number | null;
  theme?: string | null; evaluationKrw: number | null;
};
type Group = { theme: string; weightPct: number | null; riskContributionPct: number | null };
type Risk = {
  stale: boolean; generatedAt: string | null; usdKrw: number | null; fxSource: string | null;
  holdings: Holding[]; groups: Group[];
  semiconductorWeightPct: number | null; semiconductorRiskContributionPct: number | null;
  riskSource: string | null;
};

const pct = (n: number | null | undefined) => n == null || !Number.isFinite(n) ? "미확인" : `${n.toFixed(1)}%`;
const won = (n: number | null | undefined) => n == null || !Number.isFinite(n) ? "미확인" : `${Math.round(n).toLocaleString("ko-KR")}원`;

export function RiskContributionPanel() {
  const [risk, setRisk] = useState<Risk | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const load = async () => {
      try {
        const result = await (await fetch("/api/scorecard", { cache: "no-store" })).json();
        if (!result.success) throw new Error(result.error);
        setRisk(result.data.riskContribution ?? null); setError("");
      } catch (cause) { setError(cause instanceof Error ? cause.message : "위험기여 조회 실패"); }
    };
    const first = setTimeout(() => void load(), 0), timer = setInterval(() => void load(), 30_000);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, []);
  const holdings = risk?.holdings ?? [];
  const missing = !risk || risk.stale || !holdings.length;
  return <Card>
    <CardHeader><CardTitle>집중도·위험기여 (표시·연구 전용)</CardTitle>
      <CardDescription>보유 평가금액 비중과 포트폴리오 분산 기여입니다. 주문 방향·수량·제출 여부에 쓰지 않습니다. 달러는 앱과 같은 1,500원 가정으로 환산합니다.</CardDescription></CardHeader>
    <CardContent className="space-y-3 text-sm">
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <p className="text-xs text-muted-foreground">
        환율 {risk?.usdKrw ?? 1500}원 [{risk?.fxSource ?? "FIXED_1500_NOT_ACTUAL_FX"}]
        {risk?.riskSource ? ` · 계산 ${risk.riskSource}` : ""}
        {risk?.stale ? " · 수집이 오래되어 미확인" : ""}
      </p>
      <p>반도체 비중 {pct(risk?.semiconductorWeightPct)} · 반도체 위험기여 {pct(risk?.semiconductorRiskContributionPct)}</p>
      {missing && <p className="text-muted-foreground">보유·일봉 데이터가 없어 미확인입니다. 에이전트 잔고 동기화 후 <span className="font-mono">scripts/scorecard-collect.py</span>를 실행하세요.</p>}
      {!missing && <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="text-left">
        <th>종목</th><th>비중</th><th>변동성</th><th>위험기여</th><th>업종/테마</th></tr></thead>
        <tbody>{holdings.map((h) => <tr key={`${h.market}:${h.stockCode}`}>
          <td>{h.stockName}<span className="ml-1 font-mono text-xs text-muted-foreground">{h.stockCode}</span></td>
          <td>{pct(h.weightPct)}</td><td>{pct(h.volatilityPct)}</td><td>{pct(h.riskContributionPct)}</td>
          <td>{h.theme || "미확인"}</td></tr>)}</tbody></table>
        <p className="mt-2 text-xs text-muted-foreground">평가금액 합계 {won(holdings.reduce((s, h) => s + (h.evaluationKrw ?? 0), 0))} · 변동성은 일봉 약 1년 연환산, 위험기여는 포트폴리오 분산 대비 비율입니다.</p>
      </div>}
      {(risk?.groups ?? []).length > 0 && <div>
        <p className="font-medium">테마 합산</p>
        <ul className="text-sm">{risk!.groups.map((g) => <li key={g.theme}>{g.theme} · 비중 {pct(g.weightPct)} · 위험기여 {pct(g.riskContributionPct)}</li>)}</ul>
      </div>}
    </CardContent>
  </Card>;
}
