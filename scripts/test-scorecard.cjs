const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLoader } = require('./lib/load-source.cjs');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kis-scorecard-test-'));
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
const sc = load('src/lib/scorecard.ts');
const { evaluatePaperOrder } = load('src/lib/rule-engine.ts');
const { state } = load('src/lib/store.ts');

const day = (i) => new Date(Date.UTC(2025, 0, 1) + i * 86400_000).toISOString().slice(0, 10).replaceAll('-', '');
const rising = Array.from({ length: 260 }, (_, i) => ({ date: day(i), close: 100 + i * 0.2 }));
const tech = sc.technicalLevels(rising);
const plus = (reason = 'test') => ({ score: 1, reason });
const unknown = { score: 'UNKNOWN', reason: 'missing' };
const allPlus = () => ({ fundamentals: plus(), flows: plus(), technical: plus(), news: plus(), macro: plus() });
const clearEvents = { fomc: 'CLEAR', earnings: 'CLEAR', detail: 'ok' };
const base = (over = {}) => ({ market: 'DOMESTIC', stockCode: '005930', stockName: '삼성전자', price: tech.lastClose * 1.005,
  views: allPlus(), technical: tech, stopFraction: 0.05, holding: null,
  portfolio: { heldNames: 0, maxNames: 5, nameWeight: 0, maxNameFraction: 0.10 }, events: clearEvents, ...over });

