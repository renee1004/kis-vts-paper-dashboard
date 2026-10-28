const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {createLoader} = require('./lib/load-source.cjs');
const RealDate = Date, realFetch = global.fetch;
let now = Date.parse('2026-10-28T01:00:00Z'), calls = 0, passed = 0;
global.Date = class extends RealDate { constructor(...args){super(...(args.length?args:[now]));} static now(){return now;} };
global.fetch = async () => { throw Error('NETWORK_FORBIDDEN_IN_TEST'); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(),'kis-review-'));
Object.assign(process.env,{DATA_DIR:dir,KIS_APP_KEY:'test-only',KIS_APP_SECRET:'test-only',KIS_ACCOUNT_NO:'00000000',KIS_ACCOUNT_PRODUCT_CODE:'01'});
const load=createLoader(), {state,saveState}=load('src/lib/store.ts');
const {KisVtsClient,KisOrderRejectedError}=load('src/lib/kis-vts-client.ts');
const {executeVtsMockOrder,enforceRiskExits}=load('src/lib/vts-execution.ts');
const {recordPerformance,sevenDayPerformance}=load('src/lib/performance-history.ts');
const {rejectionBlock}=load('src/lib/order-retry.ts');
const check=async(name,fn)=>{await fn();passed++;console.log('PASS',name);};
const diagnostic={phase:'vtsOrder',stockCode:'005930',endpointPath:'/order',trId:'VTTC0801U',server:'vts',httpStatus:200,rt_cd:'1',msg_cd:'CLOSED',msg1:'Market closed',probableCauses:[],timestamp:new Date().toISOString()};
const input={market:'DOMESTIC',stockCode:'005930',stockName:'Test',side:'SELL',confidence:100,price:90,signalId:'exit-test'};
function reset(){
 state.isRunning=true;state.prepared=true;
 Object.assign(state.settings,{killSwitchEnabled:false,pipelineTestEnabled:true,allowStrategyTestOrder:true,autoDomesticOrderEnabled:true,autoExitEnabled:true});
 state.positions=[{stockCode:'005930',market:'DOMESTIC',quantity:10,currentPrice:90}];
 state.overseasPositions=[];state.stopOverrides=[];
 state.balanceSnapshot={syncedAt:new Date().toISOString()};
 state.vtsOrders=[{id:'original-buy',timestamp:'2026-10-20T01:00:00Z',orderDate:'20261020',market:'DOMESTIC',stockCode:'005930',stockName:'Test',side:'BUY',quantity:10,filledQuantity:10,referencePrice:100,averageFillPrice:100,status:'FILLED',kisOrderNo:'1',ownershipScope:'AGENT_CREATED_ONLY',stopFraction:.05}];
}
const client={submitMockOrder:async()=>{calls++;throw new KisOrderRejectedError({...diagnostic});}};
(async()=>{
 await check('broker rejection stays on order when later successful calls clear lastError',async()=>{
  reset();const order=await executeVtsMockOrder(client,input);assert.equal(order.status,'REJECTED');
  state.lastError=null;assert.equal(order.brokerError.msg_cd,'CLOSED');saveState();
  const saved=JSON.parse(fs.readFileSync(path.join(dir,'state.json'),'utf8'));
  assert.equal(saved.vtsOrders[0].brokerError.msg_cd,'CLOSED');
 });
 await check('200 repeated analysis requests make no duplicate transport during cooldown',async()=>{
  const before=calls;for(let i=0;i<200;i++)assert.equal((await executeVtsMockOrder(client,input)).blockedReason,'BROKER_REJECTION_COOLDOWN');assert.equal(calls,before);
 });
 await check('risk-exit path cannot bypass rejection cooldown',async()=>{const before=calls;await enforceRiskExits(client);assert.equal(calls,before);});
 await check('only three confirmed refusals per symbol/side/market date',async()=>{
  for(let i=0;i<2;i++){now+=15*60_000;state.balanceSnapshot.syncedAt=new Date().toISOString();await executeVtsMockOrder(client,input);}
  assert.equal(calls,3);now+=15*60_000;state.balanceSnapshot.syncedAt=new Date().toISOString();
  assert.equal((await executeVtsMockOrder(client,input)).blockedReason,'BROKER_REJECTION_REVIEW_REQUIRED');assert.equal(calls,3);
  assert.ok(state.logs.some(l=>l.message.includes('증권사 거절 3회')));
 });
 await check('restart restores rejection evidence and resets order activation',()=>{
  saveState();delete global.__vtsPaperState;const reloaded=createLoader()('src/lib/store.ts').state;
  assert.equal(rejectionBlock(reloaded.vtsOrders,input,'20261028',now),'BROKER_REJECTION_REVIEW_REQUIRED');
  assert.equal(reloaded.settings.killSwitchEnabled,true);assert.equal(reloaded.settings.allowRealDomesticOrder,false);
 });
 await check('next date and other symbols are not blocked by previous day refusals',()=>{
  assert.equal(rejectionBlock(state.vtsOrders,input,'20261029',now),null);
  assert.equal(rejectionBlock(state.vtsOrders,{...input,stockCode:'OTHER'},'20261028',now),null);
 });
 await check('ambiguous transport result remains UNKNOWN and cannot be retried',async()=>{
  reset();let sent=0;const uncertain={submitMockOrder:async()=>{sent++;throw Error('TIMEOUT');}};
  assert.equal((await executeVtsMockOrder(uncertain,input)).status,'UNKNOWN');
  await executeVtsMockOrder(uncertain,input);assert.equal(sent,1);
 });
 await check('USD holdings override incompatible broker summary totals',async()=>{
  const api=new KisVtsClient();api.get=async()=>({output1:[{ovrs_pdno:'AAPL',ovrs_cblc_qty:'2',pchs_avg_pric:'100',now_pric2:'110',ovrs_stck_evlu_amt:'220',frcr_pchs_amt1:'200',frcr_evlu_pfls_amt:'20'}],output2:{frcr_buy_amt_smtl1:99999999,tot_evlu_pfls_amt:8888888}});
  const b=await api.getOverseasBalance();assert.equal(b.purchaseAmountUsd,200);assert.equal(b.profitLossUsd,20);assert.equal(b.stockEvaluationUsd,220);assert.equal(b.cashUsd,null);
 });
 await check('no seven-day baseline returns unavailable rather than zero return',()=>{
  const point={at:new Date().toISOString(),pnlKrw:10,budgetKrw:1000,strategyVersion:'v2'};
  assert.equal(sevenDayPerformance([point],point).returnPct,null);
  assert.equal(sevenDayPerformance([],null).status,'INSUFFICIENT_DATA');
 });
 await check('weekly return and sampled drawdown include mark changes with no fills',()=>{
  const end=now, history=Array.from({length:169},(_,i)=>({at:new RealDate(end-(168-i)*3600_000).toISOString(),pnlKrw:i===80?-100:i===168?50:0,budgetKrw:1000,strategyVersion:'v2'}));
  const result=sevenDayPerformance(history,history.at(-1));assert.equal(result.pnlKrw,50);assert.equal(result.returnPct,5);assert.equal(result.sampledMaxDrawdownPct,10);
  assert.equal(sevenDayPerformance(history.filter((_,i)=>i<10||i>20),history.at(-1)).status,'INSUFFICIENT_DATA');
  assert.equal(sevenDayPerformance(history,{...history.at(-1),strategyVersion:'v3'}).returnPct,null);
 });
 await check('hourly history preserves first baseline and rejects nonfinite observations',()=>{
  const p={at:new Date().toISOString(),pnlKrw:0,budgetKrw:1000,strategyVersion:'v2'};
  const h=recordPerformance([],p);assert.equal(recordPerformance(h,{...p,at:new RealDate(now+60000).toISOString()}).length,1);
  assert.equal(recordPerformance(h,{...p,pnlKrw:NaN}).length,1);
 });
 console.log(JSON.stringify({passed,externalOrders:0}));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{global.Date=RealDate;global.fetch=realFetch;fs.rmSync(dir,{recursive:true,force:true});});
