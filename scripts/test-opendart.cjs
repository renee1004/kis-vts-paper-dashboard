const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createLoader } = require('./lib/load-source.cjs');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kis-opendart-'));
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
process.env.DART_API_KEY = 'test-dart-key-not-real';
delete global.__vtsPaperState;

let checks = 0;
const check = (name, run) => { run(); checks++; console.log('PASS', name); };
const load = createLoader();
const sc = load('src/lib/scorecard.ts');
const dart = load('src/lib/dart-data.ts');
const data = load('src/lib/scorecard-data.ts');
const { DEFAULT_SAFETY_SETTINGS } = load('src/lib/domain.ts');
const { livePaperOrderIntent } = load('src/lib/strategy.ts');
const root = path.join(__dirname, '..');
const today = dart.kstDate();
const yesterday = new Date(Date.now() - 86400_000);
const yesterdayKst = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(yesterday);

const growing = {
  stockCode: '005930', ok: true, reason: null,
  revenue: 120, operatingIncome: 30, netIncome: 18,
  revenueYoyPct: 20, operatingIncomeYoyPct: 50, netIncomeYoyPct: 50,
  debtRatioPct: 50, roePct: 22.5, asOf: '20251231', reportName: '사업보고서',
  source: 'OPENDART', earningsDates: ['20260312', '20260515', '20260730'],
  estimatedNextDate: '20270126', verifiedThrough: '20270126',
};
const loss = {
  ...growing, stockCode: '000660', netIncome: -8, operatingIncome: -2,
  revenueYoyPct: -25, operatingIncomeYoyPct: -40, netIncomeYoyPct: -80, roePct: -4,
};
const valuation = { per: 10, pbr: 1, marketCapKrw: 1e12, source: 'NAVER' };

function writeDart(payload) {
  const file = path.join(testDir, 'dart-fundamentals.json');
  fs.writeFileSync(file, JSON.stringify(payload));
  const stamp = Date.now() / 1000 + Math.random();
  fs.utimesSync(file, stamp, stamp);
}

function cache(over = {}) {
  return {
    version: 1, generatedAt: new Date().toISOString(), cacheDate: today,
    displayOnly: true, doesNotAffectOrders: true, source: 'opendartreader', license: 'MIT',
    status: 'ok', reason: null,
    symbols: { 'DOMESTIC:005930': growing },
    ...over,
  };
}

check('missing cache is 미확인 with an explicit reason, not a crash', () => {
  const view = dart.dartFundamentals('DOMESTIC', '005930');
  assert.equal(view.financials, null);
  assert.match(view.reason, /DART 캐시 없음/);
  assert.equal(sc.displayFundamentals(null, view, { market: 'DOMESTIC' }).score, 'UNKNOWN');
  assert.match(sc.displayFundamentals(null, view, { market: 'DOMESTIC' }).reason, /DART 캐시 없음/);
  assert.equal(dart.dartCacheView().status, '미확인');
});

check('missing DART_API_KEY payload stays 미확인 and does not score 0', () => {
  writeDart(cache({ status: '미확인', reason: 'DART_API_KEY 없음', symbols: {} }));
  const view = dart.dartFundamentals('DOMESTIC', '005930');
  assert.equal(view.financials, null);
  assert.equal(view.reason, 'DART_API_KEY 없음');
  const scored = sc.displayFundamentals(null, view, { market: 'DOMESTIC' });
  assert.equal(scored.score, 'UNKNOWN');
  assert.equal(scored.reason, 'DART_API_KEY 없음');
});

check('fetch failure reason is shown; API key is redacted', () => {
  writeDart(cache({
    status: '미확인',
    reason: 'OpenDartReader(): 401 crtfc_key=test-dart-key-not-real',
    symbols: {},
  }));
  const view = dart.dartFundamentals('DOMESTIC', '005930');
  assert.equal(view.score, undefined);
  assert.equal(view.financials, null);
  assert.match(view.reason, /REDACTED/);
  assert.equal(view.reason.includes('test-dart-key-not-real'), false);
  assert.equal(dart.redactDartText('crtfc_key=test-dart-key-not-real leaked').includes('test-dart-key-not-real'), false);
});

