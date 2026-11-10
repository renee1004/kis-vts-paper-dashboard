const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLoader } = require('./lib/load-source.cjs');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kis-live-decision-'));
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
let checks = 0;
const check = (name, run) => { run(); checks++; console.log('PASS', name); };
const load = createLoader();
const strategy = load('src/lib/strategy.ts');
const sc = load('src/lib/scorecard.ts');
const data = load('src/lib/scorecard-data.ts');
const execution = load('src/lib/vts-execution.ts');
const { DEFAULT_SAFETY_SETTINGS } = load('src/lib/domain.ts');
const root = path.join(__dirname, '..');
const bars = Array.from({ length: 80 }, (_, i) => ({
  date: new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10).replaceAll('-', ''),
  close: 100 + i * 0.1,
}));
const buy = strategy.analyzeTrend(bars);
const sell = strategy.analyzeTrend(bars.map((b, i) => ({ ...b, close: 200 - i })));
const hold = strategy.analyzeTrend(bars.slice(0, 64));
const scorecardSell = {
  conclusion: '전량매도',
  references: { psr: { psr: 0.01, source: 'NAVER' }, crudeOil: { lastClose: 999, trend: '하락', laggedChange40dPct: -50 } },
};
const scorecardBuy = { conclusion: '매수검토', psr: 99, crudeOil: { trend: '상승' }, wti: 80 };

check('live paper-order engine is restored trend-breakout-v2, not the scorecard', () => {
  assert.equal(strategy.STRATEGY_VERSION, 'trend-breakout-v2-capital30m-unvalidated');
  assert.equal(strategy.DECISION_ENGINE_VERSION, strategy.STRATEGY_VERSION);
  assert.equal(sc.SCORECARD_VERSION, 'scorecard-5view-v3-paper-unvalidated');
  assert.notEqual(strategy.DECISION_ENGINE_VERSION, sc.SCORECARD_VERSION);
  assert.equal(execution.VTS_ORDER_LIMITS.strategyVersion, strategy.STRATEGY_VERSION);
  assert.equal(DEFAULT_SAFETY_SETTINGS.allowRealDomesticOrder, false);
  assert.equal(DEFAULT_SAFETY_SETTINGS.allowRealOverseasOrder, false);
});

check('BUY trend side/confidence/stop are unchanged by scorecard conclusions or PSR/WTI', () => {
  assert.equal(buy.side, 'BUY');
  assert.equal(sc.conclusionToOrderSide('전량매도'), 'SELL');
  assert.equal(sc.conclusionToOrderSide('일부매도'), 'HOLD');
  const clean = strategy.livePaperOrderIntent(buy);
  const polluted = strategy.livePaperOrderIntent(buy, scorecardSell);
  const partial = strategy.livePaperOrderIntent(buy, { conclusion: '일부매도', references: { psr: { psr: 12 } } });
  assert.equal(clean.side, 'BUY');
  assert.equal(polluted.side, 'BUY');
  assert.equal(partial.side, 'BUY');
  assert.deepEqual(polluted, clean);
  assert.equal(polluted.confidence, buy.confidence);
  assert.equal(polluted.stopFraction, buy.stopFraction);
  assert.equal(polluted.signalDate, buy.signalDate);
});

check('SELL trend side is unchanged by a 매수검토 scorecard conclusion', () => {
  assert.equal(sell.side, 'SELL');
  assert.equal(sc.conclusionToOrderSide('매수검토'), 'BUY');
  assert.equal(strategy.livePaperOrderIntent(sell, scorecardBuy).side, 'SELL');
});

check('HOLD trend stays HOLD even when scorecard would map 매수검토 to BUY', () => {
  assert.equal(hold.side, 'HOLD');
  assert.equal(strategy.livePaperOrderIntent(hold, { conclusion: '매수검토' }).side, 'HOLD');
});

check('restore marker overwrites the scorecard live version once and keeps the original cutoverAt', () => {
  fs.writeFileSync(path.join(testDir, 'decision-engine-cutover.json'), JSON.stringify({
    version: 'scorecard-5view-v3-paper-unvalidated',
    cutoverAt: '2026-11-06T07:00:00.000Z',
    previousVersion: 'trend-breakout-v2-capital30m-unvalidated',
  }));
  const first = data.recordDecisionEngineCutover('2026-11-10T00:00:00.000Z');
  assert.equal(first.version, 'trend-breakout-v2-capital30m-unvalidated');
  assert.equal(first.previousVersion, 'scorecard-5view-v3-paper-unvalidated');
  assert.equal(first.scorecardVersion, 'scorecard-5view-v3-paper-unvalidated');
  assert.equal(first.scorecardCutoverAt, '2026-11-06T07:00:00.000Z');
  assert.equal(first.cutoverAt, '2026-11-10T00:00:00.000Z');
  const second = data.recordDecisionEngineCutover('2027-01-01T00:00:00.000Z');
  assert.equal(second.cutoverAt, first.cutoverAt);
  assert.equal(second.restoredAt, first.restoredAt);
  assert.equal(second.scorecardCutoverAt, '2026-11-06T07:00:00.000Z');
});

check('agent order path uses trend intent; scorecard conclusions do not set side or quantity', () => {
  const agent = fs.readFileSync(path.join(root, 'src/lib/agent.ts'), 'utf8');
  const orderBlock = agent.split('const intent = livePaperOrderIntent(signal)')[1].split('function buildScorecard')[0];
  assert.ok(agent.includes('livePaperOrderIntent(signal)'));
  assert.equal(agent.includes('conclusionToOrderSide'), false);
  assert.ok(orderBlock.includes('side: intent.side'));
  assert.ok(orderBlock.includes('confidence: intent.confidence'));
  assert.ok(orderBlock.includes('stopFraction: intent.stopFraction'));
  assert.ok(orderBlock.includes('[STRATEGY_VERSION,'));
  assert.equal(/card\.conclusion|card\.stopFraction|card\.technicalDate|DECISION_ENGINE_VERSION/.test(orderBlock), false);
  const vts = fs.readFileSync(path.join(root, 'src/lib/vts-execution.ts'), 'utf8');
  assert.ok(vts.includes('strategyVersion: STRATEGY_VERSION'));
  assert.equal(/from ["']@\/lib\/scorecard["']/.test(vts), false);
  const panel = fs.readFileSync(path.join(root, 'src/components/scorecard-panel.tsx'), 'utf8');
  assert.ok(panel.includes('표시·연구 전용'));
  assert.equal(panel.includes('모의주문 판단은 점수판 결론으로 합니다'), false);
});

console.log(`${checks} live-decision checks passed`);
fs.rmSync(testDir, { recursive: true, force: true });
