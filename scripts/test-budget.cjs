const assert=require('node:assert/strict'), fs=require('node:fs'), os=require('node:os'), path=require('node:path');
const {createLoader}=require('./lib/load-source.cjs');
const realDate=Date, now=Date.parse('2026-09-10T14:00:00Z');
global.Date=class extends realDate { constructor(...args){super(...(args.length?args:[now]));} static now(){return now;} };
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kis-budget-'));
Object.assign(process.env,{DATA_DIR:dir,KIS_APP_KEY:'test-only',KIS_APP_SECRET:'test-only',KIS_ACCOUNT_NO:'00000000',KIS_ACCOUNT_PRODUCT_CODE:'01',KIS_BASE_URL:'https://openapivts.koreainvestment.com:29443',TRADING_MODE:'DEMO',ORDER_EXECUTION_MODE:'VTS_MOCK',ALLOW_REAL_DOMESTIC_ORDER:'false',ALLOW_REAL_OVERSEAS_ORDER:'false',KIS_ALLOW_REAL_FALLBACK:'false'});
const load=createLoader(), limits=load('src/lib/trading-limits.ts');
const {sizeForRisk}=load('src/lib/strategy.ts'),{state}=load('src/lib/store.ts'),{executeVtsMockOrder}=load('src/lib/vts-execution.ts');
const base={budget:30e6,price:4500000,stopFraction:.08,committed:0,dailyRemaining:4500000};
let passed=0;
async function test(name,fn){await fn();passed++;console.log('PASS',name);}
function reset(){state.isRunning=true;state.prepared=true;Object.assign(state.settings,{killSwitchEnabled:false,pipelineTestEnabled:true,allowStrategyTestOrder:true,autoOverseasOrderEnabled:true,autoDomesticOrderEnabled:true,autoExitEnabled:true});state.vtsOrders=[];state.agentOwnedPositions=[];state.positions=[];state.overseasPositions=[];state.strategyRisk={date:'',startPnl:0};state.overseasBalanceSnapshot={syncedAt:new Date().toISOString()};}
const input={market:'US_NASDAQ',stockCode:'TEST',stockName:'Test',side:'BUY',confidence:100,price:3000,signalId:'test',signalDate:'20260909',stopFraction:.08};
let sent=[];
const client={getOverseasBuyingPower:async()=>({amountUsd:20000,quantity:6,checkedAt:Date.now()}),submitOverseasMockOrder:async(r)=>{sent.push(r);return{orderNo:'test-order',branchNo:'1'};}};
(async()=>{
 await test('initial account balance basis is 30M, not newly funded cash',()=>assert.equal(limits.INITIAL_ACCOUNT_BALANCE_KRW,30e6));
 await test('USD3000 one share allowed at every supported stop',()=>{for(const stopFraction of [.03,.05,.08])assert.equal(sizeForRisk({...base,stopFraction},'US_NASDAQ'),1);});
 await test('USD3000.01 and second USD3000 share exceed cap',()=>{assert.equal(sizeForRisk({...base,price:3000.01*1500},'US_NASDAQ'),0);assert.equal(sizeForRisk(base,'US_NASDAQ'),1);});
 await test('domestic 3M order cap',()=>{const d={...base,stopFraction:.03};assert.equal(sizeForRisk({...d,price:3000001},'DOMESTIC'),0);assert.equal(sizeForRisk({...d,price:3000000},'DOMESTIC'),1);assert.equal(sizeForRisk({...d,price:100000},'DOMESTIC'),30);});
 await test('shared daily cap and aggregate exposure still constrain US',()=>{assert.equal(sizeForRisk({...base,dailyRemaining:4499999},'US_NASDAQ'),0);assert.equal(sizeForRisk({...base,committed:15e6},'US_NASDAQ'),0);});
 await test('buying power parser rejects absent currency and incomplete fields',()=>{assert.throws(()=>limits.parseOverseasBuyingPower({}));assert.throws(()=>limits.parseOverseasBuyingPower({tr_crcy_cd:'KRW',ovrs_ord_psbl_amt:'10000',max_ord_psbl_qty:'4'}));assert.deepEqual(limits.parseOverseasBuyingPower({tr_crcy_cd:'USD',ovrs_ord_psbl_amt:'10000',max_ord_psbl_qty:'4',ord_psbl_qty:'2'}),{amountUsd:10000,quantity:2});});
 await test('executor reserves exactly one USD3000 share before fake transport',async()=>{reset();sent=[];const result=await executeVtsMockOrder(client,input);assert.equal(result.status,'SUBMITTED',result.blockedReason);assert.equal(sent[0].quantity,1);assert.equal(sent[0].limitPrice,3000);});
 await test('broker orderable cash shortage blocks even with 30M capital basis',async()=>{reset();sent=[];const result=await executeVtsMockOrder({...client,getOverseasBuyingPower:async()=>({amountUsd:2999,quantity:1,checkedAt:now})},input);assert.equal(sent.length,0);assert.equal(result.blockedReason,'US_ORDERABLE_FUNDS_OR_BUDGET_CAP');});
 await test('failed buying power cannot submit',async()=>{reset();sent=[];await executeVtsMockOrder({...client,getOverseasBuyingPower:async()=>{throw Error('network');}},input);assert.equal(sent.length,0);});
 await test('stop during buying power lookup prevents transport',async()=>{reset();sent=[];await executeVtsMockOrder({...client,getOverseasBuyingPower:async()=>{state.isRunning=false;return{amountUsd:20000,quantity:6,checkedAt:now};}},input);assert.equal(sent.length,0);});
 await test('pending order consumes daily cap before next buy',async()=>{reset();sent=[];await executeVtsMockOrder(client,input);await executeVtsMockOrder(client,{...input,stockCode:'OTHER',signalId:'other'});assert.equal(sent.length,1);});
 await test('old 3M research record is preserved; new experiment starts at 30M',()=>{const old=path.join(dir,'news-research.json');fs.writeFileSync(old,'legacy record must stay');const research=load('src/lib/news-research.ts');const view=research.researchView([]);assert.equal(view.price.cashKrw,30e6);assert.equal(view.news.cashKrw,30e6);assert.equal(fs.readFileSync(old,'utf8'),'legacy record must stay');});
 console.log(JSON.stringify({passed,externalOrders:0}));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{global.Date=realDate;fs.rmSync(dir,{recursive:true,force:true});});