check('all-symbol API failure is 미확인 even if placeholder rows were written as status ok', () => {
  writeDart(cache({
    status: 'ok', reason: null,
    errors: ['finstate 005930: HTTPError: 401 crtfc_key=test-dart-key-not-real'],
    symbols: { 'DOMESTIC:005930': { ...growing, ok: false, reason: 'DART 재무제표 없음', revenue: null, revenueYoyPct: null, operatingIncome: null, netIncome: null, operatingIncomeYoyPct: null, netIncomeYoyPct: null, debtRatioPct: null, roePct: null } },
  }));
  const view = dart.dartFundamentals('DOMESTIC', '005930');
  assert.equal(view.financials, null);
  assert.match(view.reason, /REDACTED|조회 실패|HTTPError/);
  assert.equal(view.reason.includes('재무제표 없음'), false);
  assert.equal(view.reason.includes('test-dart-key-not-real'), false);
  assert.equal(dart.dartCacheView().status, '미확인');
});

check('stale (not today) cache is 미확인 and does not present yesterday numbers as fresh', () => {
  writeDart(cache({ cacheDate: yesterdayKst, generatedAt: yesterday.toISOString() }));
  const view = dart.dartFundamentals('DOMESTIC', '005930');
  assert.equal(view.financials, null);
  assert.match(view.reason, /오래됨/);
  assert.equal(sc.scoreDartFinancials(view.financials, view.reason).score, 'UNKNOWN');
  const overlay = dart.dartEarningsOverlay();
  assert.deepEqual(overlay, {});
});

check('fresh DART financials score +1 / -1 / 0 and fill domestic 미확인 valuation', () => {
  writeDart(cache({
    symbols: { 'DOMESTIC:005930': growing, 'DOMESTIC:000660': loss },
  }));
  const good = dart.dartFundamentals('DOMESTIC', '005930');
  assert.equal(good.financials.revenueYoyPct, 20);
  assert.equal(sc.scoreDartFinancials(good.financials).score, 1);
  assert.ok(sc.scoreDartFinancials(good.financials).reason.includes('[OPENDART]'));
  assert.equal(sc.displayFundamentals(null, good, { market: 'DOMESTIC' }).score, 1);
  const bad = dart.dartFundamentals('DOMESTIC', '000660');
  assert.equal(sc.displayFundamentals(null, bad, { market: 'DOMESTIC' }).score, -1);
  const mixed = sc.scoreDartFinancials({
    revenue: 10, operatingIncome: 1, netIncome: 1,
    revenueYoyPct: 5, operatingIncomeYoyPct: -2, netIncomeYoyPct: 1,
    debtRatioPct: 80, roePct: 9, source: 'OPENDART',
  });
  assert.equal(mixed.score, 0);
});

check('KIS/Naver PER·PBR still win; DART extras cannot change scoreFundamentals', () => {
  writeDart(cache());
  const dartView = dart.dartFundamentals('DOMESTIC', '005930');
  const fromValuation = sc.scoreFundamentals(valuation);
  assert.equal(fromValuation.score, 1);
  assert.deepEqual(sc.displayFundamentals(valuation, dartView, { market: 'DOMESTIC' }), fromValuation);
  assert.deepEqual(
    sc.scoreFundamentals(valuation),
    sc.scoreFundamentals({ ...valuation, revenueYoyPct: 99, roePct: 80, debtRatioPct: 9, psr: 0.1 }),
  );
  assert.equal(sc.displayFundamentals(null, dartView, { market: 'US_NASDAQ' }).score, 'UNKNOWN');
  assert.equal(sc.displayFundamentals(null, dartView, { market: 'DOMESTIC', isEtf: true }).score, 'UNKNOWN');
});

check('fresh DART earnings overlay fills unknown domestic dates; manual entries still win', () => {
  writeDart(cache());
  const cal = data.eventCalendar();
  assert.equal(cal.earnings['DOMESTIC:005930'].source, 'auto:opendart');
  assert.ok(cal.earnings['DOMESTIC:005930'].dates.includes('20260730'));
  assert.ok(cal.fomc.blackout.US_NASDAQ.includes('20261209'));
  fs.writeFileSync(path.join(testDir, 'event-calendar-auto.json'), JSON.stringify({
    earnings: { 'DOMESTIC:005930': { dates: ['20260101'], verifiedThrough: '20260101', source: 'auto:yfinance' } },
  }));
  const merged = data.eventCalendar();
  assert.equal(merged.earnings['DOMESTIC:005930'].source, 'auto:opendart');
});

check('US symbols stay on the valuation path; DART does not invent overseas financials', () => {
  writeDart(cache());
  const view = dart.dartFundamentals('US_NASDAQ', 'AAPL');
  assert.equal(view.financials, null);
  assert.match(view.reason, /국내/);
});

