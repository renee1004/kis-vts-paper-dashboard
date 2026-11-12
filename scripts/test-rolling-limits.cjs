const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLoader } = require('./lib/load-source.cjs');

const RealDate = Date;
let now = RealDate.parse('2026-09-10T14:50:00Z'); // 23:50 KST, US regular hours
global.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
};

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kis-rolling-limits-'));
Object.assign(process.env, {
  DATA_DIR: testDir,
  KIS_APP_KEY: 'test-key-not-real',
  KIS_APP_SECRET: 'test-secret-not-real',
  KIS_ACCOUNT_NO: '00000000',
  KIS_ACCOUNT_PRODUCT_CODE: '01',
  KIS_BASE_URL: 'https://openapivts.koreainvestment.com:29443',
  TRADING_MODE: 'DEMO',
  ORDER_EXECUTION_MODE: 'VTS_MOCK',
  ALLOW_REAL_DOMESTIC_ORDER: 'false',
  ALLOW_REAL_OVERSEAS_ORDER: 'false',
  KIS_ALLOW_REAL_FALLBACK: 'false',
});
delete global.__vtsPaperState;

const load = createLoader();
const { buyNotionalKrw, DEFAULT_SAFETY_SETTINGS, USD_KRW_SAFETY_RATE } = load('src/lib/domain.ts');
const { DAILY_BUY_CAP_KRW, PAPER_CAPITAL_KRW } = load('src/lib/trading-limits.ts');
const { sizeForRisk } = load('src/lib/strategy.ts');
const store = load('src/lib/store.ts');
const { state } = store;
const execution = load('src/lib/vts-execution.ts');

const KST_2350 = RealDate.parse('2026-09-10T14:50:00Z');
const KST_0010_NEXT = RealDate.parse('2026-09-10T15:10:00Z');
const AFTER_24H = KST_2350 + 24 * 3600_000 + 1;
const LOSS_2PCT = PAPER_CAPITAL_KRW * 0.02;

let passed = 0;
function check(name, run) { run(); passed++; console.log('PASS', name); }
async function test(name, run) { await run(); passed++; console.log('PASS', name); }

function buyOrder(overrides = {}) {
  return {
    id: 'buy-1', timestamp: new RealDate(KST_2350).toISOString(), orderDate: '20260910',
    market: 'DOMESTIC', currency: 'KRW', exchange: 'KRX', stockCode: '005930', stockName: 'test',
    side: 'BUY', quantity: 1, filledQuantity: 1, referencePrice: 4_000_000, averageFillPrice: 4_000_000,
    status: 'SUBMITTED', kisOrderNo: '1', kisBranchNo: '1', ownershipScope: 'AGENT_CREATED_ONLY',
    blockedReason: null, signalId: 'test', sessionId: null, ...overrides,
  };
}

function checkedNews(codes) {
  const decision = { newsSide: 'HOLD', reason: '종목 뉴스 검토 완료', fresh: true, at: new Date().toISOString(), evidenceIds: [] };
  const decisions = {};
  for (const code of codes) decisions[`US_NASDAQ:${code}`] = decision;
  global.__newsResearch = { version: load('src/lib/news-model.ts').NEWS_VERSION, articles: [], decisions };
}

function reset() {
  now = KST_2350;
  checkedNews(['TEST', 'OTHER', 'THIRD']);
  state.isRunning = true;
  state.prepared = true;
  state.settings = {
    ...DEFAULT_SAFETY_SETTINGS, killSwitchEnabled: false, autoDomesticOrderEnabled: true,
    autoOverseasOrderEnabled: true, autoExitEnabled: true, pipelineTestEnabled: true, allowStrategyTestOrder: true,
  };
  state.vtsOrders = [];
  state.agentOwnedPositions = [];
  state.positions = [];
  state.overseasPositions = [];
  state.balanceSnapshot = { cash: 30e6, totalEvaluation: 30e6, syncedAt: new Date().toISOString() };
  state.overseasBalanceSnapshot = { syncedAt: new Date().toISOString() };
  state.strategyRisk = { date: '', startPnl: 0, pnlSnapshots: [] };
}

