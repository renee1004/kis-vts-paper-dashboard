import "server-only";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { bookSchema, refreshResearchNews, researchView } from "./news-research";
import { bookSummary, shadowMarkStale, SHADOW_CAPITAL } from "./news-shadow";
import { assessNews, targetKey, type NewsTarget } from "./news-model";
import { analyzeTrend } from "./strategy";
import { KisVtsClient } from "./kis-vts-client";
import { marketSession } from "./market-calendar";
import { BENCHMARK_SYMBOLS, COMPARISON_VERSION, monthlyMarketFilter, parseBenchmarkResponse, type BenchmarkSnapshot } from "./market-filter";
import { advanceComparison, advancePassive, emptyComparison, type ComparisonState } from "./market-comparison-model";

const root=process.env.DATA_DIR||path.join(process.cwd(),".data");
const file=path.join(root,"market-comparison-v1.json");
const finite=z.number().finite(), nonnegative=finite.nonnegative(), positive=finite.positive(), timestamp=z.string().datetime();
const market=z.enum(["DOMESTIC","US_NASDAQ"]);
const target=z.object({market,stockCode:z.string().min(1).max(20),stockName:z.string().min(1).max(100)});
const passive=z.object({cashKrw:nonnegative,quantity:nonnegative.int(),averagePriceKrw:nonnegative,feesKrw:nonnegative,
  markKrw:positive.nullable(),markAt:timestamp.nullable(),pendingAt:timestamp.nullable(),entryAt:timestamp.nullable(),referencePriceKrw:positive.nullable()});
