"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { matchNews, targetKey, type NewsTarget } from "@/lib/news-model";
import type { NewsResearchView } from "@/lib/news-research";

const sideLabel = { BUY: "매수 후보", SELL: "보유분 매도 후보", HOLD: "대기" };
const relationLabel = { DIRECT: "직접 언급", SECTOR: "업종 연관", MACRO: "거시 참고" };
const directionLabel = { POSITIVE: "긍정 가설", NEGATIVE: "부정 가설", UNCERTAIN: "방향 미확인" };
const clock = (value: string | null) => value ? new Date(value).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) : "미수집";
export function NewsResearchPanel({ targets, running }: { targets: NewsTarget[]; running: boolean }) {
  const [data, setData] = useState<NewsResearchView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState("");
  const refresh = useCallback(async (collect: boolean) => {
    if (collect) setBusy(true);
    try {
      const response = await fetch("/api/news", { method: collect ? "POST" : "GET", cache: "no-store" });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || "뉴스 상태 조회 실패");
      setData(result.data); setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "뉴스 연결 실패"); }
    finally { if (collect) setBusy(false); }
  }, []);
  useEffect(() => {
    const initial = setTimeout(() => void refresh(true), 0);
    const poll = setInterval(() => void refresh(false), 15_000);
    const collect = setInterval(() => { if (document.visibilityState === "visible") void refresh(true); }, 5 * 60_000);
    return () => { clearTimeout(initial); clearInterval(poll); clearInterval(collect); };
  }, [refresh]);
  const target = targets.find((t) => targetKey(t) === selected) ?? targets[0];
  const matches = target ? (data?.articles ?? []).map((a) => matchNews(a, target, targets))
    .filter((m) => m != null).sort((a, b) => Number(b.relation === "DIRECT") - Number(a.relation === "DIRECT")).slice(0, 12) : [];
  return <Card>
    <CardHeader>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle>국내·미국 뉴스와 전략 비교</CardTitle>
        <Button variant="outline" size="sm" onClick={() => void refresh(true)} disabled={busy}>{busy ? "뉴스 수집 중…" : "뉴스 확인"}</Button>
      </div>
      <CardDescription>뉴스 전략은 별도 가상 원장에서 비교합니다. 이 영역의 후보는 KIS 주문으로 제출되지 않습니다.</CardDescription>
    </CardHeader>
    <CardContent className="space-y-4 text-sm">
      <p className="rounded-md bg-amber-50 p-3 text-amber-950">현재는 RSS 제목에 기반한 뉴스 가설입니다. 본문·공시 진위, 시장 예상치, 거래량·호가 검증은 포함하지 않습니다. 업종·거시 뉴스는 참고만 하며, 항상 매수·매도가 발생하지는 않습니다.</p>
      {error && <p role="alert" className="text-rose-700">{error} · 표시된 기존 정보는 오래되었을 수 있습니다.</p>}
      {data?.journalError && <p role="alert" className="text-rose-700">{data.journalError}</p>}
      <p>{running ? "에이전트 분석 주기에 가격과 가상 판단을 기록합니다." : "에이전트 중지 상태: 뉴스 열람만 가능하며 가상 거래 기록도 대기합니다."} 뉴스 수집은 5분 간격, 가격 비교는 분석 주기 기준입니다.</p>
      {data && <>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader><TableRow><TableHead>동일 조건 가상 비교</TableHead><TableHead>가상 평가액</TableHead><TableHead>비용 반영 수익률</TableHead><TableHead>최대 낙폭</TableHead><TableHead>체결 / 청산 완료</TableHead><TableHead>보유 / 대기</TableHead></TableRow></TableHeader>
            <TableBody>{([ ["가격 조건만", data.price], ["가격 + 뉴스 조건", data.news] ] as const).map(([name, book]) =>
              <TableRow key={name}><TableCell>{name}</TableCell><TableCell>{book.navKrw == null ? "평가 불가" : `${Math.round(book.navKrw).toLocaleString()}원`}{book.staleMarks > 0 && <span className="block text-amber-700">{book.staleMarks}종목 가격 지연</span>}</TableCell>
                <TableCell>{book.returnPct == null ? "—" : `${book.returnPct.toFixed(2)}%`}</TableCell><TableCell>{book.maxDrawdownPct.toFixed(2)}%</TableCell><TableCell>{book.fills} / {book.closedLots}</TableCell><TableCell>{book.holdings} / {book.pending}</TableCell></TableRow>)}</TableBody>
          </Table>
        </div>
        <p className="text-xs text-slate-500">관찰 시작 {clock(data.startedAt)} KST · {data.observations.toLocaleString()}회 종목 관찰(독립 거래 수 아님). 계좌 초기잔고와 같은 금액인 각 3,000만 원으로 새 가상 비교를 시작합니다. 기존 300만 원 비교 원장은 별도 보존합니다. 미국 1회 3,000달러·종목당 15%, 하루 합산 450만 원. 환율 1,500원 고정, 편도 비용 0.15% + 불리한 체결 0.10%. 신호 생성 후 최소 30초가 지난 다음 관측 가격으로 가상 체결합니다. 휴장일·조기폐장·체결 가능 물량은 반영하지 않은 추정이며 실제 계좌 성과가 아닙니다.</p>
        <div className="overflow-x-auto"><Table>
          <TableHeader><TableRow><TableHead>종목 / 뉴스 열기</TableHead><TableHead>가격 전략</TableHead><TableHead>뉴스 추가 전략</TableHead><TableHead>판단 근거</TableHead><TableHead>판단 시각 (KST)</TableHead></TableRow></TableHeader>
          <TableBody>{targets.map((t) => {
            const row = data.decisions.find((d) => targetKey(d.target) === targetKey(t));
            const stale = row && Date.parse(data.asOf) - Date.parse(row.at) > 15 * 60_000;
            return <TableRow key={targetKey(t)}><TableCell><button className="text-left font-medium text-blue-700 underline underline-offset-2" onClick={() => setSelected(targetKey(t))}>{t.stockName} <span className="text-xs text-slate-500">{t.stockCode}</span></button></TableCell>
              <TableCell>{row ? sideLabel[row.priceSide] : "가격 관찰 대기"}</TableCell><TableCell>{row ? sideLabel[row.newsSide] : "판단 대기"}</TableCell>
              <TableCell className="max-w-lg whitespace-normal">{row?.reason ?? "뉴스 수집 후 가격 분석 주기에 판단합니다."}{stale && <span className="block text-amber-700">과거 판단 · 현재 신호로 사용하지 마세요</span>}</TableCell><TableCell className="text-xs">{clock(row?.at ?? null)}</TableCell></TableRow>;
          })}</TableBody>
        </Table></div>
        <div className="rounded-md border p-3">
          <h3 className="mb-2 font-semibold">{target?.stockName ?? "종목"} 관련 뉴스 · 최근 48시간</h3>
          {!matches.length && <p className="text-slate-500">연결된 기사가 없습니다. 아래 수집 상태에서 오류 여부를 확인할 수 있습니다.</p>}
          <ul className="space-y-3">{matches.map((match) => <li key={match.article.id} className="border-b pb-3 last:border-0">
            <a className="font-medium text-blue-700 underline underline-offset-2" href={match.article.url} target="_blank" rel="noopener noreferrer">{match.article.title}</a>
            <p className="mt-1">{relationLabel[match.relation]} · {directionLabel[match.direction]} · {match.reason}</p>
            <p className="mt-1 text-xs text-slate-500">{match.article.source} · {match.article.official ? "공식 RSS" : "Google News 연결 · 원문 미검증"} · 발표 {clock(match.article.publishedAt)} · 최초 수집 {clock(match.article.firstSeenAt)} KST</p>
          </li>)}</ul>
        </div>
        <details className="rounded-md border p-3"><summary className="cursor-pointer font-medium">주요 경제·정책 뉴스와 수집 상태</summary>
          <ul className="mt-3 space-y-2">{data.articles.filter((a) => a.feedId.startsWith("macro:") || a.official).slice(0, 10).map((a) =>
            <li key={a.id}><a href={a.url} target="_blank" rel="noopener noreferrer" className="text-blue-700 underline">{a.title}</a><span className="ml-2 text-xs text-slate-500">{a.source} · {clock(a.publishedAt)}</span></li>)}</ul>
          <ul className="mt-4 space-y-1 text-xs">{data.feeds.map((f) => <li key={f.id} className={f.error ? "text-rose-700" : "text-slate-600"}>{f.label}: {f.error ?? `최근 48시간 기사 ${f.count}건`} · 최근 성공 {clock(f.lastSuccessAt)}</li>)}</ul>
          <p className="mt-3 text-xs text-slate-500">뉴스가 없거나 수집에 실패하면 새 뉴스 매수 판단은 대기합니다. RSS 제공 지연과 기사 누락이 있을 수 있습니다. 종목별 수집은 관심종목 앞 40개까지 지원합니다.</p>
        </details>
      </>}
    </CardContent>
  </Card>;
}
