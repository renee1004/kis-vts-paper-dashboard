const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLoader } = require('./lib/load-source.cjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kis-fx-'));
Object.assign(process.env, {
  DATA_DIR: dir,
  KIS_APP_KEY: 'test-only',
  KIS_APP_SECRET: 'test-only',
  KIS_ACCOUNT_NO: '00000000',
  KIS_ACCOUNT_PRODUCT_CODE: '01',
  KIS_BASE_URL: 'https://openapivts.koreainvestment.com:29443',
  TRADING_MODE: 'DEMO',
  ORDER_EXECUTION_MODE: 'VTS_MOCK',
  ALLOW_REAL_DOMESTIC_ORDER: 'false',
  ALLOW_REAL_OVERSEAS_ORDER: 'false',
  KIS_ALLOW_REAL_FALLBACK: 'false',
});
const realFetch = global.fetch;
global.fetch = async () => { throw new Error('NETWORK_FORBIDDEN_IN_TEST'); };
delete global.__vtsPaperState;
const load = createLoader();
const domain = load('src/lib/domain.ts');
const limits = load('src/lib/trading-limits.ts');
const { sizeForRisk } = load('src/lib/strategy.ts');
const fx = load('src/lib/fx-rate.ts');
const pnl = load('src/lib/fx-pnl.ts');
const { state } = load('src/lib/store.ts');
const execution = load('src/lib/vts-execution.ts');
const { emptyBook, advanceShadow, SHADOW_FX } = load('src/lib/news-shadow.ts');
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS', name); }
async function testAsync(name, fn) { await fn(); passed++; console.log('PASS', name); }

const buy1470sell1350 = pnl.stockAndFxPnl({
  quantity: 2, buyPriceUsd: 100, sellPriceUsd: 100, buyFx: 1470, sellFx: 1350,
});

