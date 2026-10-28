const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createLoader}=require('./lib/load-source.cjs');
const load=createLoader();
const {monthlyMarketFilter,parseBenchmarkResponse,BENCHMARK_SYMBOLS}=load('src/lib/market-filter.ts');
const {MARKET_CALENDAR}=load('src/lib/market-calendar-data.ts');
const {emptyComparison,advanceComparison,advancePassive}=load('src/lib/market-comparison-model.ts');
const {shadowMarkStale}=load('src/lib/news-shadow.ts');
const realDate=Date, now0=Date.parse('2026-11-02T01:00:00Z');let now=now0,passed=0;
const iso=()=>new realDate(now).toISOString();
function snapshot(market='DOMESTIC',rising=true){
 const rows=[];
 for(let m=1;m<=10;m++){
  const prefix=`2026${String(m).padStart(2,'0')}`;
  const date=Object.keys(MARKET_CALENDAR.markets[market]).filter(d=>d.startsWith(prefix)).sort().at(-1);
  rows.push({date,rawClose:100,adjustedClose:rising?90+m:110-m});
 }
 return {market,symbol:BENCHMARK_SYMBOLS[market],source:'FIXTURE',fetchedAt:iso(),bars:rows};
}
const observation=(price=100,fresh=true)=>({target:{market:'DOMESTIC',stockCode:'005930',stockName:'삼성전자'},
 price,previousClose:100,at:iso(),signal:{side:'BUY',reason:'fixture',signalDate:'20261030',confidence:100,buyScore:100,sellScore:0,stopFraction:.03},
 news:{side:'HOLD',reason:'뉴스 검토 완료',fresh,matches:[],evidenceIds:[]}});
