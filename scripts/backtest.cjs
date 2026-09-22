// Daily-bar research approximation. Not an intraday KIS execution simulator.
const fs = require('node:fs');
const { createLoader } = require('./lib/load-source.cjs');
const { analyzeTrend, exitDecision, sizeForRisk, STRATEGY_VERSION } = createLoader()('src/lib/strategy.ts');

function legacySignal(bars) {
  if (bars.length < 10) return {side:'HOLD',stopFraction:.05};
  const closes=bars.slice(-10).map(b=>b.close);
  const sum=a=>a.reduce((s,v)=>s+v,0);
  const momentum=(sum(closes.slice(5))/sum(closes.slice(0,5))-1)*100;
  return {side:momentum>=1.5 && Math.round(Math.abs(momentum)*20)>=75?'BUY':momentum<=-1.5?'SELL':'HOLD',stopFraction:.05};
}
function backtest(dataset, {start, end, mode='candidate', costBps=15, slippageBps=10}={}) {
  const capital=3_000_000;
  const fee=costBps/10000, slip=slippageBps/10000;
  let cash=capital, peak=capital, maxDrawdown=0, costs=0, exposureSum=0;
  const holdings=new Map(), curves=[], closedTrades=[];
  const series=Object.entries(dataset).sort(([a],[b])=>a.localeCompare(b));
  const dates=[...new Set(series.flatMap(([,s])=>s.bars.map(b=>b.date)))].sort().filter(d=>d>=start&&d<=end);
  let wins=0, grossProfit=0, grossLoss=0;
  for (const date of dates) {
    const available=series.map(([symbol,series])=>({symbol,series,index:series.bars.findIndex(b=>b.date===date)})).filter(r=>r.index>=65);
    let dayBuy=0;
    function sell(symbol, quantity, price, reason) {
      const lot=holdings.get(symbol), value=quantity*price;
      cash+=value*(1-fee);costs+=value*fee;
      const profit=value*(1-fee)-quantity*lot.unitCost;
      lot.pnl+=profit;lot.quantity-=quantity;
      if(reason==='TAKE_PROFIT_10')lot.partialTaken=true;
      if(!lot.quantity){closedTrades.push({symbol,date,pnl:lot.pnl});if(lot.pnl>0){wins++;grossProfit+=lot.pnl;}else grossLoss-=lot.pnl;holdings.delete(symbol);}
    }
    const soldToday=new Set();
    for (const {symbol,series,index} of available) {
      const lot=holdings.get(symbol);if(!lot)continue;
      const today=series.bars[index], yesterday=series.bars[index-1];
      // Yesterday's final close determines the exit; execution is the next observed open.
      const signal=(mode==='legacy-signal'?legacySignal:analyzeTrend)(series.bars.slice(0,index));
      const exit=exitDecision({quantity:lot.quantity,averagePrice:lot.averagePrice,currentPrice:yesterday.close*series.fx,
        stopFraction:lot.stopFraction,partialTaken:lot.partialTaken});
      const nav=cash+[...holdings.values()].reduce((s,h)=>s+h.quantity*h.lastPrice,0);
      const reason=nav<=capital*.8?'STRATEGY_DRAWDOWN_20':exit?.reason??(signal.side==='SELL'?'TREND_EXIT':null);
      if(reason){sell(symbol, reason==='TAKE_PROFIT_10'?exit.quantity:lot.quantity,today.open*series.fx*(1-slip),reason);soldToday.add(symbol);}
    }
    for (const {symbol,series,index} of available) {
      if(holdings.has(symbol)||soldToday.has(symbol)||holdings.size>=5)continue;
      const today=series.bars[index], previous=series.bars[index-1];
      const signal=(mode==='legacy-signal'?legacySignal:analyzeTrend)(series.bars.slice(0,index));
      if(signal.side!=='BUY'||Math.abs(today.open/previous.close-1)>0.02)continue;
      const committed=[...holdings.values()].reduce((s,h)=>s+h.quantity*h.lastPrice,0);
      if(cash+committed<=capital*.8)continue;
      const price=today.open*series.fx*(1+slip);
      const quantity=Math.min(sizeForRisk({budget:capital,price,stopFraction:signal.stopFraction,committed,dailyRemaining:capital-dayBuy}),Math.floor(cash/(price*(1+fee))));
      if(quantity<=0)continue;
      const value=quantity*price;cash-=value*(1+fee);costs+=value*fee;dayBuy+=value;
      holdings.set(symbol,{quantity,averagePrice:price,unitCost:price*(1+fee),lastPrice:price,
        stopFraction:signal.stopFraction,partialTaken:false,pnl:0});
    }
    for(const {symbol,series,index} of available){const lot=holdings.get(symbol);if(lot)lot.lastPrice=series.bars[index].close*series.fx;}
    const exposure=[...holdings.values()].reduce((s,h)=>s+h.quantity*h.lastPrice,0);
    const nav=cash+exposure;peak=Math.max(peak,nav);maxDrawdown=Math.max(maxDrawdown,1-nav/peak);exposureSum+=exposure/nav;
    curves.push({date,nav});
  }
  // Mark remaining positions at last close; do not pretend they were realized winners.
  const ending=curves.at(-1)?.nav??capital;
  function passive(fraction){return series.reduce((total,[,s])=>{
    const rows=s.bars.filter(b=>b.date>=start&&b.date<=end);if(!rows.length)return total;
    return total+capital*fraction/series.length*((rows.at(-1).close*(1-slip)*(1-fee))/(rows[0].open*(1+slip)*(1+fee))-1);
  },capital);}
  return {mode,start:dates[0],end:dates.at(-1),netReturnPct:(ending/capital-1)*100,maxDrawdownPct:maxDrawdown*100,
    closedTrades:closedTrades.length,winRatePct:closedTrades.length?wins/closedTrades.length*100:null,
    profitFactor:grossLoss>0?grossProfit/grossLoss:null,feesKrw:costs,averageExposurePct:dates.length?exposureSum/dates.length*100:0,
    fullBuyHoldReturnPct:(passive(1)/capital-1)*100,halfBuyHoldReturnPct:(passive(.5)/capital-1)*100,
    openPositions:holdings.size,curve:curves};
}
module.exports={backtest};
if(require.main===module){
  if(!process.argv[2])throw Error('Usage: node scripts/backtest.cjs DATASET.json [REPORT.json]');
  const dataset=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
  const report={strategy:STRATEGY_VERSION,validationStatus:'UNVALIDATED_PAPER_ONLY',
    assumptions:{initialCapitalKrw:3000000,costBpsPerSide:15,slippageBpsPerSide:10,fx:'Fixed 1500 KRW/USD; not actual currency returns',
      description:'Daily next-open approximation using adjusted OHLC; dividends approximated by adjustment. Shared new risk limits for candidate and old signal. Not a full replay of old bugs or minute-by-minute risk exits.',
      limitations:['Chosen current watchlist has survivorship/selection bias','No order-book liquidity, KIS fill or partial-fill simulation','No point-in-time constituent universe','No intraday daily-loss trigger simulation','Historical comparison inspected during development, not an untouched holdout or prospective validation','Mixed-market daily ordering is an approximation, not timestamp-accurate execution','Costs are assumptions, not broker/tax schedules']},results:[]};
  for(const [start,end] of [['20180101','20211231'],['20220101','20260910']])
    for(const mode of ['legacy-signal','candidate'])report.results.push(backtest(dataset,{start,end,mode}));
  report.costStress=backtest(dataset,{start:'20220101',end:'20260910',mode:'candidate',costBps:30,slippageBps:20});
  const output=process.argv[3]||'backtest-report.json';fs.writeFileSync(output,JSON.stringify(report,null,2));
  console.log(JSON.stringify(report.results.map(({curve,...r})=>r),null,2));
}
