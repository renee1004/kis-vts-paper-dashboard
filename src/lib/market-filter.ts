import type { TradingMarket } from "./domain";
import { MARKET_CALENDAR } from "./market-calendar-data";

export const BENCHMARK_SYMBOLS = { DOMESTIC: "069500.KS", US_NASDAQ: "SPY" } as const;
export const COMPARISON_VERSION = "news-chart-market-filter-shadow-v1";
export interface BenchmarkBar { date: string; adjustedClose: number; rawClose: number }
export interface BenchmarkSnapshot { market: TradingMarket; symbol: string; fetchedAt: string; source: string; bars: BenchmarkBar[] }
export interface MarketFilterVerdict {
  known: boolean; allow: boolean; reason: string; symbol: string;
  monthEnds: string[]; lastClose: number | null; average: number | null; fetchedAt: string | null;
}
export function marketDateAt(market: TradingMarket, at: string): string {
  const date=new Date(at);
  if (!Number.isFinite(date.getTime())) return "";
  const p=new Intl.DateTimeFormat("en-US",{timeZone:market==="DOMESTIC"?"Asia/Seoul":"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(date);
  return ["year","month","day"].map(k=>p.find(v=>v.type===k)?.value).join("");
}
/** Last ten completed month ends, including the latest completed month's close.
 * A missing expected close is never replaced by the previous available close.
 */
export function monthlyMarketFilter(market: TradingMarket, snapshot: BenchmarkSnapshot | null, at: string): MarketFilterVerdict {
  const result: MarketFilterVerdict={known:false,allow:false,reason:"BENCHMARK_DATA_MISSING",symbol:BENCHMARK_SYMBOLS[market],monthEnds:[],lastClose:null,average:null,fetchedAt:snapshot?.fetchedAt??null};
  const now=Date.parse(at), today=marketDateAt(market,at);
  if (!today) return {...result,reason:"INVALID_OBSERVATION_TIME"};
  if (!snapshot || snapshot.market!==market || snapshot.symbol!==result.symbol) return result;
  const fetched=Date.parse(snapshot.fetchedAt);
  if (!Number.isFinite(fetched) || fetched>now || now-fetched>36*3600_000) return {...result,reason:"BENCHMARK_SNAPSHOT_STALE_OR_FUTURE"};
  const schedule: Readonly<Record<string,readonly string[]>>=MARKET_CALENDAR.markets[market];
  const unverified: readonly string[]=MARKET_CALENDAR.unverifiedDates[market];
  const bars=new Map<string,BenchmarkBar>();
  for(const b of snapshot.bars){
    if(!/^\d{8}$/.test(b.date)||bars.has(b.date)||!Number.isFinite(b.adjustedClose)||b.adjustedClose<=0||!Number.isFinite(b.rawClose)||b.rawClose<=0)
      return {...result,reason:"BENCHMARK_DATA_INVALID"};
    bars.set(b.date,b);
  }
  for(let i=10;i>=1;i--){
    const month=new Date(Date.UTC(Number(today.slice(0,4)),Number(today.slice(4,6))-1-i,1));
    const prefix=month.toISOString().slice(0,7).replace("-","");
    if(prefix+"01"<MARKET_CALENDAR.from || prefix+"31">MARKET_CALENDAR.through)
      return {...result,reason:"MONTH_CALENDAR_UNVERIFIED"};
    const expected=Object.keys(schedule).filter(d=>d.startsWith(prefix)).sort().at(-1);
    if(unverified.some(d=>d.startsWith(prefix)&&(!expected||d>=expected))) return {...result,reason:"MONTH_CALENDAR_UNVERIFIED"};
    if(!expected||!bars.has(expected)) return {...result,reason:"EXPECTED_MONTH_END_CLOSE_MISSING"};
    if(Date.parse(schedule[expected][1])>=now) return {...result,reason:"MONTH_END_NOT_COMPLETED"};
    result.monthEnds.push(expected);
  }
  const closes=result.monthEnds.map(d=>bars.get(d)!.adjustedClose);
  const average=closes.reduce((a,b)=>a+b,0)/10, lastClose=closes[9];
  return {...result,known:true,allow:lastClose>average,reason:lastClose>average?"ABOVE_10_MONTH_AVERAGE":"NOT_ABOVE_10_MONTH_AVERAGE",average,lastClose};
}

/** Strict parser for a research-only Yahoo daily snapshot; no adjusted/raw fallback. */
export function parseBenchmarkResponse(value: unknown, market: TradingMarket, fetchedAt: string): BenchmarkSnapshot {
  const envelope=value as {chart?:{result?:Array<{meta?:{symbol?:string};timestamp?:number[];indicators?:{quote?:Array<{close?:Array<number|null>}>;adjclose?:Array<{adjclose?:Array<number|null>}>}}>;error?:unknown}};
  const row=envelope?.chart?.result?.[0], symbol=BENCHMARK_SYMBOLS[market];
  if(envelope?.chart?.error||row?.meta?.symbol!==symbol||!row.timestamp?.length||!row.indicators?.quote?.[0]?.close||!row.indicators.adjclose?.[0]?.adjclose)
    throw new Error("BENCHMARK_RESPONSE_INVALID");
  const bars: BenchmarkBar[]=[];
  row.timestamp.forEach((time,i)=>{
    const rawClose=row.indicators!.quote![0].close![i], adjustedClose=row.indicators!.adjclose![0].adjclose![i];
    if(rawClose==null||adjustedClose==null) return;
    if(!Number.isFinite(time)||!Number.isFinite(rawClose)||rawClose<=0||!Number.isFinite(adjustedClose)||adjustedClose<=0) throw new Error("BENCHMARK_PRICE_INVALID");
    bars.push({date:marketDateAt(market,new Date(time*1000).toISOString()),rawClose,adjustedClose});
  });
  if(!bars.length) throw new Error("BENCHMARK_PRICES_EMPTY");
  return {market,symbol,fetchedAt,source:"YAHOO_DAILY_RESEARCH_SNAPSHOT",bars};
}