const verdict=z.object({known:z.boolean(),allow:z.boolean(),reason:z.string(),symbol:z.string(),monthEnds:z.array(z.string()),lastClose:positive.nullable(),average:positive.nullable(),fetchedAt:timestamp.nullable()});
const schema=z.object({version:z.literal(COMPARISON_VERSION),startedAt:timestamp,updatedAt:timestamp,eligibleSince:timestamp.nullable(),
  base:bookSchema,filtered:bookSchema,passive:z.object({DOMESTIC:passive,US_NASDAQ:passive}),
  excursions:z.array(z.object({key:z.string(),book:z.enum(["base","filtered"]),market,symbol:z.string(),entryAt:timestamp,entryPriceKrw:positive,
    maePct:finite.max(0),mfePct:nonnegative,closedAt:timestamp.nullable()})),
  filters:z.object({DOMESTIC:verdict.optional(),US_NASDAQ:verdict.optional()}),
  counts:z.object({observations:nonnegative.int(),buyCandidates:nonnegative.int(),commonBlocked:nonnegative.int(),filterPassed:nonnegative.int(),filterBlocked:nonnegative.int()}),
  lastDecision:z.string(),lastError:z.string().nullable(),universe:z.array(target).max(40),
});
type StoredComparison=ComparisonState&{universe:NewsTarget[]};
const runtime=globalThis as typeof globalThis&{
  __marketComparison?:StoredComparison; __marketComparisonTimer?:ReturnType<typeof setInterval>;
  __marketComparisonJob?:Promise<void>; __marketComparisonEnabled?:boolean; __marketComparisonError?:string|null;
  __benchmarkSnapshots?:Partial<Record<NewsTarget["market"],BenchmarkSnapshot>>;
};
function getState():StoredComparison {
  if(runtime.__marketComparison) return runtime.__marketComparison;
  try {
    const stored=schema.parse(JSON.parse(fs.readFileSync(file,"utf8")));
    stored.base.pending={};stored.filtered.pending={};
    stored.passive.DOMESTIC.pendingAt=null;stored.passive.US_NASDAQ.pendingAt=null;
    return runtime.__marketComparison=stored;
  } catch(error){
    if((error as NodeJS.ErrnoException).code!=="ENOENT") throw new Error("COMPARISON_HISTORY_UNREADABLE");
    return runtime.__marketComparison={...emptyComparison(new Date().toISOString()),universe:[]};
  }
}
function commit(next:StoredComparison,event:unknown):void {
  schema.parse(next); fs.mkdirSync(root,{recursive:true,mode:0o700});
  const evidence=JSON.stringify({version:COMPARISON_VERSION,event});
  const fd=fs.openSync(path.join(root,"market-comparison-v1-events.jsonl"),"a",0o600);
  try { fs.writeFileSync(fd,JSON.stringify({id:crypto.createHash("sha256").update(evidence).digest("hex"),recordedAt:new Date().toISOString(),...JSON.parse(evidence)})+"\n");fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  const temp=`${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp,JSON.stringify(next),{mode:0o600});fs.renameSync(temp,file);runtime.__marketComparison=next;
}
async function benchmarkSnapshot(which:NewsTarget["market"]):Promise<BenchmarkSnapshot> {
  const cache=runtime.__benchmarkSnapshots??={};
  const previous=cache[which];
  if(previous&&Date.now()-Date.parse(previous.fetchedAt)>=0&&Date.now()-Date.parse(previous.fetchedAt)<6*3600_000) return previous;
  const url=`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(BENCHMARK_SYMBOLS[which])}?range=2y&interval=1d&events=div%2Csplits`;
  const response=await fetch(url,{cache:"no-store",signal:AbortSignal.timeout(15_000)});
  if(!response.ok) throw new Error("BENCHMARK_FETCH_FAILED");
  const text=await response.text();if(text.length>2_000_000) throw new Error("BENCHMARK_RESPONSE_TOO_LARGE");
  if(!runtime.__marketComparisonEnabled) throw new Error("COMPARISON_STOPPED");
  const snapshot=parseBenchmarkResponse(JSON.parse(text),which,new Date().toISOString());
  const next=structuredClone(getState());next.filters[which]=monthlyMarketFilter(which,snapshot,new Date().toISOString());
  commit(next,{kind:"benchmark_snapshot",snapshot});
  cache[which]=snapshot;return snapshot;
}
async function cycle():Promise<void> {
  if(runtime.__marketComparisonJob||!runtime.__marketComparisonEnabled) return runtime.__marketComparisonJob;
  const job=async()=>{
    const universe=getState().universe;
    const open=universe.filter(t=>marketSession(t.market).isOpen);
    const snapshots:Partial<Record<NewsTarget["market"],BenchmarkSnapshot>>={};
    for(const which of [...new Set(universe.map(t=>t.market))]){
      if(!runtime.__marketComparisonEnabled) return;
      try { snapshots[which]=await benchmarkSnapshot(which); }
      catch {
        if(!runtime.__marketComparisonEnabled) return;
        runtime.__marketComparisonError="시장 기준 데이터 수집 실패: 신규 가상 진입 보류";
        const next=structuredClone(getState());next.filters[which]=monthlyMarketFilter(which,null,new Date().toISOString());
        commit(next,{kind:"benchmark_unavailable",market:which});
      }
    }
    if(!open.length) return;
    await refreshResearchNews(universe);
    const client=new KisVtsClient();
    for(const t of open){
      if(!runtime.__marketComparisonEnabled) break;
      try {
        const price=t.market==="DOMESTIC"?await client.getPrice(t.stockCode):await client.getOverseasPrice(t.stockCode);
        const quoteAt=Date.now();
        const bars=t.market==="DOMESTIC"?await client.getDailyBars(t.stockCode):await client.getOverseasDailyBars(t.stockCode);
        if(!runtime.__marketComparisonEnabled) break;
        if(bars.length<65){runtime.__marketComparisonError=`${t.stockName}: 완료된 일봉 65개 미만으로 관찰 보류`;continue;}
        if(Date.now()-quoteAt>30_000) throw new Error("QUOTE_TOO_OLD");
        const at=new Date().toISOString(), signal=analyzeTrend(bars), newsState=researchView(universe);
        const news=assessNews({target:t,universe,articles:newsState.articles,feeds:newsState.feeds,signal,price,previousClose:bars.at(-1)?.close??0,at});
        const next=structuredClone(getState());
        const observation={target:t,signal,price,previousClose:bars.at(-1)?.close??0,at,news};
        const event=advanceComparison(next,observation,snapshots[t.market]??null);
        if(event) commit(next,{kind:"observation",observation,event});
      } catch { runtime.__marketComparisonError=`${t.stockName}: 시세·뉴스·기록 확인 실패`; }
    }
    for(const which of [...new Set(open.map(t=>t.market))]){
      if(!runtime.__marketComparisonEnabled) break;
      try {
        const price=which==="DOMESTIC"?await client.getPrice("069500"):await client.getOverseasPrice("SPY","AMS");
        if(!runtime.__marketComparisonEnabled) break;
        const at=new Date().toISOString(), next=structuredClone(getState());
        advancePassive(next,which,price,at);commit(next,{kind:"passive_quote",market:which,price,at});
      } catch { runtime.__marketComparisonError="지수 보유 기준 시세·기록 확인 실패"; }
    }
  };
  runtime.__marketComparisonError=null;
  runtime.__marketComparisonJob=job().catch(error=>{
    const code=error instanceof Error&&/^[A-Z_]+$/.test(error.message)?` (${error.message})`:"";
    runtime.__marketComparisonError=`비교 기록 중단: 데이터·저장 상태 확인 필요${code}`;
  }).finally(()=>{runtime.__marketComparisonJob=undefined;});
  return runtime.__marketComparisonJob;
}
export function startMarketComparison(targets:NewsTarget[]):void {
  const next=structuredClone(getState());
  if(!next.universe.length){
    next.universe=[...new Map(targets.map(t=>[targetKey(t),t])).values()].sort((a,b)=>targetKey(a).localeCompare(targetKey(b))).slice(0,40);
    if(!next.universe.length) throw new Error("COMPARISON_UNIVERSE_EMPTY");
    commit(next,{kind:"start",universe:next.universe,benchmarkSymbols:BENCHMARK_SYMBOLS});
  }
  runtime.__marketComparisonEnabled=true;
  if(!runtime.__marketComparisonTimer){runtime.__marketComparisonTimer=setInterval(()=>{void cycle();},5*60_000);runtime.__marketComparisonTimer.unref?.();}
  void cycle();
}
export function stopMarketComparison():void {
  runtime.__marketComparisonEnabled=false;
  if(runtime.__marketComparisonTimer) clearInterval(runtime.__marketComparisonTimer);
  runtime.__marketComparisonTimer=undefined;
}
export function marketComparisonView(){
  const current=getState(),now=Date.now();
  const summary=(book:StoredComparison["base"])=>{
    const result=bookSummary(book,now,true), ready=!!current.eligibleSince&&!result.staleMarks;
    return {...result,navKrw:ready?result.navKrw:null,returnPct:ready?result.returnPct:null};
  };
  const passiveRows=Object.entries(current.passive).map(([which,lot])=>({market:which,...lot,
    navKrw:lot.markKrw==null&&lot.quantity>0?null:lot.cashKrw+lot.quantity*(lot.markKrw??0),
    stale:lot.quantity>0&&shadowMarkStale(`${which}:benchmark`,lot.markAt?{at:lot.markAt}:undefined,now,true)}));
  const passiveReady=!!current.eligibleSince&&passiveRows.every(p=>!!p.entryAt&&!p.stale&&p.navKrw!=null);
  const passiveNav=passiveReady?passiveRows.reduce((sum,p)=>sum+p.navKrw!,0):null;
  return {version:current.version,isCollecting:!!runtime.__marketComparisonEnabled,cycleRunning:!!runtime.__marketComparisonJob,
    waitingForMarket:current.universe.length>0&&!current.universe.some(t=>marketSession(t.market).isOpen),
    startedAt:current.startedAt,updatedAt:current.updatedAt,eligibleSince:current.eligibleSince,universe:current.universe,
    lastError:runtime.__marketComparisonError??current.lastError,lastDecision:current.lastDecision,filters:current.filters,counts:current.counts,
    base:summary(current.base),filtered:summary(current.filtered),passive:{navKrw:passiveNav,returnPct:passiveNav==null?null:(passiveNav/SHADOW_CAPITAL-1)*100,markets:passiveRows},
    excursionCount:current.excursions.length,excursions:current.excursions.slice(-30),executionMode:"LOCAL_SHADOW_ONLY" as const,
    assumptions:{budgetKrw:SHADOW_CAPITAL,usdKrw:1500,costBpsPerSide:15,slippageBpsPerSide:10,samplingSeconds:300,benchmarkSymbols:BENCHMARK_SYMBOLS}};
}
export type MarketComparisonView=ReturnType<typeof marketComparisonView>;