check('technical levels need 200 completed bars; uses 20/60/200 MA and 52w', () => {
  assert.equal(sc.technicalLevels(rising.slice(0, 199)), null);
  assert.equal(sc.scoreTechnical(null).score, 'UNKNOWN');
  assert.equal(sc.scoreTechnical(tech).score, 1);
  assert.ok(tech.ma20 > tech.ma60 && tech.ma60 > tech.ma200 && tech.high52w === tech.lastClose);
});
check('news isolation: price/chart fields are dropped and cannot change the news score', () => {
  const headlines = ['삼성전자 실적 컨센서스 상회'];
  const a = sc.scoreNews({ fresh: true, directHeadlines: headlines });
  const b = sc.scoreNews({ fresh: true, directHeadlines: headlines, price: 1, previousClose: 999, signal: { side: 'SELL' }, technical: -1 });
  const c = sc.scoreNews({ fresh: true, directHeadlines: headlines, price: 999, signal: { side: 'BUY' } });
  assert.deepEqual(a, b); assert.deepEqual(a, c); assert.equal(a.score, 1);
  assert.deepEqual(Object.keys(sc.newsOnly({ fresh: true, directHeadlines: [], price: 5, bars: [] })).sort(), ['directHeadlines', 'fresh']);
  assert.equal(sc.scoreNews({ fresh: true, directHeadlines: [], signal: { side: 'BUY' } }).score, 0);
});
check('missing data is unknown, never 0', () => {
  assert.equal(sc.scoreNews({ fresh: false, directHeadlines: ['x'] }).score, 'UNKNOWN');
  assert.equal(sc.scoreFundamentals(null).score, 'UNKNOWN');
  assert.equal(sc.scoreFundamentals({ per: null, pbr: 1, marketCapKrw: 1e12 }).score, 'UNKNOWN');
  assert.equal(sc.scoreFlows({ foreignNetKrw: 1, institutionNetKrw: null, days: 5 }).score, 'UNKNOWN');
  assert.equal(sc.scoreMacro({ vix: 15, usdKrwChange20dPct: null, us10yChange20dBp: 0 }).score, 'UNKNOWN');
});
check('all-positive, unfiltered, not held => 매수검토 => BUY', () => {
  const card = sc.decideScorecard(base());
  assert.equal(card.conclusion, '매수검토'); assert.equal(sc.conclusionToOrderSide(card.conclusion), 'BUY');
  assert.ok(card.entryPrice > 0 && card.stopLoss > 0 && card.stopLoss < card.entryPrice && card.invalidation.length > 0);
  assert.ok(card.bullCase.startsWith('매수 이유') && card.bearCase.startsWith('안 할 이유'));
});
check('one unknown still decides; two unknown => 보류 regardless of scores', () => {
  assert.notEqual(sc.decideScorecard(base({ views: { ...allPlus(), macro: unknown } })).conclusion, '보류');
  const card = sc.decideScorecard(base({ views: { ...allPlus(), macro: unknown, flows: unknown } }));
  assert.equal(card.conclusion, '보류'); assert.ok(card.filters.includes('TWO_OR_MORE_UNKNOWN'));
  const held = sc.decideScorecard(base({ views: { ...allPlus(), macro: unknown, news: unknown }, holding: { quantity: 3, averagePrice: tech.lastClose * 0.9 } }));
  assert.equal(held.conclusion, '보류');
});
check('filter: FOMC day / unknown FOMC overrides perfect scores', () => {
  assert.equal(sc.decideScorecard(base({ events: { fomc: 'BLOCKED', earnings: 'CLEAR', detail: 'f' } })).conclusion, '보류');
  assert.equal(sc.decideScorecard(base({ events: { fomc: 'UNKNOWN', earnings: 'CLEAR', detail: 'f' } })).conclusion, '보류');
});
check('filter: earnings eve / unknown earnings overrides perfect scores', () => {
  const card = sc.decideScorecard(base({ events: { fomc: 'CLEAR', earnings: 'BLOCKED', detail: 'e' } }));
  assert.equal(card.conclusion, '보류'); assert.ok(card.filters.includes('EARNINGS_EVE'));
  assert.ok(sc.decideScorecard(base({ events: { fomc: 'CLEAR', earnings: 'UNKNOWN', detail: 'e' } })).filters.includes('EARNINGS_DATE_UNKNOWN'));
});
check('filter: no chasing (>3% above last close or >8% above MA20) => 관망', () => {
  const card = sc.decideScorecard(base({ price: tech.lastClose * 1.05 }));
  assert.equal(card.conclusion, '관망'); assert.ok(card.filters.includes('NO_CHASING'));
});
check('filter: no averaging down when held below cost => 보유, never 추가매수', () => {
  const card = sc.decideScorecard(base({ holding: { quantity: 3, averagePrice: tech.lastClose * 1.04 }, stopFraction: 0.08 }));
  assert.equal(card.conclusion, '보유'); assert.ok(card.filters.includes('NO_AVERAGING_DOWN'));
});
check('filter: protective stop uses completed close => 전량매도', () => {
  const card = sc.decideScorecard(base({ holding: { quantity: 3, averagePrice: tech.lastClose / 0.9 }, stopFraction: 0.05 }));
  assert.equal(card.conclusion, '전량매도'); assert.ok(card.filters.includes('PROTECTIVE_STOP_ON_CLOSE'));
  // intraday price below stop but close above => not stopped
  const intraday = sc.decideScorecard(base({ price: tech.lastClose * 0.5, holding: { quantity: 3, averagePrice: tech.lastClose }, stopFraction: 0.05 }));
  assert.ok(!intraday.filters.includes('PROTECTIVE_STOP_ON_CLOSE'));
});
check('filter: full portfolio => 관망', () => {
  assert.equal(sc.decideScorecard(base({ portfolio: { heldNames: 5, maxNames: 5, nameWeight: 0, maxNameFraction: 0.1 } })).conclusion, '관망');
});
check('conclusion -> order mapping is conservative', () => {
  const expected = { 매수검토: 'BUY', 조건부매수: 'HOLD', 보유: 'HOLD', 추가매수: 'HOLD', 일부매도: 'HOLD', 전량매도: 'SELL', 관망: 'HOLD', 보류: 'HOLD' };
  assert.deepEqual(Object.fromEntries(sc.CONCLUSIONS.map((c) => [c, sc.conclusionToOrderSide(c)])), expected);
  assert.equal(sc.CONCLUSIONS.length, 8);
});
check('event calendar: FOMC dates and earnings eve; outside coverage is unknown', () => {
  const cal = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'event-calendar.json'), 'utf8'));
  assert.equal(sc.eventStatus(cal, 'US_NASDAQ', 'AAPL', '20261209').fomc, 'BLOCKED');
  assert.equal(sc.eventStatus(cal, 'DOMESTIC', '005930', '20261210').fomc, 'BLOCKED');
  assert.equal(sc.eventStatus(cal, 'DOMESTIC', '005930', '20261110').fomc, 'CLEAR');
  assert.equal(sc.eventStatus(cal, 'DOMESTIC', '005930', '20270105').fomc, 'UNKNOWN');
  assert.equal(sc.eventStatus(cal, 'DOMESTIC', '005930', '20261110').earnings, 'UNKNOWN');
  const withE = { ...cal, earnings: { 'DOMESTIC:005930': { verifiedThrough: '20261231', dates: ['20261116'] } } };
  assert.equal(sc.eventStatus(withE, 'DOMESTIC', '005930', '20261113').earnings, 'BLOCKED'); // Friday before Monday earnings
  assert.equal(sc.eventStatus(withE, 'DOMESTIC', '005930', '20261110').earnings, 'CLEAR');
  assert.equal(sc.eventStatus(null, 'DOMESTIC', '005930', '20261110').fomc, 'UNKNOWN');
});
check('SAFE_LOCKED still blocks a 매수검토 BUY at the rule engine', () => {
  const card = sc.decideScorecard(base());
  const side = sc.conclusionToOrderSide(card.conclusion);
  const def = evaluatePaperOrder({ market: 'DOMESTIC', side, confidence: 100, price: card.entryPrice });
  assert.equal(def.allowed, false);
  state.prepared = true; state.settings.killSwitchEnabled = true;
  const locked = evaluatePaperOrder({ market: 'DOMESTIC', side, confidence: 100, price: card.entryPrice });
  assert.equal(locked.allowed, false);
  console.log('  gate reason:', def.reason, '/', locked.reason);
  assert.equal(evaluatePaperOrder({ market: 'DOMESTIC', side: 'HOLD', confidence: 100, price: 1 }).reason, 'HOLD_SIGNAL');
});
check('live decision engine version differs from legacy so ledgers never mix', () => {
  assert.notEqual(sc.DECISION_ENGINE_VERSION, sc.LEGACY_DECISION_ENGINE_VERSION);
  assert.equal(load('src/lib/strategy.ts').STRATEGY_VERSION, sc.LEGACY_DECISION_ENGINE_VERSION);
});
check('cutover marker written once and never overwritten', () => {
  const data = load('src/lib/scorecard-data.ts');
  const first = data.recordDecisionEngineCutover('2026-11-06T07:00:00.000Z');
  const second = data.recordDecisionEngineCutover('2027-01-01T00:00:00.000Z');
  assert.equal(second.cutoverAt, first.cutoverAt);
  assert.equal(data.decisionEngineCutover().cutoverAt, '2026-11-06T07:00:00.000Z');
  assert.equal(data.scorecardData('DOMESTIC', '005930').symbol, null); // no cache => unknown views
});
console.log(`${checks} scorecard checks passed`);
fs.rmSync(testDir, { recursive: true, force: true });
