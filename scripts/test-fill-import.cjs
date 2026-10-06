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
console.log(`fill-import tests passed (${checks})`);