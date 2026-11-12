const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLoader } = require('./lib/load-source.cjs');
const RealDate = Date;
const now = Date.parse('2026-11-09T01:00:00Z'); // KRX regular session
global.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
};
const realFetch = global.fetch;
global.fetch = async () => { throw Error('NETWORK_FORBIDDEN_IN_TEST'); };
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kis-investor-flow-order-'));
process.env.DATA_DIR = testDir;
process.env.KIS_APP_KEY = 'test-key-not-real';
process.env.KIS_APP_SECRET = 'test-secret-not-real';
process.env.KIS_ACCOUNT_NO = '00000000';
process.env.KIS_ACCOUNT_PRODUCT_CODE = '01';
process.env.KIS_BASE_URL = 'https://openapivts.koreainvestment.com:29443';
process.env.TRADING_MODE = 'DEMO';
process.env.ORDER_EXECUTION_MODE = 'VTS_MOCK';
process.env.ALLOW_REAL_DOMESTIC_ORDER = 'false';
process.env.ALLOW_REAL_OVERSEAS_ORDER = 'false';
process.env.KIS_ALLOW_REAL_FALLBACK = 'false';
delete global.__vtsPaperState;
delete global.__vtsAgentRunningCycle;
delete global.__vtsAgentTimer;
delete global.__kisFlows;
delete global.__kisFlowsFail;
delete global.__newsResearch;
const root = path.join(__dirname, '..');
const load = createLoader();
const { analyzeTrend } = load('src/lib/strategy.ts');
const { DEFAULT_SAFETY_SETTINGS } = load('src/lib/domain.ts');
const { NEWS_VERSION } = load('src/lib/news-model.ts');
const { state } = load('src/lib/store.ts');
const kis = load('src/lib/kis-vts-client.ts');
const { runAgentCycle } = load('src/lib/agent.ts');
let checks = 0;
const check = async (name, run) => { await run(); checks++; console.log('PASS', name); };

const bars = Array.from({ length: 80 }, (_, i) => ({
  date: new RealDate(Date.parse('2026-11-06T00:00:00Z') - (79 - i) * 86400_000)
    .toISOString().slice(0, 10).replaceAll('-', ''),
  close: 100 + i * 0.1,
}));
const lastClose = bars.at(-1).close;
const buy = analyzeTrend(bars);

function watchItem(stockCode, stockName) {
  return {
    id: stockCode, market: 'DOMESTIC', stockCode, stockName, currency: 'KRW', source: 'USER',
    candleStatus: 'PENDING', priceStatus: 'PENDING', analysis: 'HOLD',
    confidence: 0, buyScore: 0, sellScore: 0, blockedReason: '', currentPrice: null,
  };
}

function arm(codes) {
  const reviewed = { newsSide: 'HOLD', reason: '종목 뉴스 검토 완료', fresh: true, at: new Date().toISOString(), evidenceIds: [] };
  global.__newsResearch = {
    version: NEWS_VERSION, articles: [],
    decisions: Object.fromEntries(codes.map((code) => [`DOMESTIC:${code}`, reviewed])),
  };
  state.isRunning = true;
  state.prepared = true;
  state.sessionId = 'test-session';
  state.settings = {
    ...DEFAULT_SAFETY_SETTINGS,
    killSwitchEnabled: false,
    autoDomesticOrderEnabled: true,
    autoOverseasOrderEnabled: true,
    autoExitEnabled: false,
    pipelineTestEnabled: true,
    allowStrategyTestOrder: true,
  };
  state.vtsOrders = [];
  state.agentOwnedPositions = [];
  state.positions = [];
  state.overseasPositions = [];
  state.strategyRisk = { date: '', startPnl: 0 };
  state.logs = [];
  state.watchlist = codes.map((code, i) => watchItem(code, `Test${i}`));
  state.usWatchlist = [];
  state.balanceSnapshot = { cash: 30e6, totalEvaluation: 30e6, syncedAt: new Date().toISOString() };
  state.overseasBalanceSnapshot = { syncedAt: new Date().toISOString() };
  assert.equal(state.settings.allowRealDomesticOrder, false);
  assert.equal(state.settings.allowRealOverseasOrder, false);
}

function stubClient({ getInvestorFlows, submitMockOrder }) {
  const emptyDomestic = {
    positions: [], totalEvaluation: 30e6, stockEvaluation: 0, purchaseAmount: 0, profitLoss: 0, cash: 30e6,
  };
  const emptyOverseas = {
    positions: [], totalEvaluationUsd: 0, stockEvaluationUsd: 0, purchaseAmountUsd: 0, profitLossUsd: 0, cashUsd: 0,
  };
  kis.KisVtsClient.prototype.getBalance = async () => emptyDomestic;
  kis.KisVtsClient.prototype.getOverseasBalance = async () => emptyOverseas;
  kis.KisVtsClient.prototype.getPrice = async () => lastClose;
  kis.KisVtsClient.prototype.getDailyBars = async () => bars;
  kis.KisVtsClient.prototype.getInvestorFlows = getInvestorFlows;
  kis.KisVtsClient.prototype.submitMockOrder = submitMockOrder;
}

