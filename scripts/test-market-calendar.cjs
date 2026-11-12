const assert = require('node:assert/strict');
const {createLoader} = require('./lib/load-source.cjs');
const load=createLoader();
const {marketSession}=load('src/lib/market-calendar.ts');
const {isDomesticRegularMarketOpen,isUsRegularMarketOpen,usRegularHoursDescriptionKo,usMarketStatusLabel}=load('src/lib/market-hours.ts');
let passed=0;
function check(name,fn){fn();passed++;console.log('PASS',name);}
check('Hangul Day rejects the historical repeated-order session',()=>assert.equal(isDomesticRegularMarketOpen(new Date('2026-10-09T01:00:00Z')),false));
check('2026-11-09 Monday is a regular KRX session; isOpen follows 09:00-15:30 KST',()=>{
 assert.equal(isDomesticRegularMarketOpen(new Date('2026-11-09T01:00:00Z')),true);
 assert.equal(isDomesticRegularMarketOpen(new Date('2026-11-09T07:40:00Z')),false);
 assert.equal(marketSession('DOMESTIC',new Date('2026-11-09T01:00:00Z')).known,true);
});
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
check('2027 New Year is closed and the first KRX session is the delayed 10:00 open',()=>{
 assert.equal(isDomesticRegularMarketOpen(new Date('2027-01-01T01:00:00Z')),false);
 assert.equal(marketSession('DOMESTIC',new Date('2027-01-01T01:00:00Z')).known,true);
 assert.equal(isDomesticRegularMarketOpen(new Date('2027-01-04T00:30:00Z')),false);
 assert.equal(isDomesticRegularMarketOpen(new Date('2027-01-04T01:00:00Z')),true);
});
check('2027 Seollal and Chuseok weekday closures follow XKRX lunar dates',()=>{
 for(const date of ['02-08','02-09']) assert.equal(isDomesticRegularMarketOpen(new Date(`2027-${date}T01:00:00Z`)),false,date);
 assert.equal(isDomesticRegularMarketOpen(new Date('2027-02-05T01:00:00Z')),true);
 for(const date of ['09-14','09-15','09-16']) assert.equal(isDomesticRegularMarketOpen(new Date(`2027-${date}T01:00:00Z`)),false,date);
 // Pinned XKRX 4.13.2 does not close 2027-07-19 (제헌절 Saturday; no substitute in 4.13.2).
 assert.equal(isDomesticRegularMarketOpen(new Date('2027-07-19T01:00:00Z')),true);
});
check('2027 US holidays include weekend-observed Independence Day and only Black Friday is an early close',()=>{
 for(const date of ['01-01','01-18','02-15','03-26','05-31','06-18','07-05','09-06','11-25','12-24'])
  assert.equal(isUsRegularMarketOpen(new Date(`2027-${date}T16:00:00Z`)),false,date);
 assert.equal(isUsRegularMarketOpen(new Date('2027-07-02T13:30:00Z')),true);
 const s=marketSession('US_NASDAQ',new Date('2027-11-26T17:59:59Z'));
 assert.equal(s.isOpen,true);assert.equal(s.earlyClose,true);
 assert.equal(Date.parse(s.closeAt),Date.parse('2027-11-26T18:00:00Z'));
 assert.equal(isUsRegularMarketOpen(new Date('2027-11-26T18:00:00Z')),false);
});
check('unknown years and invalid dates never fall back to weekday open',()=>{
 assert.equal(marketSession('DOMESTIC',new Date('2026-11-19T01:00:00Z')).known,false);
 assert.equal(marketSession('DOMESTIC',new Date('2028-01-04T01:00:00Z')).known,false);
 assert.equal(isDomesticRegularMarketOpen(new Date('2028-01-04T01:00:00Z')),false);
 assert.equal(usMarketStatusLabel(new Date('2028-01-04T16:00:00Z')),'UNKNOWN');
 assert.equal(marketSession('US_NASDAQ',new Date(NaN)).isOpen,false);
});
console.log(JSON.stringify({passed,externalOrders:0}));