const usInput = {
  market: 'US_NASDAQ', stockCode: 'TEST', stockName: 'Test', side: 'BUY', confidence: 100,
  price: 3000, signalId: 'test', signalDate: '20260909', stopFraction: 0.08,
};
let sent = [];
const client = {
  getOverseasBuyingPower: async () => ({ amountUsd: 20000, quantity: 6, checkedAt: Date.now() }),
  submitOverseasMockOrder: async (r) => { sent.push(r); return { orderNo: 'test-order', branchNo: '1' }; },
  submitMockOrder: async () => { throw Error('Unexpected domestic order'); },
};

check('rolling window includes 23:50 KST buy at 00:10 next KST day', () => {
  const orders = [buyOrder({ status: 'SUBMITTED', quantity: 1, filledQuantity: 0, referencePrice: 4_000_000 })];
  assert.equal(execution.rollingBuyNotional24h(KST_2350, orders), 4_000_000);
  assert.equal(execution.rollingBuyNotional24h(KST_0010_NEXT, orders), 4_000_000);
  assert.equal(sizeForRisk({
    budget: 30e6, price: 100000, stopFraction: 0.05, committed: 0,
    dailyRemaining: DAILY_BUY_CAP_KRW - execution.rollingBuyNotional24h(KST_0010_NEXT, orders),
  }, 'DOMESTIC'), 5);
});

check('KST midnight does not free the cap; 24h later does', () => {
  const orders = [buyOrder({ status: 'SUBMITTED', quantity: 1, filledQuantity: 0, referencePrice: 4_500_000 })];
  assert.equal(execution.rollingBuyNotional24h(KST_0010_NEXT, orders), 4_500_000);
  assert.equal(execution.rollingBuyNotional24h(KST_2350 + 24 * 3600_000 - 1, orders), 4_500_000);
  assert.equal(execution.rollingBuyNotional24h(KST_2350 + 24 * 3600_000, orders), 0);
  assert.equal(execution.rollingBuyNotional24h(AFTER_24H, orders), 0);
});

check('buyNotionalKrw semantics are unchanged inside the rolling window', () => {
  const submitted = buyOrder({ status: 'SUBMITTED', quantity: 10, filledQuantity: 0, referencePrice: 100, currency: 'KRW' });
  const unknown = buyOrder({ status: 'UNKNOWN', quantity: 10, filledQuantity: 0, referencePrice: 100 });
  const partial = buyOrder({ status: 'PARTIALLY_FILLED', quantity: 10, filledQuantity: 3, referencePrice: 100 });
  const filled = buyOrder({ status: 'FILLED', quantity: 10, filledQuantity: 4, referencePrice: 100 });
  const rejected = buyOrder({ status: 'REJECTED', quantity: 10, filledQuantity: 0, referencePrice: 100 });
  const blocked = buyOrder({ status: 'BLOCKED', quantity: 10, filledQuantity: 0, referencePrice: 100 });
  const usd = buyOrder({
    status: 'SUBMITTED', quantity: 2, filledQuantity: 0, referencePrice: 10, currency: 'USD', market: 'US_NASDAQ',
  });
  assert.equal(buyNotionalKrw(submitted), 1000);
  assert.equal(buyNotionalKrw(unknown), 1000);
  assert.equal(buyNotionalKrw(partial), 1000);
  assert.equal(buyNotionalKrw(filled), 400);
  assert.equal(buyNotionalKrw(rejected), 0);
  assert.equal(buyNotionalKrw(blocked), 0);
  assert.equal(buyNotionalKrw(usd), 2 * 10 * USD_KRW_SAFETY_RATE);
  assert.equal(execution.rollingBuyNotional24h(KST_0010_NEXT, [submitted, rejected, usd]), 1000 + 2 * 10 * USD_KRW_SAFETY_RATE);
});

check('todayBuyNotional is a trivial alias of the rolling 24h sum', () => {
  const orders = [buyOrder({ status: 'SUBMITTED', quantity: 1, filledQuantity: 0, referencePrice: 123456 })];
  state.vtsOrders = orders;
  assert.equal(execution.todayBuyNotional(KST_0010_NEXT), execution.rollingBuyNotional24h(KST_0010_NEXT, orders));
});

check('loss limit still blocks a -2% drop that crosses KST midnight', () => {
  reset();
  assert.equal(execution.rollingLossExceeded(0, KST_2350), false);
  assert.equal(execution.rollingLossExceeded(-LOSS_2PCT, KST_0010_NEXT), true);
  assert.ok(state.strategyRisk.pnlSnapshots.length >= 1);
});

