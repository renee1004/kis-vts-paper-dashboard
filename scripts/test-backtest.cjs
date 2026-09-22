const assert=require('node:assert/strict');
const {backtest}=require('./backtest.cjs');
const bars=Array.from({length:220},(_,i)=>({date:new Date(Date.UTC(2020,0,i+1)).toISOString().slice(0,10).replaceAll('-',''),open:100+i*.2,close:100+i*.2}));
const source={TEST:{fx:1,bars}};
const options={start:bars[65].date,end:bars.at(-1).date};
const normal=backtest(source,options);
const changed=structuredClone(source);
for(let i=150;i<bars.length;i++){changed.TEST.bars[i].open*=2;changed.TEST.bars[i].close*=2;}
const other=backtest(changed,options);
assert.deepEqual(normal.curve.filter(r=>r.date<bars[150].date),other.curve.filter(r=>r.date<bars[150].date));
const highCosts=backtest(source,{...options,costBps:100,slippageBps:100});
assert.ok(highCosts.netReturnPct<normal.netReturnPct);
assert.ok(normal.feesKrw>0);
assert.ok(normal.curve.every(r=>Number.isFinite(r.nav)&&r.nav>0));
console.log('Backtest mechanics: 4 checks passed (future-data isolation, costs, fees, finite NAV).');
