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
const { rebasedTrendExitGate, rebasedStopPrice } = load('src/lib/stop-rebase.ts');
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
check('rebased trend exit waits until 09:30 KST and needs price below 20-day line', () => {
  const at0905 = new Date('2026-10-07T00:05:00Z'), at0935 = new Date('2026-10-07T00:35:00Z');
  assert.equal(rebasedTrendExitGate({ currentPrice: 108000, trendMa: 120000, at: at0905 }).reason, 'REBASED_TREND_WAIT_0930');
  assert.equal(rebasedTrendExitGate({ currentPrice: 108000, trendMa: 120000, at: at0935 }).allowed, true);
  assert.equal(rebasedTrendExitGate({ currentPrice: 121000, trendMa: 120000, at: at0935 }).reason, 'REBASED_TREND_NOT_CONFIRMED');
  assert.equal(rebasedTrendExitGate({ currentPrice: 108000, trendMa: null, at: at0935 }).reason, 'REBASED_TREND_MA_MISSING');
});
check('dry run for 000720 never orders and follows the rebased rules', () => {
  const item = state.watchlist.find((w) => w.stockCode === '000720'); item.analysis = 'SELL'; item.trendMa = 120000;
  const run = (price, iso) => execution.dryRunExit({ market: 'DOMESTIC', stockCode: '000720', price, at: new Date(iso) }).action;
  assert.equal(run(112900, '2026-10-07T00:05:00Z'), 'HOLD (REBASED_TREND_WAIT_0930)');
  assert.equal(run(107000, '2026-10-07T00:05:00Z'), 'SELL 57 (REBASED_HARD_STOP)');
  assert.equal(run(112900, '2026-10-07T00:35:00Z'), 'SELL 57 (REBASED_TREND_CONFIRMED)');
  const sk = execution.dryRunExit({ market: 'DOMESTIC', stockCode: '000660', price: 1743000, at: new Date('2026-10-07T00:05:00Z') });
  assert.equal(sk.stopBasis, 'AVERAGE_COST'); assert.equal(sk.action, 'SELL 5 (VOLATILITY_STOP)');
  assert.equal(imp.revertPre0911Import().removed, 23); assert.equal(state.stopOverrides.length, 0);
});
console.log(`fill-import tests passed (${checks})`);