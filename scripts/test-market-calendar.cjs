const assert = require('node:assert/strict');
const {createLoader} = require('./lib/load-source.cjs');
const load=createLoader();
const {marketSession}=load('src/lib/market-calendar.ts');
const {isDomesticRegularMarketOpen,isUsRegularMarketOpen,usRegularHoursDescriptionKo,usMarketStatusLabel}=load('src/lib/market-hours.ts');
let passed=0;
function check(name,fn){fn();passed++;console.log('PASS',name);}
check('Hangul Day rejects the historical repeated-order session',()=>assert.equal(isDomesticRegularMarketOpen(new Date('2026-10-09T01:00:00Z')),false));
check('KRX closures missing from pinned upstream are corrected',()=>{
 for(const date of ['06-03','07-17']) assert.equal(isDomesticRegularMarketOpen(new Date(`2026-${date}T01:00:00Z`)),false);
 assert.equal(isDomesticRegularMarketOpen(new Date('2026-01-02T00:30:00Z')),false);
 assert.equal(isDomesticRegularMarketOpen(new Date('2026-01-02T01:00:00Z')),true);
});
check('normal KRX open inclusive and close exclusive',()=>{
 assert.equal(isDomesticRegularMarketOpen(new Date('2026-10-28T00:00:00Z')),true);
 assert.equal(isDomesticRegularMarketOpen(new Date('2026-10-28T06:29:59Z')),true);
 assert.equal(isDomesticRegularMarketOpen(new Date('2026-10-28T06:30:00Z')),false);
});
// Nasdaq official 2026 schedule, independently compared with the XNYS proxy.
check('all Nasdaq published 2026 holidays are closed',()=>{
 for(const date of ['01-01','01-19','02-16','04-03','05-25','06-19','07-03','09-07','11-26','12-25'])
  assert.equal(isUsRegularMarketOpen(new Date(`2026-${date}T16:00:00Z`)),false,date);
});
check('Nasdaq published early closes end at 13 ET, not 16 ET',()=>{
 for(const date of ['11-27','12-24']){
  const s=marketSession('US_NASDAQ',new Date(`2026-${date}T17:59:59Z`));
  assert.equal(s.isOpen,true);assert.equal(s.earlyClose,true);
  assert.equal(Date.parse(s.closeAt),Date.parse(`2026-${date}T18:00:00Z`));
  assert.equal(isUsRegularMarketOpen(new Date(`2026-${date}T18:00:00Z`)),false);
 }
 assert.match(usRegularHoursDescriptionKo(new Date('2026-11-27T17:00:00Z')),/조기 폐장/);
});
check('US DST and Korea next-day local date stay aligned',()=>{
 assert.equal(isUsRegularMarketOpen(new Date('2026-01-05T14:30:00Z')),true);
 assert.equal(isUsRegularMarketOpen(new Date('2026-07-06T13:30:00Z')),true);
 assert.equal(marketSession('US_NASDAQ',new Date('2026-10-28T00:00:00Z')).date,'20261027');
});
check('unknown years and invalid dates never fall back to weekday open',()=>{
 assert.equal(marketSession('DOMESTIC',new Date('2026-11-19T01:00:00Z')).known,false);
 assert.equal(marketSession('DOMESTIC',new Date('2027-01-04T01:00:00Z')).known,false);
 assert.equal(isDomesticRegularMarketOpen(new Date('2027-01-04T01:00:00Z')),false);
 assert.equal(usMarketStatusLabel(new Date('2027-01-04T16:00:00Z')),'UNKNOWN');
 assert.equal(marketSession('US_NASDAQ',new Date(NaN)).isOpen,false);
});
console.log(JSON.stringify({passed,externalOrders:0}));
