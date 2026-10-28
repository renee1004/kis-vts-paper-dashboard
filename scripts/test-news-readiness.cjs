const assert = require('node:assert/strict');
const { createLoader } = require('./lib/load-source.cjs');
const load = createLoader();
const {newsCheckedBuyVerdict, PRICE_STRATEGY_NEWS_SELL_REASON} = load('src/lib/news-defend.ts');
const {matchNews} = load('src/lib/news-model.ts');
const now = Date.parse('2026-10-28T01:00:00Z');
const stance = {newsSide:'HOLD',reason:'종목 뉴스 검토 완료',fresh:true,at:new Date(now).toISOString()};
for (const value of [null, {...stance,fresh:false}, {...stance,at:'bad'}, {...stance,at:new Date(now-180001).toISOString()}, {...stance,at:new Date(now+1).toISOString()}, {...stance,reason:''}]) {
  assert.equal(newsCheckedBuyVerdict(value,now).blockedReason,'NEWS_ANALYSIS_UNAVAILABLE');
}
assert.equal(newsCheckedBuyVerdict(stance,NaN).block,true);
assert.equal(newsCheckedBuyVerdict(stance,now).block,false);
assert.equal(newsCheckedBuyVerdict({...stance,newsSide:'BUY'},now).block,false);
assert.equal(newsCheckedBuyVerdict({...stance,newsSide:'SELL',reason:'악재 확인'},now).blockedReason,'NEWS_DEFEND');
assert.equal(newsCheckedBuyVerdict({...stance,newsSide:'SELL',reason:PRICE_STRATEGY_NEWS_SELL_REASON},now).block,false);
const target={market:'DOMESTIC',stockCode:'003670',stockName:'포스코퓨처엠'};
const article={id:'1',title:'POSCO Holdings earnings beat estimates',url:'https://example.com/1',source:'test',feedId:'test',publishedAt:stance.at,firstSeenAt:stance.at,official:false};
assert.equal(matchNews(article,target,[target]),null);
assert.equal(matchNews({...article,title:'POSCO Future M earnings beat estimates'},target,[target]).relation,'DIRECT');
assert.equal(matchNews({...article,title:'포스코퓨처엠 계약 체결'},target,[target]).relation,'DIRECT');
const runtime = globalThis;
runtime.__newsResearch={version:load('src/lib/news-model.ts').NEWS_VERSION,decisions:{},articles:[]};
const {researchBuyNewsBlock}=load('src/lib/news-research.ts');
assert.equal(researchBuyNewsBlock('DOMESTIC','005930',now).blockedReason,'NEWS_ANALYSIS_UNAVAILABLE');
runtime.__newsResearch.decisions['DOMESTIC:005930']={...stance,evidenceIds:[]};
assert.equal(researchBuyNewsBlock('DOMESTIC','005930',now).block,false);
delete runtime.__newsResearch;
console.log('PASS news freshness gates, neutral review, adverse-news block, company identity, research buy integration');
