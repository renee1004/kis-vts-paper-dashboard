const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLoader } = require('./lib/load-source.cjs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kis-fill-import-test-'));
process.env.KIS_APP_KEY = 'test-key-not-real';
process.env.KIS_APP_SECRET = 'test-secret-not-real';
process.env.KIS_ACCOUNT_NO = '00000000';
process.env.KIS_ACCOUNT_PRODUCT_CODE = '01';
process.env.KIS_BASE_URL = 'https://openapivts.koreainvestment.com:29443';
process.env.TRADING_MODE = 'DEMO';
process.env.ORDER_EXECUTION_MODE = 'VTS_MOCK';
delete global.__vtsPaperState;
let checks = 0;
const check = (name, run) => { run(); checks++; console.log('PASS', name); };
const load = createLoader();
const { ownedLot, sameKisOrderNo } = load('src/lib/ownership.ts');
const { state } = load('src/lib/store.ts');
const imp = load('src/lib/fill-import.ts');
const pos = (stockCode, quantity) => ({ id: stockCode, market: 'DOMESTIC', stockCode, stockName: stockCode, quantity,
  averagePrice: 1, currentPrice: 1, evaluation: 0, purchaseAmount: 0, profitLoss: 0, profitRate: 0, currency: 'KRW',
  source: 'KIS_BALANCE', lastSyncedAt: new Date().toISOString() });

check('order numbers compare without zero padding', () => {
  assert.equal(sameKisOrderNo('0000038733', '38733'), true);
  assert.equal(sameKisOrderNo('0000038733', '0000038734'), false);
  assert.equal(sameKisOrderNo('', ''), false);
  assert.equal(sameKisOrderNo(null, '0'), false);
});
check('import refuses quantities above broker holdings', () => {
  state.positions = [pos('000720', 10), pos('005930', 28), pos('000660', 5), pos('069500', 8)];
  state.balanceSnapshot = { syncedAt: new Date().toISOString() };
  assert.throws(() => imp.applyPre0911Import(), /IMPORT_EXCEEDS_BROKER_HOLDING/);
  assert.equal(state.vtsOrders.length, 0);
});
check('import registers owned lots, is idempotent and reversible', () => {
  state.positions = [pos('000720', 58), pos('005930', 28), pos('000660', 5), pos('069500', 8), pos('003670', 1)];
  const result = imp.applyPre0911Import();
  assert.equal(result.applied, true);
  const q = (c) => ownedLot(state.vtsOrders, 'DOMESTIC', c);
  assert.equal(q('000720').quantity, 57);
  assert.equal(Math.round(q('000720').averagePrice), 128784);
  assert.equal(q('005930').quantity, 28);
  assert.equal(q('000660').quantity, 5);
  assert.equal(q('069500').quantity, 8);
  assert.equal(q('003670').quantity, 0);
  assert.equal(q('000720').priceVerified, true);
  assert.ok(q('000720').positionId);
  assert.equal(state.agentOwnedPositions.length, 4);
  assert.equal(imp.applyPre0911Import().applied, false);
  assert.equal(state.vtsOrders.length, 23);
  assert.equal(imp.revertPre0911Import().removed, 23);
  assert.equal(state.agentOwnedPositions.length, 0);
});
const { exitDecision } = load('src/lib/strategy.ts');
const { closeBreakdown, recentLow, rebasedStopPrice } = load('src/lib/stop-rebase.ts');
const execution = load('src/lib/vts-execution.ts');
check('rebased stop: only imported lots already below stop, 0.95 x reference price', () => {
  const p = (c, q, price) => ({ ...pos(c, q), currentPrice: price });
  state.positions = [p('000720', 58, 112900), p('005930', 28, 272000), p('000660', 5, 1773000), p('069500', 8, 110745), p('003670', 1, 204500)];
  state.balanceSnapshot = { syncedAt: new Date().toISOString() };
  imp.applyPre0911Import();
  assert.equal(state.stopOverrides.length, 1);
  const o = state.stopOverrides[0];
  assert.equal(o.stockCode, '000720'); assert.equal(o.referencePrice, 112900); assert.equal(o.stopPrice, 107255);
  assert.equal(rebasedStopPrice(112900), 107255);
  assert.equal(imp.rebaseImportedStops().created.length, 0);
});
check('rebased hard stop replaces average-cost stop; take-profit unchanged', () => {
  const lot = { quantity: 57, averagePrice: 128784.21, stopFraction: 0.05, partialTaken: false, stopPrice: 107255 };
  assert.equal(exitDecision({ ...lot, currentPrice: 112900 }), null);
  assert.equal(exitDecision({ ...lot, currentPrice: 108000 }), null);
  assert.deepEqual(exitDecision({ ...lot, currentPrice: 107000 }), { quantity: 57, reason: 'REBASED_HARD_STOP' });
  assert.equal(exitDecision({ ...lot, currentPrice: 141700 }).reason, 'TAKE_PROFIT_10');
  assert.equal(exitDecision({ ...lot, stopPrice: undefined, currentPrice: 112900 }).reason, 'VOLATILITY_STOP');
});
// 12 completed bars ending 20261006 (lows), real 000720 values from KIS FHKST03010100.
const bars = [['20260916',123500,124300],['20260917',124600,125300],['20260918',123300,124800],['20260921',123500,125600],
  ['20260922',125700,131300],['20260923',120200,121100],['20260928',118900,124600],['20260929',115500,117000],
  ['20260930',117000,117500],['20261001',113800,117200],['20261002',113000,114400],['20261006',112600,113300]]
  .map(([date, low, close]) => ({ date, low, close }));