(async () => {
  test('flat USD price with 1470→1350 FX is a KRW FX loss, not stock P&L', () => {
    assert.equal(buy1470sell1350.stockPnlUsd, 0);
    assert.equal(buy1470sell1350.stockPnlKrw, 0);
    assert.equal(buy1470sell1350.fxPnlKrw, 2 * 100 * (1350 - 1470));
    assert.equal(buy1470sell1350.totalKrw, -24000);
    assert.ok(buy1470sell1350.fxPnlKrw < 0);
  });

  test('stock P&L is USD and KRW at the buy rate; FX uses sell price × Δfx', () => {
    const result = pnl.stockAndFxPnl({
      quantity: 1, buyPriceUsd: 100, sellPriceUsd: 110, buyFx: 1470, sellFx: 1350,
    });
    assert.equal(result.stockPnlUsd, 10);
    assert.equal(result.stockPnlKrw, 10 * 1470);
    assert.equal(result.fxPnlKrw, 110 * (1350 - 1470));
    assert.equal(result.totalKrw, 1 * (110 * 1350 - 100 * 1470));
  });

  test('unrealized FX uses the current rate', () => {
    const result = pnl.stockAndFxPnl({
      quantity: 3, buyPriceUsd: 50, sellPriceUsd: 50, buyFx: 1400, sellFx: 1300,
    });
    assert.equal(result.fxPnlKrw, 3 * 50 * (1300 - 1400));
  });

  test('old records without fx show 환율 미기록 and skip KRW FX totals', () => {
    const view = pnl.usFxPnlFromOrders([
      {
        id: 'old-buy', timestamp: '2026-01-01T00:00:00Z', orderDate: '20260101',
        market: 'US_NASDAQ', stockCode: 'AAPL', stockName: 'Apple', side: 'BUY',
        quantity: 1, filledQuantity: 1, referencePrice: 100, averageFillPrice: 100,
        status: 'FILLED', kisOrderNo: '1', ownershipScope: 'AGENT_CREATED_ONLY',
      },
      {
        id: 'old-sell', timestamp: '2026-01-02T00:00:00Z', orderDate: '20260102',
        market: 'US_NASDAQ', stockCode: 'AAPL', stockName: 'Apple', side: 'SELL',
        quantity: 1, filledQuantity: 1, referencePrice: 100, averageFillPrice: 100,
        status: 'FILLED', kisOrderNo: '2', ownershipScope: 'AGENT_CREATED_ONLY',
      },
    ], {}, { rate: 1300, capturedAt: '2026-01-03T00:00:00Z', source: 'DUNAMU', status: 'AVAILABLE' });
    assert.equal(view.closed.length, 1);
    assert.equal(view.closed[0].fxNote, '환율 미기록');
    assert.equal(view.closed[0].buyFxLabel, '환율 미기록');
    assert.equal(view.closed[0].fxPnlKrw, null);
    assert.equal(view.totals.complete, false);
    assert.equal(view.totals.stockPnlUsd, 0);
  });

  test('unavailable lookup is 미확인, not 1,500', () => {
    const view = pnl.usFxPnlFromFills([{
      side: 'BUY', quantity: 1, priceUsd: 10, fxRateStatus: 'UNAVAILABLE', stockCode: 'MSFT', stockName: 'Microsoft',
    }], { MSFT: 10 }, fx.unavailableUsdKrwSnapshot('2026-01-01T00:00:00Z'));
    assert.equal(view.open[0].fxNote, '미확인');
    assert.equal(view.open[0].buyFxLabel, '미확인');
    assert.equal(view.currentFx.label, '미확인');
    assert.notEqual(view.currentFx.label, '1,500');
    assert.equal(view.limitsUseSafetyRate, 1500);
  });

  test('order limits, daily cap and name fraction still use 1,500', () => {
    assert.equal(domain.USD_KRW_SAFETY_RATE, 1500);
    assert.equal(limits.DAILY_BUY_CAP_KRW, 3000 * 1500);
    assert.equal(limits.marketRiskLimits('US_NASDAQ').orderCapKrw, 3000 * 1500);
    assert.equal(limits.marketRiskLimits('US_NASDAQ').nameFraction, 0.15);
    assert.equal(domain.buyNotionalKrw({
      side: 'BUY', status: 'FILLED', quantity: 1, filledQuantity: 1, referencePrice: 10, currency: 'USD',
    }), 10 * 1500);
    assert.equal(sizeForRisk({
      budget: 30e6, price: 3000 * 1500, stopFraction: 0.08, committed: 0, dailyRemaining: 4.5e6,
    }, 'US_NASDAQ'), 1);
    assert.equal(sizeForRisk({
      budget: 30e6, price: 3000.01 * 1500, stopFraction: 0.08, committed: 0, dailyRemaining: 4.5e6,
    }, 'US_NASDAQ'), 0);
    assert.equal(SHADOW_FX, 1500);
    assert.equal(execution.VTS_ORDER_LIMITS.usdKrwSafetyRate, 1500);
  });

  test('KIS payload extracts frst_bltn_exrt and ignores summary P&L totals', () => {
    assert.equal(fx.extractUsdKrwFromKisPayload({
      output1: [{ ovrs_pdno: 'AAPL', ovrs_cblc_qty: '2' }],
      output2: { frst_bltn_exrt: '1,347.50', tot_evlu_pfls_amt: 8888888, frcr_buy_amt_smtl1: 99999999 },
    }), 1347.5);
    assert.equal(fx.extractUsdKrwFromKisPayload({
      output2: { frcr_buy_amt_smtl1: 99999999, tot_evlu_pfls_amt: 8888888 },
    }), null);
    assert.equal(fx.parseDunamuUsdKrw([{ code: 'FRX.KRWUSD', currencyCode: 'USD', basePrice: 1310.2 }]), 1310.2);
    assert.equal(fx.parseFrankfurterUsdKrw({ rates: { KRW: 1322 } }), 1322);
    assert.equal(fx.parseUsdKrwNumber(1500), 1500);
    assert.equal(fx.sanitizeUsdKrw(1500) != null, true);
  });

  const stampNow = Date.parse('2026-11-12T12:00:00Z');
  const freshAt = '2026-11-12T12:00:00Z';
  const staleAt = '2026-11-12T11:50:00Z';
  const freshSnap = (rate, at = freshAt) => ({
    rate, capturedAt: at, source: 'DUNAMU', status: 'AVAILABLE',
  });

  await testAsync('failed public fetch is 미확인 and never writes 1500 as a stand-in', async () => {
    const snapshot = await fx.refreshUsdKrwRate({
      fetchImpl: async () => { throw new Error('NETWORK_FORBIDDEN_IN_TEST'); },
      now: Date.parse('2026-11-12T00:00:00Z'),
    });
    assert.equal(snapshot.status, 'UNAVAILABLE');
    assert.equal(snapshot.rate, null);
    assert.equal(fx.formatUsdKrwDisplay(snapshot), '미확인');
    const cached = JSON.parse(fs.readFileSync(path.join(dir, fx.FX_CACHE_FILE), 'utf8'));
    assert.equal(cached.rate, null);
    assert.notEqual(cached.rate, 1500);
  });

  await testAsync('stale cache is not used as the current/fill rate when public sources fail', async () => {
    fx.writeUsdKrwSnapshot({
      rate: 1470, capturedAt: staleAt, source: 'DUNAMU', status: 'AVAILABLE',
    });
    const snapshot = await fx.refreshUsdKrwRate({
      fetchImpl: async () => { throw new Error('NETWORK_FORBIDDEN_IN_TEST'); },
      now: stampNow,
    });
    assert.equal(snapshot.status, 'UNAVAILABLE');
    assert.equal(snapshot.rate, null);
    const cached = JSON.parse(fs.readFileSync(path.join(dir, fx.FX_CACHE_FILE), 'utf8'));
    assert.equal(cached.rate, 1470);
    assert.equal(cached.status, 'AVAILABLE');
    const current = fx.currentUsdKrwSnapshot(stampNow);
    assert.equal(current.status, 'UNAVAILABLE');
    const order = { market: 'US_NASDAQ', filledQuantity: 1 };
    fx.stampUsFillFx(order, fx.readUsdKrwSnapshot(), { now: stampNow });
    assert.equal(order.fxRateStatus, 'UNAVAILABLE');
    assert.equal(order.fxUsdKrw, undefined);
  });

  await testAsync('fresh cache is reused without treating 1,500 as a stand-in', async () => {
    fx.writeUsdKrwSnapshot({
      rate: 1347.5, capturedAt: freshAt, source: 'KIS_OVERSEAS_BALANCE', status: 'AVAILABLE',
    });
    const snapshot = await fx.refreshUsdKrwRate({
      fetchImpl: async () => { throw new Error('NETWORK_FORBIDDEN_IN_TEST'); },
      now: stampNow,
    });
    assert.equal(snapshot.status, 'AVAILABLE');
    assert.equal(snapshot.rate, 1347.5);
    assert.notEqual(snapshot.rate, 1500);
  });

  test('stamp records actual FX once; same-quantity later stamps do not overwrite', () => {
    const order = { market: 'US_NASDAQ' };
    fx.stampUsFillFx(order, freshSnap(1470), { now: stampNow });
    assert.equal(order.fxUsdKrw, 1470);
    assert.equal(order.fxRateStatus, 'RECORDED');
    fx.stampUsFillFx(order, freshSnap(1300), { now: stampNow });
    assert.equal(order.fxUsdKrw, 1470);
    const missing = { market: 'US_NASDAQ' };
    fx.stampUsFillFx(missing, fx.unavailableUsdKrwSnapshot(freshAt), { now: stampNow });
    assert.equal(missing.fxRateStatus, 'UNAVAILABLE');
    assert.equal(missing.fxUsdKrw, undefined);
    const domestic = { market: 'DOMESTIC' };
    fx.stampUsFillFx(domestic, freshSnap(1470), { now: stampNow });
    assert.equal(domestic.fxRateStatus, undefined);
  });

  test('later partial fills quantity-weight the recorded FX rate', () => {
    const order = { market: 'US_NASDAQ', filledQuantity: 1 };
    fx.stampUsFillFx(order, freshSnap(1470), { now: stampNow, previousFilledQuantity: 0 });
    assert.equal(order.fxUsdKrw, 1470);
    order.filledQuantity = 3;
    fx.stampUsFillFx(order, freshSnap(1350), { now: stampNow, previousFilledQuantity: 1 });
    assert.equal(order.fxUsdKrw, (1470 * 1 + 1350 * 2) / 3);
    assert.equal(order.fxRateStatus, 'RECORDED');
  });

  test('same-cycle UNAVAILABLE stamp upgrades when a fresh KIS rate arrives', () => {
    const order = { market: 'US_NASDAQ', filledQuantity: 1 };
    fx.stampUsFillFx(order, fx.unavailableUsdKrwSnapshot(freshAt), {
      now: stampNow, previousFilledQuantity: 0,
    });
    assert.equal(order.fxRateStatus, 'UNAVAILABLE');
    fx.stampUsFillFx(order, {
      rate: 1340, capturedAt: freshAt, source: 'KIS_OVERSEAS_BALANCE', status: 'AVAILABLE',
    }, { now: stampNow, previousFilledQuantity: 1 });
    assert.equal(order.fxRateStatus, 'RECORDED');
    assert.equal(order.fxUsdKrw, 1340);
    assert.equal(order.fxSource, 'KIS_OVERSEAS_BALANCE');
  });

  test('agent cycle records KIS overseas FX before fill reconcile', () => {
    const agent = fs.readFileSync(path.join(__dirname, '..', 'src/lib/agent.ts'), 'utf8');
    const cycle = agent.split('export async function runAgentCycle')[1];
    const overseasAt = cycle.indexOf('getOverseasBalance');
    const recordAt = cycle.indexOf('recordObservedUsdKrw');
    const refreshAt = cycle.indexOf('refreshUsdKrwRate');
    const reconcileAt = cycle.indexOf('reconcileAgentOwnedFills');
    assert.ok(overseasAt >= 0 && recordAt > overseasAt);
    assert.ok(refreshAt > recordAt);
    assert.ok(reconcileAt > refreshAt);
  });

  test('strategy valuation still converts US fills at 1,500, not the recorded rate', () => {
    state.vtsOrders = [{
      id: 'us-buy', timestamp: '2026-11-01T00:00:00Z', orderDate: '20261101',
      market: 'US_NASDAQ', stockCode: 'AAPL', stockName: 'Apple', side: 'BUY',
      quantity: 1, filledQuantity: 1, referencePrice: 100, averageFillPrice: 100,
      status: 'FILLED', kisOrderNo: '1', ownershipScope: 'AGENT_CREATED_ONLY',
      fxUsdKrw: 1470, fxRateStatus: 'RECORDED',
    }, {
      id: 'us-sell', timestamp: '2026-11-02T00:00:00Z', orderDate: '20261102',
      market: 'US_NASDAQ', stockCode: 'AAPL', stockName: 'Apple', side: 'SELL',
      quantity: 1, filledQuantity: 1, referencePrice: 100, averageFillPrice: 100,
      status: 'FILLED', kisOrderNo: '2', ownershipScope: 'AGENT_CREATED_ONLY',
      fxUsdKrw: 1350, fxRateStatus: 'RECORDED',
    }];
    state.overseasPositions = [];
    state.overseasBalanceSnapshot = null;
    const valuation = execution.strategyValuation();
    const buy = 100 * 1500;
    const expected = (-buy - buy * 0.0015) + (buy - buy * 0.0015);
    assert.equal(valuation.pnl, expected);
    assert.notEqual(valuation.pnl, 100 * (1350 - 1470));
  });

  await testAsync('US fill reconcile stamps cached FX and not 1,500 when missing', async () => {
    fx.writeUsdKrwSnapshot({
      rate: 1470, capturedAt: new Date().toISOString(), source: 'DUNAMU', status: 'AVAILABLE',
    });
    state.vtsOrders = [{
      id: 'pending-us', timestamp: '2026-11-10T14:00:00Z', orderDate: '20261110',
      market: 'US_NASDAQ', stockCode: 'AAPL', stockName: 'Apple', side: 'BUY',
      quantity: 1, filledQuantity: 0, referencePrice: 100, averageFillPrice: undefined,
      status: 'SUBMITTED', kisOrderNo: '77', kisBranchNo: '1', ownershipScope: 'AGENT_CREATED_ONLY',
    }];
    await execution.reconcileAgentOwnedFills({
      getOverseasTodayExecutions: async () => [{
        orderDate: '20261110', orderNo: '77', branchNo: '1', stockCode: 'AAPL',
        filledQuantity: 1, averageFillPrice: 101,
      }],
    });
    assert.equal(state.vtsOrders[0].averageFillPrice, 101);
    assert.equal(state.vtsOrders[0].fxUsdKrw, 1470);
    assert.equal(state.vtsOrders[0].fxRateStatus, 'RECORDED');
    state.vtsOrders = [{
      id: 'pending-us-2', timestamp: '2026-11-10T14:00:00Z', orderDate: '20261110',
      market: 'US_NASDAQ', stockCode: 'NVDA', stockName: 'NVIDIA', side: 'SELL',
      quantity: 1, filledQuantity: 0, referencePrice: 100, status: 'SUBMITTED',
      kisOrderNo: '88', kisBranchNo: '1', ownershipScope: 'AGENT_CREATED_ONLY',
    }];
    fs.rmSync(path.join(dir, fx.FX_CACHE_FILE), { force: true });
    await execution.reconcileAgentOwnedFills({
      getOverseasTodayExecutions: async () => [{
        orderDate: '20261110', orderNo: '88', branchNo: '1', stockCode: 'NVDA',
        filledQuantity: 1, averageFillPrice: 99,
      }],
    });
    assert.equal(state.vtsOrders[0].fxRateStatus, 'UNAVAILABLE');
    assert.equal(state.vtsOrders[0].fxUsdKrw, undefined);
  });

  await testAsync('reconcile reweights FX when a US order fills in two slices', async () => {
    fx.writeUsdKrwSnapshot({
      rate: 1470, capturedAt: new Date().toISOString(), source: 'DUNAMU', status: 'AVAILABLE',
    });
    state.vtsOrders = [{
      id: 'partial-us', timestamp: new Date().toISOString(), orderDate: '20990101',
      market: 'US_NASDAQ', stockCode: 'AAPL', stockName: 'Apple', side: 'BUY',
      quantity: 3, filledQuantity: 0, referencePrice: 100, averageFillPrice: undefined,
      status: 'SUBMITTED', kisOrderNo: '99', kisBranchNo: '1', ownershipScope: 'AGENT_CREATED_ONLY',
    }];
    await execution.reconcileAgentOwnedFills({
      getOverseasTodayExecutions: async () => [{
        orderDate: '20990101', orderNo: '99', branchNo: '1', stockCode: 'AAPL',
        filledQuantity: 1, averageFillPrice: 100,
      }],
    });
    assert.equal(state.vtsOrders[0].filledQuantity, 1);
    assert.equal(state.vtsOrders[0].fxUsdKrw, 1470);
    fx.writeUsdKrwSnapshot({
      rate: 1350, capturedAt: new Date().toISOString(), source: 'DUNAMU', status: 'AVAILABLE',
    });
    await execution.reconcileAgentOwnedFills({
      getOverseasTodayExecutions: async () => [{
        orderDate: '20990101', orderNo: '99', branchNo: '1', stockCode: 'AAPL',
        filledQuantity: 3, averageFillPrice: 100,
      }],
    });
    assert.equal(state.vtsOrders[0].filledQuantity, 3);
    assert.equal(state.vtsOrders[0].status, 'FILLED');
    assert.equal(state.vtsOrders[0].fxUsdKrw, (1470 * 1 + 1350 * 2) / 3);
  });

  test('virtual comparison ledger records fill FX; sizing still uses 1,500', () => {
    const book = emptyBook();
    const target = { market: 'US_NASDAQ', stockCode: 'AAPL', stockName: 'Apple' };
    const signal = { side: 'BUY', reason: 'fixture', signalDate: '20260909', confidence: 100, buyScore: 100, sellScore: 0, stopFraction: 0.05 };
    const news = { side: 'HOLD', reason: '뉴스 검토 완료', fresh: true, matches: [], evidenceIds: [] };
    const obs = { target, signal, news, price: 100, previousClose: 100, at: '2026-09-10T14:00:00.000Z', usdKrw: 1470 };
    advanceShadow(book, obs, 'price');
    advanceShadow(book, { ...obs, at: '2026-09-10T14:01:00.000Z' }, 'price');
    const lot = book.positions['US_NASDAQ:AAPL'];
    assert.ok(lot.quantity * 150150 <= 4500000);
    assert.equal(lot.buyFxUsdKrw, 1470);
    assert.equal(lot.fxStatus, 'RECORDED');
    assert.equal(book.usFills[0].fxUsdKrw, 1470);
    const later = emptyBook();
    advanceShadow(later, { ...obs, usdKrw: undefined, at: '2026-09-10T14:00:00.000Z' }, 'price');
    advanceShadow(later, { ...obs, usdKrw: undefined, at: '2026-09-10T14:01:00.000Z' }, 'price');
    assert.equal(later.usFills[0].fxStatus, 'UNAVAILABLE');
    const legacy = pnl.usFxPnlFromFills([], { AAPL: 100 }, {
      rate: 1300, capturedAt: '2026-09-10T14:01:00.000Z', source: 'DUNAMU', status: 'AVAILABLE',
    });
    assert.equal(legacy.open.length, 0);
  });

  console.log(JSON.stringify({ passed, externalOrders: 0 }));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  global.fetch = realFetch;
  fs.rmSync(dir, { recursive: true, force: true });
});