check('a -2% drop no longer blocks after the 24h peak ages out', () => {
  reset();
  assert.equal(execution.rollingLossExceeded(0, KST_2350), false);
  assert.equal(execution.rollingLossExceeded(-LOSS_2PCT, KST_2350 + 3600_000), true);
  assert.equal(execution.rollingLossExceeded(-LOSS_2PCT, AFTER_24H), false);
});

check('empty or legacy strategyRisk without snapshots does not throw and does not lock', () => {
  state.strategyRisk = { date: '20260911', startPnl: -50 };
  assert.equal(execution.rollingLossExceeded(0, KST_2350), false);
  state.strategyRisk = null;
  assert.equal(execution.rollingLossExceeded(-100, KST_2350), false);
  state.strategyRisk = { pnlSnapshots: [{ at: 'bad', pnl: 'nope' }, { at: KST_2350, hour: Math.floor(KST_2350 / 3600_000), pnl: 10 }] };
  assert.equal(execution.rollingLossExceeded(10 - LOSS_2PCT, KST_2350), true);
});

check('old persisted state without snapshots or limitBasis loads and is tagged', () => {
  const legacyOrder = {
    id: 'legacy-1', timestamp: '2026-09-10T01:00:00Z', orderDate: '20260910',
    stockCode: '005930', stockName: '삼성전자', side: 'BUY', quantity: 2, filledQuantity: 2,
    referencePrice: 100000, status: 'FILLED',
  };
  fs.writeFileSync(path.join(testDir, 'state.json'), JSON.stringify({
    strategyRisk: { date: '20260911', startPnl: -123 },
    vtsOrders: [legacyOrder],
  }));
  delete global.__vtsPaperState;
  const restarted = createLoader()('src/lib/store.ts');
  assert.equal(restarted.state.strategyRisk.startPnl, -123);
  assert.deepEqual(restarted.state.strategyRisk.pnlSnapshots, []);
  assert.equal(restarted.state.vtsOrders[0].limitBasis, 'KST_DATE');
  assert.equal(restarted.state.vtsOrders[0].quantity, 2);
  assert.equal(restarted.state.vtsOrders[0].referencePrice, 100000);
  const exec = createLoader()('src/lib/vts-execution.ts');
  assert.equal(exec.rollingLossExceeded(0, KST_2350), false);
  global.__vtsPaperState = state;
});

(async () => {
  await test('US session crossing KST midnight cannot reuse the buy cap', async () => {
    reset(); sent = [];
    const first = await execution.executeVtsMockOrder(client, usInput);
    assert.equal(first.status, 'SUBMITTED', first.blockedReason);
    assert.equal(first.limitBasis, 'ROLLING_24H');
    assert.equal(sent.length, 1);
    now = KST_0010_NEXT;
    state.overseasBalanceSnapshot = { syncedAt: new Date().toISOString() };
    assert.equal(execution.rollingBuyNotional24h(now), 3000 * USD_KRW_SAFETY_RATE);
    const second = await execution.executeVtsMockOrder(client, {
      ...usInput, stockCode: 'OTHER', signalId: 'other', signalDate: '20260910',
    });
    assert.equal(sent.length, 1);
    assert.equal(second.status, 'BLOCKED');
    assert.ok(['POSITION_OR_DAILY_BUDGET_CAP', 'US_ORDERABLE_FUNDS_OR_BUDGET_CAP'].includes(second.blockedReason), second.blockedReason);
  });

  await test('buy cap frees after 24h and new orders are marked ROLLING_24H', async () => {
    reset(); sent = [];
    const first = await execution.executeVtsMockOrder(client, usInput);
    assert.equal(first.status, 'SUBMITTED', first.blockedReason);
    now = AFTER_24H;
    checkedNews(['TEST', 'OTHER', 'THIRD']);
    state.overseasBalanceSnapshot = { syncedAt: new Date().toISOString() };
    const later = await execution.executeVtsMockOrder(client, {
      ...usInput, stockCode: 'OTHER', signalId: 'other', signalDate: '20260911',
    });
    assert.equal(later.status, 'SUBMITTED', later.blockedReason);
    assert.equal(later.limitBasis, 'ROLLING_24H');
    assert.equal(sent.length, 2);
  });

  console.log(JSON.stringify({ passed, externalOrders: 0 }));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  global.Date = RealDate;
});
