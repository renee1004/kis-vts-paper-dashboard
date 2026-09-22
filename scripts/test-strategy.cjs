const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLoader } = require('./lib/load-source.cjs');
const RealDate = Date;
let now = RealDate.parse('2026-09-11T01:00:00Z');
global.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } };
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kis-strategy-test-'));
process.env.DATA_DIR = testDir;
process.env.KIS_APP_KEY = 'test-key-not-real';
process.env.KIS_APP_SECRET = 'test-secret-not-real';
process.env.KIS_ACCOUNT_NO = '00000000';
process.env.KIS_ACCOUNT_PRODUCT_CODE = '01';
process.env.KIS_BASE_URL = 'https://openapivts.koreainvestment.com:29443';
process.env.TRADING_MODE = 'DEMO';
process.env.ORDER_EXECUTION_MODE = 'VTS_MOCK';
process.env.ALLOW_REAL_DOMESTIC_ORDER = 'false';
process.env.ALLOW_REAL_OVERSEAS_ORDER = 'false';
process.env.KIS_ALLOW_REAL_FALLBACK = 'false';
delete global.__vtsPaperState;
let checks = 0;
const check = (name, run) => { run(); checks++; console.log('PASS', name); };
const load = createLoader();
const { completedBars, analyzeTrend, exitDecision, sizeForRisk } = load('src/lib/strategy.ts');
const { ownedLot, sellableQuantity } = load('src/lib/ownership.ts');
const { DEFAULT_SAFETY_SETTINGS, buyNotionalKrw } = load('src/lib/domain.ts');
const store = load('src/lib/store.ts');
const { state } = store;
const execution = load('src/lib/vts-execution.ts');
const bars = Array.from({ length: 80 }, (_, i) => ({ date: new RealDate(RealDate.UTC(2026, 0, i + 1)).toISOString().slice(0, 10).replaceAll('-', ''), close: 100 + i * .1 }));
check('unclosed/future bars excluded, sorting and deduplication', () => {
  assert.deepEqual(completedBars([{date:'20260102',close:2},{date:'20260101',close:1},{date:'20260103',close:999},{date:'20260101',close:1}], '20260103').map(b=>b.close), [1,2]);
});
check('insufficient history does not trade', () => assert.equal(analyzeTrend(bars.slice(0, 64)).side, 'HOLD'));
check('rising breakout qualifies; score is deterministic conditions', () => assert.equal(analyzeTrend(bars).side, 'BUY'));
check('overextended jump does not qualify', () => assert.notEqual(analyzeTrend([...bars.slice(0,-1),{...bars.at(-1),close:300}]).side, 'BUY'));
check('downtrend produces exit', () => assert.equal(analyzeTrend(bars.map((b,i)=>({...b,close:200-i}))).side, 'SELL'));
check('partial take profit fires once', () => {
  assert.equal(exitDecision({quantity:10,averagePrice:100,currentPrice:111,stopFraction:.05,partialTaken:false}).quantity,5);
  assert.equal(exitDecision({quantity:5,averagePrice:100,currentPrice:111,stopFraction:.05,partialTaken:true}),null);
});
check('loss and full profit exits still work after partial', () => {
  assert.equal(exitDecision({quantity:5,averagePrice:100,currentPrice:90,stopFraction:.05,partialTaken:true}).quantity,5);
  assert.equal(exitDecision({quantity:5,averagePrice:100,currentPrice:121,stopFraction:.05,partialTaken:true}).quantity,5);
  assert.equal(exitDecision({quantity:5,averagePrice:100,currentPrice:120,stopFraction:.05,partialTaken:true}).quantity,5);
});
check('risk sizing enforces exact notional and daily caps', () => {
  assert.equal(sizeForRisk({budget:3e6,price:400000,stopFraction:.05,committed:0,dailyRemaining:3e6}),0);
  assert.equal(sizeForRisk({budget:3e6,price:100000,stopFraction:.05,committed:0,dailyRemaining:150000}),1);
  assert.equal(sizeForRisk({budget:3e6,price:100000,stopFraction:.05,committed:1.5e6,dailyRemaining:3e6}),0);
});
function order(overrides = {}) { return {id:'buy-1',timestamp:'2026-09-10T01:00:00Z',orderDate:'20260910',market:'DOMESTIC',currency:'KRW',exchange:'KRX',stockCode:'005930',stockName:'test',side:'BUY',quantity:10,filledQuantity:10,referencePrice:100,averageFillPrice:100,status:'FILLED',kisOrderNo:'1',kisBranchNo:'1',ownershipScope:'AGENT_CREATED_ONLY',stopFraction:.05,...overrides}; }
check('external holdings never enlarge owned sell quantity', () => assert.equal(sellableQuantity([order()], 'DOMESTIC','005930',100),10));
check('pending sell reserves its unfilled shares', () => assert.equal(sellableQuantity([order(),order({id:'sell',side:'SELL',status:'PARTIALLY_FILLED',quantity:5,filledQuantity:2,timestamp:'2026-09-11T00:00:00Z'})], 'DOMESTIC','005930',98),5));
check('partial marker survives rebuild and resets after flat/new lot', () => {
  const history = [order(),order({id:'sell',side:'SELL',quantity:5,filledQuantity:5,exitReason:'TAKE_PROFIT_10',timestamp:'2026-09-10T02:00:00Z'})];
  assert.equal(ownedLot(history,'DOMESTIC','005930').partialTaken,true);
  history.push(order({id:'flat',side:'SELL',quantity:5,filledQuantity:5,timestamp:'2026-09-10T03:00:00Z'}),order({id:'new',timestamp:'2026-09-11T00:00:00Z'}));
  assert.equal(ownedLot(history,'DOMESTIC','005930').partialTaken,false);
});
check('expired partial fills count toward buy budget', () => assert.equal(buyNotionalKrw(order({status:'EXPIRED',filledQuantity:3})),300));
function reset() {
  state.isRunning = true; state.prepared = true;
  state.settings = {...DEFAULT_SAFETY_SETTINGS,killSwitchEnabled:false,autoDomesticOrderEnabled:true,autoOverseasOrderEnabled:true,autoExitEnabled:true,pipelineTestEnabled:true,allowStrategyTestOrder:true};
  state.vtsOrders=[];state.agentOwnedPositions=[];state.positions=[];state.overseasPositions=[];
  state.balanceSnapshot={cash:3e6,totalEvaluation:3e6,syncedAt:new Date().toISOString()};
  state.overseasBalanceSnapshot={syncedAt:new Date().toISOString()};
  state.strategyRisk={date:'',startPnl:0};
}
const input = {market:'DOMESTIC',stockCode:'005930',stockName:'test',side:'BUY',confidence:100,price:100000,signalId:'test',signalDate:'20260910',stopFraction:.05};
let submitted = [];
const client = {submitMockOrder:async (request)=>{submitted.push(request);return {orderNo:'test-order',branchNo:'1'};},submitOverseasMockOrder:async()=>{throw Error('Unexpected overseas order');},getTodayExecutions:async()=>[],getOverseasTodayExecutions:async()=>[]};
async function test(name, run) { await run(); checks++; console.log('PASS',name); }
(async()=>{
  await test('SAFE_LOCKED blocks all risk exits',async()=>{reset();state.settings.killSwitchEnabled=true;state.vtsOrders=[order()];state.positions=[{market:'DOMESTIC',stockCode:'005930',stockName:'test',quantity:100,currentPrice:80}];submitted=[];await execution.enforceRiskExits(client);assert.equal(submitted.length,0);});
  await test('autoExit disabled blocks exits',async()=>{reset();state.settings.autoExitEnabled=false;state.vtsOrders=[order()];state.positions=[{market:'DOMESTIC',stockCode:'005930',stockName:'test',quantity:100,currentPrice:80}];submitted=[];await execution.enforceRiskExits(client);assert.equal(submitted.length,0);});
  await test('risk exit submits only agent shares, not all broker holdings',async()=>{reset();state.vtsOrders=[order()];state.positions=[{market:'DOMESTIC',stockCode:'005930',stockName:'test',quantity:100,currentPrice:80}];submitted=[];await execution.enforceRiskExits(client);assert.equal(submitted.length,1);assert.equal(submitted[0].quantity,10);});
  await test('buy order is durably reserved before transport',async()=>{reset();const fake={...client,submitMockOrder:async()=>{assert.equal(state.vtsOrders[0].status,'UNKNOWN');assert.equal(JSON.parse(fs.readFileSync(path.join(testDir,'state.json'))).vtsOrders[0].status,'UNKNOWN');return {orderNo:'2',branchNo:'1'};}};assert.equal((await execution.executeVtsMockOrder(fake,input)).status,'SUBMITTED');});
  await test('network uncertainty prevents all new buys and retry',async()=>{reset();const fake={...client,submitMockOrder:async()=>{throw Error('timeout');}};assert.equal((await execution.executeVtsMockOrder(fake,input)).status,'UNKNOWN');submitted=[];await execution.executeVtsMockOrder(client,{...input,stockCode:'000660'});assert.equal(submitted.length,0);});
  await test('same signal cannot be bought twice even after rejection',async()=>{reset();state.vtsOrders=[order({status:'REJECTED',filledQuantity:0,signalDate:'20260910'})];submitted=[];await execution.executeVtsMockOrder(client,input);assert.equal(submitted.length,0);});
  await test('stale balance prevents buys',async()=>{reset();state.balanceSnapshot.syncedAt='2026-09-10T00:00:00Z';submitted=[];await execution.executeVtsMockOrder(client,input);assert.equal(submitted.length,0);});
  await test('previous-day partial fills are reconciled before expiry',async()=>{reset();state.vtsOrders=[order({status:'SUBMITTED',filledQuantity:0})];let queried;const fake={...client,getTodayExecutions:async(date)=>{queried=date;return [{orderDate:date,orderNo:'1',branchNo:'1',stockCode:'005930',filledQuantity:3,averageFillPrice:101}];}};await execution.reconcileAgentOwnedFills(fake);assert.equal(queried,'20260910');assert.equal(state.vtsOrders[0].status,'EXPIRED');assert.equal(state.agentOwnedPositions[0].quantity,3);});
  await test('more than 500 accepted orders survive new writes',async()=>{reset();state.vtsOrders=Array.from({length:510},(_,i)=>order({id:String(i),status:'REJECTED',filledQuantity:0}));await execution.executeVtsMockOrder(client,{...input,confidence:0});assert.equal(state.vtsOrders.filter(o=>o.status==='REJECTED').length,510);});
  await test('historical sells without owned buys cannot create fake strategy profit',async()=>{reset();state.vtsOrders=[order({side:'SELL'})];assert.equal(execution.strategyValuation().valid,false);});
  await test('transport rechecks stop after asynchronous token acquisition',async()=>{
    reset();const oldFetch=global.fetch;let orderCalls=0;
    global.fetch=async(url)=>{if(String(url).includes('oauth2')){state.isRunning=false;return Response.json({access_token:'test-only',expires_in:3600});}orderCalls++;throw Error('Must not send order');};
    try{const {KisVtsClient,clearTokenCache}=load('src/lib/kis-vts-client.ts');clearTokenCache();await assert.rejects(()=>new KisVtsClient().submitMockOrder({stockCode:'005930',side:'SELL',quantity:1}),/ORDER_GATE_CLOSED/);assert.equal(orderCalls,0);}finally{global.fetch=oldFetch;}
  });
  await test('daily risk baseline persists across restart; restart locks trading',async()=>{reset();state.strategyRisk={date:'20260911',startPnl:-123};store.saveState();delete global.__vtsPaperState;const restarted=createLoader()('src/lib/store.ts');assert.equal(restarted.state.strategyRisk.startPnl,-123);assert.equal(restarted.state.settings.killSwitchEnabled,true);assert.equal(restarted.state.settings.autoExitEnabled,false);assert.equal(restarted.state.isRunning,false);});
  await test('corrupt state fails closed instead of silently resetting trade history',async()=>{fs.writeFileSync(path.join(testDir,'state.json'),'{broken');delete global.__vtsPaperState;assert.throws(()=>createLoader()('src/lib/store.ts'),/STATE_FILE_UNREADABLE/);});
  console.log(JSON.stringify({passed:checks,externalOrders:0}));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{global.Date=RealDate;});