async function raceCycle(ms = 1500) {
  let settled = 'timeout';
  await Promise.race([
    runAgentCycle().then(() => { settled = 'completed'; }),
    new Promise((resolve) => setTimeout(resolve, ms)),
  ]);
  return settled;
}

(async () => {
  await check('fixture is a fresh trend-breakout-v2 BUY inside the 7-day candle window', () => {
    assert.equal(buy.side, 'BUY');
    assert.equal(buy.confidence, 100);
    const lastDate = bars.at(-1).date;
    const ageDays = (Date.now() - Date.parse(`${lastDate.slice(0, 4)}-${lastDate.slice(4, 6)}-${lastDate.slice(6, 8)}T00:00:00Z`)) / 86400_000;
    assert.ok(ageDays <= 7, `bar age ${ageDays}`);
    assert.equal(DEFAULT_SAFETY_SETTINGS.allowRealDomesticOrder, false);
    assert.equal(DEFAULT_SAFETY_SETTINGS.allowRealOverseasOrder, false);
  });

  await check('agent source evaluates livePaperOrderIntent before any getInvestorFlows await', () => {
    const agent = fs.readFileSync(path.join(root, 'src/lib/agent.ts'), 'utf8');
    const analyzeFn = agent.split('async function analyzeWatchlistItem')[1].split('function buildScorecard')[0];
    const cycle = agent.split('export async function runAgentCycle')[1];
    assert.ok(analyzeFn.includes('const intent = livePaperOrderIntent(signal)'));
    assert.ok(analyzeFn.includes('await executeVtsMockOrder'));
    assert.equal(analyzeFn.includes('getInvestorFlows'), false);
    assert.equal(analyzeFn.includes('refreshDisplayScorecard'), false);
    const usLoopAt = cycle.indexOf('for (const item of [...state.usWatchlist])');
    const refreshAt = cycle.indexOf('void refreshDisplayScorecards');
    assert.ok(usLoopAt >= 0 && refreshAt > usLoopAt);
    assert.ok(agent.includes('await client.getInvestorFlows'));
    const orderBlock = agent.split('const intent = livePaperOrderIntent(signal)')[1].split('function buildScorecard')[0];
    assert.equal(orderBlock.includes('getInvestorFlows'), false);
    assert.ok(orderBlock.includes('side: intent.side'));
  });

  await check('hung getInvestorFlows does not delay or skip paper-order submission', async () => {
    const events = [];
    const submitted = [];
    arm(['005930', '000660']);
    stubClient({
      getInvestorFlows: () => { events.push('flow'); return new Promise(() => {}); },
      submitMockOrder: async (request) => {
        events.push(`order:${request.stockCode}`);
        submitted.push(request);
        return { orderNo: `n-${request.stockCode}`, branchNo: '1' };
      },
    });
    const previousGetPrice = kis.KisVtsClient.prototype.getPrice;
    kis.KisVtsClient.prototype.getPrice = async () => { events.push('price'); return lastClose; };
    const settled = await raceCycle(1500);
    kis.KisVtsClient.prototype.getPrice = previousGetPrice;
    assert.equal(settled, 'completed', 'cycle must not await a never-resolving flow refresh');
    assert.deepEqual(submitted.map((r) => r.stockCode).sort(), ['000660', '005930']);
    assert.ok(submitted.every((r) => r.side === 'BUY' && r.quantity > 0));
    const firstFlow = events.indexOf('flow');
    const lastOrder = Math.max(events.lastIndexOf('order:005930'), events.lastIndexOf('order:000660'));
    const lastPrice = events.lastIndexOf('price');
    assert.equal(events.filter((e) => e.startsWith('order:')).length, 2);
    assert.equal(events.filter((e) => e === 'price').length, 2);
    assert.ok(firstFlow >= 0, 'display refresh still starts, but is not awaited');
    assert.ok(lastPrice < firstFlow, `price after flow: ${events.join(',')}`);
    assert.ok(lastOrder < firstFlow, `order after flow: ${events.join(',')}`);
  });

  await check('throwing getInvestorFlows still submits the trend-breakout-v2 order', async () => {
    const submitted = [];
    arm(['035420']);
    stubClient({
      getInvestorFlows: async () => { throw new Error('KIS_INVESTOR_TIMEOUT'); },
      submitMockOrder: async (request) => {
        submitted.push(request);
        return { orderNo: 'n-035420', branchNo: '1' };
      },
    });
    const settled = await raceCycle(1500);
    assert.equal(settled, 'completed');
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0].stockCode, '035420');
    assert.equal(submitted[0].side, 'BUY');
    assert.equal(state.settings.allowRealDomesticOrder, false);
    assert.equal(state.settings.allowRealOverseasOrder, false);
  });

  console.log(`${checks} investor-flow-order checks passed`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  global.Date = RealDate;
  global.fetch = realFetch;
  fs.rmSync(testDir, { recursive: true, force: true });
});
