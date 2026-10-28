"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { MarketComparisonView } from "@/lib/market-comparison";

const money=(n:number|null)=>n==null?"평가 자료 대기":`${Math.round(n).toLocaleString("ko-KR")}원`;
const pct=(n:number|null)=>n==null?"—":`${n.toFixed(2)}%`;
export function MarketComparisonPanel(){
  const [data,setData]=useState<MarketComparisonView|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  const refresh=useCallback(async(action?:"start"|"stop")=>{
    if(action) setBusy(true);
    try {
      const response=await fetch("/api/strategy-comparison",{method:action?"POST":"GET",cache:"no-store",headers:action?{"Content-Type":"application/json"}:undefined,body:action?JSON.stringify({action}):undefined});
      const result=await response.json();if(!response.ok||!result.success) throw new Error(result.error||"비교 조회 실패");
      setData(result.data);setError("");
    } catch(cause){setError(cause instanceof Error?cause.message:"비교 조회 실패");}
    finally {setBusy(false);}
  },[]);
  useEffect(()=>{
    const first=setTimeout(()=>void refresh(),0),timer=setInterval(()=>void refresh(),15_000);
    return()=>{clearTimeout(first);clearInterval(timer);};
  },[refresh]);
  return <Card>
    <CardHeader><div className="flex flex-wrap items-center justify-between gap-3"><CardTitle>시장지수 필터 비교</CardTitle>
      <Button disabled={busy||!data} onClick={()=>void refresh(data?.isCollecting?"stop":"start")}>{busy?"처리 중…":data?.isCollecting?"비교 기록 정지":"비교 기록 시작"}</Button></div>
      <CardDescription>뉴스·종목 차트에 시장지수 조건을 더했을 때의 차이를 가상 장부로 관찰합니다. 이 기능은 증권사 주문을 보내지 않습니다.</CardDescription></CardHeader>
    <CardContent className="space-y-4">
      {error&&<p role="alert" className="text-sm text-red-600">{error}</p>}
      {data&&<>
        <p className="text-sm">{data.isCollecting?data.cycleRunning?"시세·뉴스 수집 중":data.waitingForMarket?"시장 개장 대기 · 개장 중 5분 간격 수집":"5분 간격 비교 기록 중":"비교 기록 정지"} · {data.lastDecision}</p>
        {data.lastError&&<p role="alert" className="text-sm text-amber-700">{data.lastError}</p>}
        <div className="grid gap-3 md:grid-cols-3">{[
          {label:"기본 전략: 뉴스 + 종목 차트",nav:data.base.navKrw,rate:data.base.returnPct},
          {label:"시장지수 필터 추가",nav:data.filtered.navKrw,rate:data.filtered.returnPct},
          {label:"비교 기준: 국내·미국 ETF 절반씩 보유",nav:data.passive.navKrw,rate:data.passive.returnPct},
        ].map(row=><div key={row.label} className="rounded-md border p-3"><p className="text-sm text-slate-500">{row.label}</p><p className="text-lg font-semibold">{money(row.nav)}</p><p>{pct(row.rate)}</p></div>)}</div>
        <p className="text-sm">{data.eligibleSince?`비교 관찰 시작: ${new Date(data.eligibleSince).toLocaleString("ko-KR",{timeZone:"Asia/Seoul"})}`:"기준 지수·뉴스 자료 준비 중입니다. 두 전략 모두 준비 후 신규 가상 진입을 시작합니다."}</p>
        <ul className="space-y-1 text-sm">{(["DOMESTIC","US_NASDAQ"] as const).map(m=>{
          const f=data.filters[m];return <li key={m}>{m==="DOMESTIC"?"국내 KODEX200":"미국 SPY"}: {!f?"미수집":!f.known?`자료 확인 필요 (${f.reason})`:f.allow?"직전 월말이 10개월 평균 위: 신규 진입 허용":"직전 월말이 10개월 평균 이하: 신규 진입 보류"}</li>;
        })}</ul>
        <p className="text-xs text-slate-500">두 전략은 같은 시세·뉴스·비용을 사용합니다. 지수 필터는 신규 매수에만 적용하며 기존 보유분의 청산 규칙은 유지합니다. 관찰 시작 시 관심종목 {data.universe.length}개를 고정합니다. 반복 매수 후보 관찰 {data.counts.buyCandidates}회 중 공통 자료 보류 {data.counts.commonBlocked}회, 필터 통과 {data.counts.filterPassed}회, 필터 보류 {data.counts.filterBlocked}회이며 독립 거래 수가 아닙니다.</p>
        <p className="text-xs text-slate-500">각 장부 예산 3,000만 원, 환율 1,500원 고정. 편도 비용 0.15%와 불리한 체결 가격 0.10%를 가정합니다. 최소 30초 이후 다음 관측 가격으로 체결하며 실제 체결이나 순수익을 뜻하지 않습니다. 최대 역행·상승폭은 5분 관측 기준으로, 관측 사이의 손절 가격 도달을 모두 포착하지 못합니다. 기준 ETF 보유는 두 전략보다 시장 노출이 클 수 있습니다. 재시작 후 기록 수집은 정지합니다.</p>
        {data.excursions.length>0&&<details><summary className="cursor-pointer text-sm">진입 후 하락·상승폭 기록 ({data.excursionCount}건)</summary>
          <div className="overflow-x-auto"><table className="mt-2 w-full text-sm"><thead><tr><th>전략</th><th>종목</th><th>최대 역행</th><th>최대 상승</th><th>상태</th></tr></thead><tbody>{data.excursions.map(e=><tr key={`${e.book}:${e.key}:${e.entryAt}`}><td>{e.book==="base"?"기본":"필터 추가"}</td><td>{e.symbol}</td><td>{pct(e.maePct)}</td><td>{pct(e.mfePct)}</td><td>{e.closedAt?"청산":"관찰 중"}</td></tr>)}</tbody></table></div></details>}
      </>}
    </CardContent>
  </Card>;
}