async function test(name,fn){await fn();passed++;console.log('PASS',name);}
(async()=>{
 await test('ten completed month ends include last month, exclude current and use strict greater-than',()=>{
  const s=snapshot(),v=monthlyMarketFilter('DOMESTIC',s,iso());
  assert.equal(v.known,true);assert.equal(v.allow,true);assert.equal(v.average,95.5);assert.equal(v.lastClose,100);assert.equal(v.monthEnds.length,10);
  const flat={...s,bars:s.bars.map(b=>({...b,adjustedClose:100}))};assert.equal(monthlyMarketFilter('DOMESTIC',flat,iso()).allow,false);
  assert.deepEqual(monthlyMarketFilter('DOMESTIC',{...s,bars:[...s.bars,{date:'20261130',rawClose:1e9,adjustedClose:1e9}]},iso()),v);
 });
 await test('missing exact month end, wrong symbol, stale or future snapshot never silently substitute',()=>{
  const s=snapshot(),last=s.bars.at(-1);
  assert.equal(monthlyMarketFilter('DOMESTIC',{...s,bars:[...s.bars.slice(0,-1),{...last,date:'20261029'}]},iso()).known,false);
  assert.equal(monthlyMarketFilter('DOMESTIC',{...s,symbol:'OTHER'},iso()).known,false);
  assert.equal(monthlyMarketFilter('DOMESTIC',{...s,fetchedAt:new realDate(now+1).toISOString()},iso()).known,false);
  assert.equal(monthlyMarketFilter('DOMESTIC',{...s,fetchedAt:new realDate(now-37*3600000).toISOString()},iso()).known,false);
  assert.equal(monthlyMarketFilter('DOMESTIC',{...s,bars:[...s.bars,s.bars[0]]},iso()).known,false);
  assert.equal(monthlyMarketFilter('DOMESTIC',s,'2027-03-01T01:00:00Z').known,false);
 });
 await test('US November month end is November 30, not the November 27 early close',()=>{
  const s=snapshot('US_NASDAQ');s.fetchedAt='2026-12-01T15:00:00Z';
  s.bars.push({date:'20261127',rawClose:100,adjustedClose:100});
  assert.equal(monthlyMarketFilter('US_NASDAQ',s,s.fetchedAt).known,false);
  s.bars.push({date:'20261130',rawClose:101,adjustedClose:101});
  const v=monthlyMarketFilter('US_NASDAQ',s,s.fetchedAt);assert.equal(v.known,true);assert.equal(v.monthEnds.at(-1),'20261130');
 });
 await test('strict feed parser requires adjusted and raw prices plus exact reference symbol',()=>{
  const body={chart:{result:[{meta:{symbol:'069500.KS'},timestamp:[Date.parse('2026-10-30T00:00:00Z')/1000],indicators:{quote:[{close:[100]}],adjclose:[{adjclose:[99]}]}}]}};
  assert.equal(parseBenchmarkResponse(body,'DOMESTIC',iso()).bars[0].adjustedClose,99);
  delete body.chart.result[0].indicators.adjclose;assert.throws(()=>parseBenchmarkResponse(body,'DOMESTIC',iso()));
 });
 await test('same inputs and allowed filter create identical independent A/B fills only on later observations',()=>{
  now=now0;const state=emptyComparison(iso()),s=snapshot();
  advanceComparison(state,observation(),s);assert.equal(state.base.fills,0);assert.ok(state.base.pending['DOMESTIC:005930']);
  const count=state.counts.observations;assert.equal(advanceComparison(state,observation(),s),null);assert.equal(state.counts.observations,count);
  now+=60000;advanceComparison(state,observation(),s);assert.equal(state.base.fills,1);assert.deepEqual(state.base,state.filtered);
  assert.equal(state.excursions.length,2);assert.ok(state.base.cashKrw<30e6);
 });
 await test('blocked filter changes only B entries; risk exit survives missing news/reference and excursions survive closing',()=>{
  now=now0;const state=emptyComparison(iso()),s=snapshot('DOMESTIC',false);
  advanceComparison(state,observation(),s);assert.ok(state.base.pending['DOMESTIC:005930']);assert.equal(state.filtered.pending['DOMESTIC:005930'],undefined);
  now+=60000;advanceComparison(state,observation(),s);assert.equal(state.base.fills,1);assert.equal(state.filtered.fills,0);
  now+=60000;advanceComparison(state,observation(101),s);
  now+=60000;advanceComparison(state,observation(90,false),null);assert.equal(state.base.pending['DOMESTIC:005930'].side,'SELL');
  now+=60000;advanceComparison(state,observation(90,false),null);assert.equal(state.base.closedLots,1);
  const e=state.excursions[0];assert.ok(e.closedAt);assert.ok(e.maePct< -9);assert.ok(e.mfePct>0);
 });
 await test('missing benchmark warms up both books, not just B',()=>{
  now=now0;const state=emptyComparison(iso());advanceComparison(state,observation(),null);
  assert.equal(state.eligibleSince,null);assert.equal(Object.keys(state.base.pending).length,0);assert.equal(Object.keys(state.filtered.pending).length,0);
 });
 await test('passive benchmark uses later quote, whole shares, fees, no repeated buy',()=>{
  now=now0;const state=emptyComparison(iso());state.eligibleSince=iso();
  advancePassive(state,'DOMESTIC',100,iso());assert.equal(state.passive.DOMESTIC.quantity,0);
  now+=60000;advancePassive(state,'DOMESTIC',100,iso());assert.ok(state.passive.DOMESTIC.quantity>0);assert.ok(state.passive.DOMESTIC.feesKrw>0);
  const quantity=state.passive.DOMESTIC.quantity;now+=60000;advancePassive(state,'DOMESTIC',110,iso());assert.equal(state.passive.DOMESTIC.quantity,quantity);
 });
 await test('closed market carries a near-close mark, never an arbitrary stale one',()=>{
  const at=Date.parse('2026-11-02T22:00:00Z'); // both closed after US close
  assert.equal(shadowMarkStale('DOMESTIC:005930',{at:'2026-11-02T06:25:00Z'},at,true),false);
  assert.equal(shadowMarkStale('DOMESTIC:005930',{at:'2026-11-02T03:00:00Z'},at,true),true);
  assert.equal(shadowMarkStale('US_NASDAQ:TEST',{at:'2026-11-02T20:55:00Z'},at,true),false);
 });
 await test('collector only queries prices/news; stop prevents further recording; persistence corruption is not reset',async()=>{
  now=now0;global.Date=class extends realDate{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kis-compare-'));process.env.DATA_DIR=dir;
  Object.assign(process.env,{KIS_APP_KEY:'test-only',KIS_APP_SECRET:'test-only',KIS_ACCOUNT_NO:'00000000',KIS_ACCOUNT_PRODUCT_CODE:'01',
    KIS_BASE_URL:'https://openapivts.koreainvestment.com:29443',TRADING_MODE:'DEMO',ORDER_EXECUTION_MODE:'VTS_MOCK',ALLOW_REAL_DOMESTIC_ORDER:'false',ALLOW_REAL_OVERSEAS_ORDER:'false',KIS_ALLOW_REAL_FALLBACK:'false'});
  const previousFetch=global.fetch,previousGlobal=global.__marketComparison;
  delete global.__marketComparison;
  try{
   const l=createLoader(),news=l('src/lib/news-research.ts'),kis=l('src/lib/kis-vts-client.ts');
   const target=observation().target;
   news.refreshResearchNews=async()=>{};
   news.researchView=()=>({articles:[],feeds:[{id:'DOMESTIC:005930',label:'fixture',lastAttemptAt:iso(),lastSuccessAt:iso(),error:null,count:0}]});
   const rows=Object.keys(MARKET_CALENDAR.markets.DOMESTIC).filter(d=>d<'20261102').sort().slice(-65);
   kis.KisVtsClient.prototype.getPrice=async()=>100;
   kis.KisVtsClient.prototype.getDailyBars=async()=>rows.map((date,i)=>({date,close:93.6+i/10}));
   kis.KisVtsClient.prototype.submitMockOrder=async()=>{throw Error('ORDER_TRANSPORT_FORBIDDEN');};
   const s=snapshot(),raw=s.bars.map(b=>b.rawClose),adj=s.bars.map(b=>b.adjustedClose);
   global.fetch=async(url)=>{assert.match(String(url),/^https:\/\/query1\.finance\.yahoo\.com\/v8\/finance\/chart\//);return Response.json({chart:{result:[{meta:{symbol:'069500.KS'},timestamp:s.bars.map(b=>Date.parse(`${b.date.slice(0,4)}-${b.date.slice(4,6)}-${b.date.slice(6,8)}T00:00:00Z`)/1000),indicators:{quote:[{close:raw}],adjclose:[{adjclose:adj}]}}]}});};
   const service=l('src/lib/market-comparison.ts');service.startMarketComparison([target]);
   for(let i=0;i<100&&service.marketComparisonView().cycleRunning;i++)await new Promise(r=>setImmediate(r));
   const view=service.marketComparisonView();assert.equal(view.lastError,null);assert.equal(view.counts.observations,1);assert.equal(view.isCollecting,true);assert.ok(fs.existsSync(path.join(dir,'market-comparison-v1.json')));
   service.stopMarketComparison();assert.equal(service.marketComparisonView().isCollecting,false);
   const route=l('src/app/api/strategy-comparison/route.ts');
   const refused=await route.POST(new Request('http://localhost:3939/api/strategy-comparison',{method:'POST',headers:{origin:'https://example.com',host:'localhost:3939','content-type':'application/json'},body:JSON.stringify({action:'start'})}));
   assert.equal(refused.status,403);assert.equal(service.marketComparisonView().isCollecting,false);
   assert.equal(fs.existsSync(path.join(dir,'state.json')),false,'read-only collector must not create broker runtime state');
   fs.writeFileSync(path.join(dir,'market-comparison-v1.json'),'{broken');delete global.__marketComparison;
   assert.throws(()=>createLoader()('src/lib/market-comparison.ts').marketComparisonView(),/COMPARISON_HISTORY_UNREADABLE/);
  }finally{
   if(global.__marketComparisonTimer) clearInterval(global.__marketComparisonTimer);
   delete global.__marketComparisonTimer;delete global.__marketComparisonJob;delete global.__benchmarkSnapshots;
   global.__marketComparisonEnabled=false;global.__marketComparison=previousGlobal;global.fetch=previousFetch;global.Date=realDate;
   fs.rmSync(dir,{recursive:true,force:true});
  }
 });
 console.log(JSON.stringify({passed,externalOrders:0}));
})().catch(e=>{console.error(e);process.exitCode=1;});