check('recent low = lowest low of previous 10 completed days, excluding evaluated day', () => {
  const e = closeBreakdown(bars, new Date());
  assert.equal(e.date, '20261006'); assert.equal(e.recentLow, 113000); assert.equal(e.windowStart, '20260917');
  assert.equal(e.windowEnd, '20261002'); assert.equal(e.breakdown, false);
  assert.equal(closeBreakdown([...bars.slice(0, -1), { date: '20261006', low: 111000, close: 112000 }], new Date()).breakdown, true);
  assert.equal(recentLow(bars.slice(0, 5), 5), null);
});
check('daily evaluation runs once per completed day and ignores today\'s partial bar', () => {
  const item = state.watchlist.find((w) => w.stockCode === '000720');
  const o = state.stopOverrides[0]; o.referenceDate = '20261006';
  const at1006 = new Date('2026-10-06T06:30:00Z'), at1007 = new Date('2026-10-07T00:05:00Z');
  const below = [...bars.slice(0, -1), { date: '20261006', low: 111000, close: 112000 }];
  execution.evaluateRebasedTrend(item, below, at1006);           // 10/6 bar is partial on 10/6
  assert.equal(o.lastCloseEvaluation, undefined); assert.equal(o.trendExitSignal, undefined);
  assert.equal(item.recentLow10, 113000);
  execution.evaluateRebasedTrend(item, bars, at1007);            // 10/6 completed, above low
  assert.equal(o.lastCloseEvaluation.date, '20261006'); assert.equal(o.trendExitSignal, undefined);
  const logs = state.logs.length;
  execution.evaluateRebasedTrend(item, below, at1007);           // same day again: no re-evaluation
  assert.equal(state.logs.length, logs); assert.equal(o.trendExitSignal, undefined);
  delete o.lastCloseEvaluation;
  execution.evaluateRebasedTrend(item, below, at1007);
  assert.equal(o.trendExitSignal.date, '20261006'); assert.equal(o.trendExitSignal.recentLow, 113000);
  delete o.trendExitSignal; delete o.lastCloseEvaluation;
});
check('dry run: hard stop any time, no intraday trend sell, close-based exit next session', () => {
  const item = state.watchlist.find((w) => w.stockCode === '000720'); item.analysis = 'SELL'; item.recentLow10 = 113000;
  const run = (price, iso) => execution.dryRunExit({ market: 'DOMESTIC', stockCode: '000720', price, at: new Date(iso) }).action;
  assert.equal(run(112900, '2026-10-07T00:05:00Z'), 'HOLD (REBASED_NO_INTRADAY_TREND_SELL)');
  assert.equal(run(112900, '2026-10-07T05:00:00Z'), 'HOLD (REBASED_NO_INTRADAY_TREND_SELL)');
  assert.equal(run(107000, '2026-10-07T00:05:00Z'), 'SELL 57 (REBASED_HARD_STOP)');
  const close = (c) => execution.dryRunExit({ market: 'DOMESTIC', stockCode: '000720', price: c, at: new Date(), simulatedClose: c }).action;
  assert.equal(close(112500), 'SELL 57 at next session open (REBASED_CLOSE_BELOW_RECENT_LOW)');
  assert.equal(close(113300), 'HOLD (REBASED_CLOSE_ABOVE_RECENT_LOW)');
  const sk = execution.dryRunExit({ market: 'DOMESTIC', stockCode: '000660', price: 1743000, at: new Date('2026-10-07T00:05:00Z') });
  assert.equal(sk.stopBasis, 'AVERAGE_COST'); assert.equal(sk.action, 'SELL 5 (VOLATILITY_STOP)');
  assert.equal(imp.revertPre0911Import().removed, 23); assert.equal(state.stopOverrides.length, 0);
});
console.log(`fill-import tests passed (${checks})`);
