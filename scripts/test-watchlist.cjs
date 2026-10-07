/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLoader } = require('./lib/load-source.cjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kis-watchlist-test-'));
process.env.DATA_DIR = dir;
// A legacy state: mislabeled 003670, no source fields, an emptied US list.
fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
  watchlist: [
    { id: 'a', stockCode: '003670', stockName: '포스코홀딩스' },
    { id: 'b', stockCode: '005930', stockName: '삼성전자' },
    { id: 'c', stockCode: '035720', stockName: '카카오' },
  ],
  usWatchlist: [],
}));
delete global.__vtsPaperState;
let checks = 0;
const check = (name, run) => { run(); checks++; console.log('PASS', name); };
const load = createLoader();
const { state, correctedStockName } = load('src/lib/store.ts');
const w = load('src/lib/watchlist.ts');

check('003670 label migrates to 포스코퓨처엠', () => {
  assert.equal(state.watchlist.find((i) => i.stockCode === '003670').stockName, '포스코퓨처엠');
  assert.equal(correctedStockName('003670', '직접입력'), '직접입력');
});
check('legacy entries get DEFAULT/USER source', () => {
  assert.equal(state.watchlist.find((i) => i.stockCode === '005930').source, 'DEFAULT');
  assert.equal(state.watchlist.find((i) => i.stockCode === '035720').source, 'USER');
});
check('an intentionally empty list is not refilled with defaults', () => {
  assert.equal(state.usWatchlist.length, 0);
});
check('symbol validation', () => {
  assert.equal(w.normalizeSymbol('DOMESTIC', ' 035720 '), '035720');
  assert.equal(w.normalizeSymbol('DOMESTIC', '35720'), null);
  assert.equal(w.normalizeSymbol('DOMESTIC', 'AAPL'), null);
  assert.equal(w.normalizeSymbol('US_NASDAQ', 'tsla'), 'TSLA');
  assert.equal(w.normalizeSymbol('US_NASDAQ', 'BRK.B'), null);
  assert.equal(w.normalizeSymbol('US_NASDAQ', '005930'), null);
});
check('add creates a USER item with the agent fields, dedupes', () => {
  const r = w.addWatchlistItem({ market: 'US_NASDAQ', stockCode: 'tsla', stockName: '<b>Tesla</b>', currentPrice: 250 });
  assert.equal(r.ok && r.created, true);
  assert.equal(r.item.stockCode, 'TSLA');
  assert.equal(r.item.stockName, 'bTesla/b');
  assert.equal(r.item.source, 'USER');
  assert.equal(r.item.currency, 'USD');
  assert.equal(r.item.analysis, 'HOLD');
  const again = w.addWatchlistItem({ market: 'US_NASDAQ', stockCode: 'TSLA' });
  assert.equal(again.ok && again.created, false);
  assert.equal(state.usWatchlist.length, 1);
  const noName = w.addWatchlistItem({ market: 'DOMESTIC', stockCode: '000270' });
  assert.equal(noName.item.stockName, '000270');
  assert.equal(noName.item.currency, 'KRW');
});
check('invalid add rejected', () => {
  assert.deepEqual(w.addWatchlistItem({ market: 'DOMESTIC', stockCode: 'x' }), { ok: false, error: 'INVALID_SYMBOL' });
});
check('remove a held symbol requires force', () => {
  state.positions = [{ stockCode: '035720', quantity: 3 }];
  const blocked = w.removeWatchlistItem({ market: 'DOMESTIC', stockCode: '035720' });
  assert.equal(blocked.error, 'HELD_POSITION_CONFIRM_REQUIRED');
  assert.equal(blocked.heldQuantity, 3);
  assert.ok(state.watchlist.some((i) => i.stockCode === '035720'));
  const forced = w.removeWatchlistItem({ market: 'DOMESTIC', stockCode: '035720', force: true });
  assert.equal(forced.ok, true);
  assert.ok(!state.watchlist.some((i) => i.stockCode === '035720'));
});
check('agent-owned quantity also counts as held', () => {
  state.positions = [];
  state.agentOwnedPositions = [{ market: 'US_NASDAQ', stockCode: 'TSLA', quantity: 1 }];
  assert.equal(w.removeWatchlistItem({ market: 'US_NASDAQ', stockCode: 'TSLA' }).error, 'HELD_POSITION_CONFIRM_REQUIRED');
  state.agentOwnedPositions = [];
  assert.equal(w.removeWatchlistItem({ market: 'US_NASDAQ', stockCode: 'TSLA' }).ok, true);
  assert.equal(w.removeWatchlistItem({ market: 'US_NASDAQ', stockCode: 'TSLA' }).error, 'NOT_FOUND');
});
check('per-market cap', () => {
  for (let i = 0; state.watchlist.length < w.MAX_WATCHLIST_PER_MARKET; i++) w.addWatchlistItem({ market: 'DOMESTIC', stockCode: String(100000 + i) });
  assert.equal(w.addWatchlistItem({ market: 'DOMESTIC', stockCode: '999999' }).error, 'WATCHLIST_FULL');
});
console.log(`${checks} watchlist checks passed`);
