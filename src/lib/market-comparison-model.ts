import { advanceShadow, emptyBook, SHADOW_CAPITAL, SHADOW_FEE, SHADOW_FX, SHADOW_SLIPPAGE, type ResearchObservation, type ShadowBook } from "./news-shadow";
import { newsCheckedBuyVerdict } from "./news-defend";
import { COMPARISON_VERSION, monthlyMarketFilter, type BenchmarkSnapshot, type MarketFilterVerdict } from "./market-filter";
import { marketSession } from "./market-calendar";
import { targetKey } from "./news-model";
import type { TradingMarket } from "./domain";

export interface Excursion {
  key: string; book: "base"|"filtered"; market: TradingMarket; symbol: string;
  entryAt: string; entryPriceKrw: number; maePct: number; mfePct: number; closedAt: string|null;
}
export interface PassiveLot {
  cashKrw: number; quantity: number; averagePriceKrw: number; feesKrw: number;
  markKrw: number|null; markAt: string|null; pendingAt: string|null; entryAt: string|null; referencePriceKrw: number|null;
}
export interface ComparisonState {
  version: typeof COMPARISON_VERSION; startedAt: string; updatedAt: string; eligibleSince: string|null;
  base: ShadowBook; filtered: ShadowBook; passive: Record<TradingMarket,PassiveLot>;
  excursions: Excursion[]; filters: Partial<Record<TradingMarket,MarketFilterVerdict>>;
  counts: { observations: number; buyCandidates: number; commonBlocked: number; filterPassed: number; filterBlocked: number };
  lastDecision: string; lastError: string|null;
}
export function emptyComparison(at: string): ComparisonState {
  const passive=():PassiveLot=>({cashKrw:SHADOW_CAPITAL/2,quantity:0,averagePriceKrw:0,feesKrw:0,markKrw:null,markAt:null,pendingAt:null,entryAt:null,referencePriceKrw:null});
  return {version:COMPARISON_VERSION,startedAt:at,updatedAt:at,eligibleSince:null,base:emptyBook(),filtered:emptyBook(),
    passive:{DOMESTIC:passive(),US_NASDAQ:passive()},excursions:[],filters:{},
    counts:{observations:0,buyCandidates:0,commonBlocked:0,filterPassed:0,filterBlocked:0},lastDecision:"자료 준비 중",lastError:null};
}
/** Shared news/chart inputs, independent cash/positions. Only B applies allow.
 * Until the reference data is known, BOTH books warm up to avoid an unfair start.
 */
export function advanceComparison(state: ComparisonState, observation: ResearchObservation, snapshot: BenchmarkSnapshot|null) {
  const key=targetKey(observation.target), at=observation.at, now=Date.parse(at);
  if(!Number.isFinite(now)||!Number.isFinite(observation.price)||observation.price<=0||
    Date.parse(state.base.marks[key]?.at??"")>=now) return null;
  const market=observation.target.market;
  const filter=monthlyMarketFilter(market,snapshot,at);
  const news=newsCheckedBuyVerdict({newsSide:observation.news.side,reason:observation.news.reason,fresh:observation.news.fresh,at},now);
  const ready=filter.known&&!news.block;
  const session=marketSession(market,new Date(now));
  state.filters[market]=filter; state.counts.observations++;
  if(ready&&session.isOpen&&!state.eligibleSince) state.eligibleSince=at;
  if(observation.signal.side==="BUY"){
    state.counts.buyCandidates++;
    if(!ready) state.counts.commonBlocked++;
    else if(filter.allow) state.counts.filterPassed++;
    else state.counts.filterBlocked++;
  }
  const events: Record<string,string[]>={};
  const price=observation.price*(market==="US_NASDAQ"?SHADOW_FX:1);
  for(const name of ["base","filtered"] as const){
    const book=state[name], before=book.positions[key];
    const active=state.excursions.find(e=>e.book===name&&e.key===key&&!e.closedAt);
    if(active&&session.isOpen){
      const move=(price/active.entryPriceKrw-1)*100;
      active.maePct=Math.min(active.maePct,move); active.mfePct=Math.max(active.mfePct,move);
    }
    events[name]=advanceShadow(book,observation,"price",{entryAllowed:ready&&(name==="base"||filter.allow),carryClosedMarketMarks:true});
    const after=book.positions[key];
    if(!before&&after) state.excursions.push({key,book:name,market,symbol:observation.target.stockCode,entryAt:at,
      entryPriceKrw:after.averagePriceKrw,maePct:Math.min(0,(price/after.averagePriceKrw-1)*100),mfePct:Math.max(0,(price/after.averagePriceKrw-1)*100),closedAt:null});
    if(active&&!after) active.closedAt=at;
  }
  state.updatedAt=at;
  state.lastDecision=`${observation.target.stockName}: ${!ready?news.block?news.reason:filter.reason:filter.allow?"지수 필터 통과":"지수 필터 신규 진입 보류"}`;
  return {at,target:observation.target,filter,news,ready,signal:observation.signal,events};
}

/** Passive benchmark: 50% domestic / 50% US, whole shares, no rebalancing.
 * This benchmark deliberately has a different exposure from the <=50% strategy.
 */
export function advancePassive(state: ComparisonState, market: TradingMarket, price: number, at: string): void {
  const lot=state.passive[market], now=Date.parse(at);
  if(!state.eligibleSince||!Number.isFinite(price)||price<=0||!Number.isFinite(now)||
    Date.parse(lot.markAt??"")>=now||!marketSession(market,new Date(now)).isOpen) return;
  const priceKrw=price*(market==="US_NASDAQ"?SHADOW_FX:1);
  lot.markKrw=priceKrw; lot.markAt=at;
  if(lot.entryAt) return;
  if(!lot.pendingAt){lot.pendingAt=at;lot.referencePriceKrw=priceKrw;return;}
  const age=now-Date.parse(lot.pendingAt);
  if(age<30_000) return;
  if(age>15*60_000){lot.pendingAt=at;lot.referencePriceKrw=priceKrw;return;}
  const execution=priceKrw*(1+SHADOW_SLIPPAGE);
  const quantity=Math.floor(lot.cashKrw/(execution*(1+SHADOW_FEE)));
  if(quantity<1) return;
  const cost=quantity*execution, fee=cost*SHADOW_FEE;
  lot.quantity=quantity;lot.cashKrw-=cost+fee;lot.feesKrw+=fee;lot.averagePriceKrw=execution;lot.entryAt=at;lot.pendingAt=null;
}
