"use client";

import { useEffect, useRef, useState } from "react";
import { createChart, LineSeries, type IChartApi } from "lightweight-charts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { StoredScorecard } from "@/lib/scorecard-data";

type Point = { date: string; value: number };
type Chart = { bars: Point[]; ma20: Point[]; ma60: Point[]; ma200: Point[] } | null;
const label = { fundamentals: "펀더멘털", flows: "수급", technical: "기술적", news: "뉴스", macro: "거시" } as const;
const score = (s: number | "UNKNOWN") => s === "UNKNOWN" ? "미확인" : s > 0 ? "+1" : String(s);
const won = (n: number | null) => n == null ? "—" : n.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
const toTime = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;

function PriceChart({ chart }: { chart: Chart }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current || !chart?.bars.length) return;
    const api: IChartApi = createChart(ref.current, { height: 220, layout: { attributionLogo: true } });
    const add = (data: Point[], color: string, width: 1 | 2) =>
      api.addSeries(LineSeries, { color, lineWidth: width, priceLineVisible: false }).setData(data.map((p) => ({ time: toTime(p.date), value: p.value })));
    add(chart.bars, "#111827", 2); add(chart.ma20, "#2563eb", 1); add(chart.ma60, "#f59e0b", 1); add(chart.ma200, "#dc2626", 1);
    api.timeScale().fitContent();
    return () => api.remove();
  }, [chart]);
  if (!chart?.bars.length) return <p className="text-sm text-muted-foreground">일봉 캐시 없음 (scripts/scorecard-collect.py 실행 필요)</p>;
  return <div><div ref={ref} /><p className="text-xs text-muted-foreground">검정 종가 · 파랑 20일 · 주황 60일 · 빨강 200일 (차트: TradingView Lightweight Charts)</p></div>;
}

export function ScorecardPanel() {
  const [cards, setCards] = useState<StoredScorecard[]>([]);
  const [cutover, setCutover] = useState<{ cutoverAt: string; previousVersion: string } | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [chart, setChart] = useState<Chart>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const load = async () => {
      try {
        const [market, stockCode] = selected.split(":");
        const query = selected ? `?market=${market}&stockCode=${encodeURIComponent(stockCode)}` : "";
        const result = await (await fetch(`/api/scorecard${query}`, { cache: "no-store" })).json();
        if (!result.success) throw new Error(result.error);
        setCards(result.data.cards); setCutover(result.data.cutover); setChart(result.data.chart); setError("");
      } catch (cause) { setError(cause instanceof Error ? cause.message : "점수판 조회 실패"); }
    };
    const first = setTimeout(() => void load(), 0), timer = setInterval(() => void load(), 30_000);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [selected]);
  const card = cards.find((c) => `${c.market}:${c.stockCode}` === selected);
  return <Card>
    <CardHeader><CardTitle>5관점 점수판 (모의주문 판단)</CardTitle>
      <CardDescription>모의(VTS) 주문 판단은 점수판 결론으로 합니다. 매수검토·전량매도만 모의주문 후보이고, 모든 주문은 기존 안전 잠금을 그대로 거칩니다.
        {cutover && ` 교체 시점: ${new Date(cutover.cutoverAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })} (이전 기록은 ${cutover.previousVersion})`}</CardDescription></CardHeader>
    <CardContent className="space-y-3">
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {!cards.length && <p className="text-sm text-muted-foreground">분석 사이클 실행 후 표시됩니다.</p>}
      <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="text-left">
        <th>종목</th>{Object.values(label).map((l) => <th key={l}>{l}</th>)}<th>결론</th><th>필터</th></tr></thead>
        <tbody>{cards.map((c) => { const k = `${c.market}:${c.stockCode}`; return <tr key={k} className={k === selected ? "bg-muted" : "cursor-pointer"} onClick={() => setSelected(k)}>
          <td>{c.stockName}</td>{(Object.keys(label) as (keyof typeof label)[]).map((p) => <td key={p} title={c.views[p].reason}>{score(c.views[p].score)}</td>)}
          <td className="font-medium">{c.conclusion}</td><td className="text-xs">{c.filters.join(", ") || "—"}</td></tr>; })}</tbody></table></div>
      {card && <div className="space-y-1 text-sm">
        <p>{card.bullCase}</p><p>{card.bearCase}</p><p className="text-muted-foreground">{card.portfolioNote}</p>
        <p>진입가 {won(card.entryPrice)} · 손절선 {won(card.stopLoss)} · 틀렸다는 신호: {card.invalidation}</p>
        <PriceChart chart={chart} /></div>}
    </CardContent></Card>;
}