check('live order helpers ignore DART views; real-order flags stay off', () => {
  const buy = { side: 'BUY', reason: 'trend', confidence: 80, stopFraction: 0.05, buyScore: 3, sellScore: 0, signalDate: '20261111' };
  const dartSell = { conclusion: '전량매도', views: { fundamentals: sc.scoreDartFinancials(growing) } };
  assert.equal(livePaperOrderIntent(buy, dartSell).side, 'BUY');
  assert.deepEqual(livePaperOrderIntent(buy, dartSell), livePaperOrderIntent(buy));
  assert.equal(DEFAULT_SAFETY_SETTINGS.allowRealDomesticOrder, false);
  assert.equal(DEFAULT_SAFETY_SETTINGS.allowRealOverseasOrder, false);
});

check('collector/order sources: DART is a research sidecar and is not imported by the order path', () => {
  const req = fs.readFileSync(path.join(root, 'scripts/requirements-data.txt'), 'utf8');
  assert.match(req, /opendartreader==0\.2\.2;\s*python_version < "3\.13"/);
  assert.match(req, /opendartreader==0\.3\.3;\s*python_version >= "3\.13"/);
  const py = fs.readFileSync(path.join(root, 'scripts/opendart-fundamentals.py'), 'utf8');
  assert.match(py, /DART_API_KEY/);
  assert.match(py, /redact/);
  assert.match(py, /cacheDate/);
  assert.match(py, /doesNotAffectOrders/);
  assert.match(py, /getattr\(\s*\w+\s*,\s*['"]OpenDartReader['"]/);
  assert.match(py, /make_opendart_client/);
  assert.equal(/OpenDartReader\.OpenDartReader\(\s*key\s*\)/.test(py.split('def self_check')[0]), false);
  assert.equal(/print\(.*DART_API_KEY/.test(py), false);
  assert.equal(/KIS_APP_KEY|KIS_APP_SECRET/.test(py), false);
  const collect = fs.readFileSync(path.join(root, 'scripts/scorecard-collect.py'), 'utf8');
  assert.match(collect, /opendart-fundamentals\.py/);
  const orderFiles = [
    'src/lib/safety.ts', 'src/lib/vts-execution.ts', 'src/lib/strategy.ts',
    'src/lib/rule-engine.ts', 'src/lib/market-hours.ts', 'src/lib/market-calendar.ts',
    'src/lib/kis-vts-client.ts',
  ];
  const banned = /opendart-fundamentals|OpenDartReader|dart-data|displayFundamentals|scoreDartFinancials/;
  for (const file of orderFiles) {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    assert.equal(banned.test(src), false, file);
  }
  const agent = fs.readFileSync(path.join(root, 'src/lib/agent.ts'), 'utf8');
  const orderBlock = agent.split('const intent = livePaperOrderIntent(signal)')[1].split('function buildScorecard')[0];
  assert.equal(/dartFundamentals|displayFundamentals|dart-data/.test(orderBlock), false);
  assert.ok(agent.includes('displayFundamentals('));
  assert.ok(agent.includes('dartFundamentals(item.market, item.stockCode)'));
  assert.equal(agent.includes('conclusionToOrderSide'), false);
  const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  assert.match(gitignore, /^\.env\*/m);
  const panel = fs.readFileSync(path.join(root, 'src/components/scorecard-panel.tsx'), 'utf8');
  assert.match(panel, /Open DART 재무/);
  assert.match(panel, /주문 게이트 아님/);
});

const py = spawnSync('python3', [path.join(root, 'scripts/opendart-fundamentals.py'), '--self-check'], {
  encoding: 'utf8', cwd: root, env: { ...process.env, DART_API_KEY: 'test-dart-key-not-real' },
});
check('python --self-check parses fixtures without a network or installed OpenDartReader', () => {
  assert.equal(py.status, 0, py.stderr || py.stdout);
  assert.equal((py.stdout || '').includes('test-dart-key-not-real'), false);
  const parsed = JSON.parse(py.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.revenueYoyPct, 20);
  assert.deepEqual(parsed.aprilFirst, [2026, '11013', '1분기보고서']);
  assert.deepEqual(parsed.novFirst, [2026, '11014', '3분기보고서']);
  assert.deepEqual(parsed.clientShapes, ['class', 'module']);
});

console.log(`${checks} opendart checks passed`);
fs.rmSync(testDir, { recursive: true, force: true });
