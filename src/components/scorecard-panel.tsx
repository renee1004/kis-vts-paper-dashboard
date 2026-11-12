"use client";

import { useEffect, useRef, useState } from "react";
import { createChart, LineSeries, type IChartApi } from "lightweight-charts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { CrudeOilReference, PsrReference, StoredScorecard } from "@/lib/scorecard-data";

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

function fmtPct(n: number | null | undefined) {
  return n == null ? "미확인" : `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;
}
function ReferenceNotes({ psr, crudeOil }: { psr?: PsrReference; crudeOil: CrudeOilReference | null }) {
  const oil = crudeOil;
  const oilSource = oil?.source && oil.source !== "unknown" ? oil.source : "unknown";
  const psrText = psr?.psr != null ? `${psr.psr.toFixed(2)}배` : "미확인";
  const psrSource = psr?.psr != null ? (psr.source || "unknown") : "unknown";
  return <div className="rounded-md border border-dashed p-2 space-y-1 text-sm">
    <p className="font-medium">참고 (미검증)</p>
    <p className="text-xs text-muted-foreground">점수·결론·필터·모의주문에 사용하지 않습니다.</p>
    {psr && <p>PSR(주가매출비율) {psrText} [{psrSource}]</p>}
    <p>원유(WTI) 코스피 선행 가설(약 1.5~2개월, 미검증) · 20/60일 추세 {oil?.trend ?? "미확인"}
      · 약 40거래일 변화 {fmtPct(oil?.laggedChange40dPct ?? null)}
      · 종가 {oil?.lastClose != null ? oil.lastClose.toFixed(2) : "미확인"}
      [{oilSource}{oil?.symbol ? ` ${oil.symbol}` : ""}]</p>
  </div>;
}

function CalendarMismatchWarning({ messages, stale, unavailable }: { messages: string[]; stale: boolean; unavailable: boolean }) {
  if (stale) {
    return <p role="status" className="rounded-md border border-dashed p-2 text-sm text-muted-foreground">달력 대조 자료가 오래되어 미확인입니다. 주문 게이트는 바꾸지 않습니다.</p>;
  }
  if (!unavailable && !messages.length) return null;
  return <div role="status" className="rounded-md border border-amber-300 bg-amber-50 p-2 space-y-1 text-sm">
    <p className="font-medium">달력 불일치 (표시·연구 전용, 주문 게이트 아님)</p>
    {unavailable && <p className="text-sm">달력 대조 실패 (미확인). 주문 게이트는 바꾸지 않습니다.</p>}
    {messages.slice(0, 8).map((line) => <p key={line} className="font-mono text-xs">{line}</p>)}
    {messages.length > 8 && <p className="text-xs text-muted-foreground">외 {messages.length - 8}건</p>}
  </div>;
}

export function ScorecardPanel() {
  const [cards, setCards] = useState<StoredScorecard[]>([]);
  const [cutover, setCutover] = useState<{ cutoverAt: string; previousVersion: string; version?: string; scorecardVersion?: string } | null>(null);
  const [crudeOil, setCrudeOil] = useState<CrudeOilReference | null>(null);
  const [calendar, setCalendar] = useState<{ messages: string[]; stale: boolean; unavailable: boolean }>({ messages: [], stale: false, unavailable: false });
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
        setCards(result.data.cards); setCutover(result.data.cutover); setChart(result.data.chart);
        setCrudeOil(result.data.crudeOil ?? null);
        setCalendar({
          messages: result.data.calendarCrosscheck?.messages ?? [],
          stale: !!result.data.calendarCrosscheck?.stale,
          unavailable: !!result.data.calendarCrosscheck?.unavailable,
        });
        setError("");
      } catch (cause) { setError(cause instanceof Error ? cause.message : "점수판 조회 실패"); }
    };
    const first = setTimeout(() => void load(), 0), timer = setInterval(() => void load(), 30_000);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [selected]);
  const card = cards.find((c) => `${c.market}:${c.stockCode}` === selected);
  return <Card>
    <CardHeader><CardTitle>5관점 점수판 (표시·연구 전용)</CardTitle>
      <CardDescription>모의(VTS) 주문은 추세 돌파 전략이 판단합니다. 점수판 결론(매수검토·전량매도 포함)과 PSR·WTI 참고값은 주문 방향·수량·제출 여부에 쓰지 않습니다. 모든 주문은 기존 안전 잠금을 그대로 거칩니다.
        {cutover && ` 라이브 엔진: ${cutover.version ?? "trend-breakout-v2"} · 복원 ${new Date(cutover.cutoverAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })} (점수판 ${cutover.scorecardVersion ?? cutover.previousVersion}은 표시 전용)`}</CardDescription></CardHeader>
    <CardContent className="space-y-3">
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <CalendarMismatchWarning messages={calendar.messages} stale={calendar.stale} unavailable={calendar.unavailable} />
      <ReferenceNotes psr={card?.references?.psr} crudeOil={crudeOil} />
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
