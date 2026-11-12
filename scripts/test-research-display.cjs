const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLoader } = require('./lib/load-source.cjs');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kis-research-display-'));
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
delete global.__vtsPaperState;
let checks = 0;
const check = (name, run) => { run(); checks++; console.log('PASS', name); };
const load = createLoader();
const research = load('src/lib/research-display.ts');
const hours = load('src/lib/market-hours.ts');
const calendar = load('src/lib/market-calendar.ts');
const data = load('src/lib/scorecard-data.ts');
const { DEFAULT_SAFETY_SETTINGS, USD_KRW_SAFETY_RATE } = load('src/lib/domain.ts');
const root = path.join(__dirname, '..');

check('mismatch formatter matches the display contract', () => {
  assert.equal(
    research.formatCalendarMismatch({ date: '2026-11-19', dashboard: 'unknown', calendar: 'XKRX', reference: 'open' }),
    'calendar mismatch: 2026-11-19 dashboard=unknown, XKRX=open',
  );
  assert.equal(
    research.formatCalendarMismatch({ date: '2026-11-09', dashboard: 'closed', calendar: 'XKRX', reference: 'open' }),
    'calendar mismatch: 2026-11-09 dashboard=closed, XKRX=open',
  );
  assert.equal(research.formatResearchPct(null), '미확인');
  assert.equal(research.formatResearchPct(12.34), '12.3%');
});

check('2026-11-09 is a regular KRX trading day; isOpen is the session clock', () => {
  assert.equal(research.dashboardTradingDayStatus('DOMESTIC', '20261109'), 'open');
  assert.equal(research.dashboardTradingDayStatus('DOMESTIC', '20261009'), 'closed');
  assert.equal(research.dashboardTradingDayStatus('DOMESTIC', '20261119'), 'unknown');
  assert.equal(research.dashboardTradingDayStatus('DOMESTIC', '20270104'), 'open');
  assert.equal(research.dashboardTradingDayStatus('DOMESTIC', '20270503'), 'closed');
  assert.equal(research.dashboardTradingDayStatus('DOMESTIC', '20270719'), 'closed');
  assert.equal(research.dashboardTradingDayStatus('DOMESTIC', '20271118'), 'unknown');
  assert.equal(research.dashboardTradingDayStatus('DOMESTIC', '20280104'), 'unknown');
  const midday = calendar.marketSession('DOMESTIC', new Date('2026-11-09T01:00:00Z'));
  assert.equal(midday.known, true);
  assert.equal(midday.isOpen, true);
  assert.equal(hours.isDomesticRegularMarketOpen(new Date('2026-11-09T01:00:00Z')), true);
  const afterClose = calendar.marketSession('DOMESTIC', new Date('2026-11-09T07:40:00Z'));
  assert.equal(afterClose.known, true);
  assert.equal(afterClose.isOpen, false);
  assert.equal(hours.isDomesticRegularMarketOpen(new Date('2026-11-09T07:40:00Z')), false);
});

check('calendar-crosscheck JSON is reformatted and stale files become 미확인', () => {
  const generatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(testDir, 'calendar-crosscheck.json'), JSON.stringify({
    version: 1, generatedAt, displayOnly: true,
    window: { from: '2026-10-12', through: '2027-02-09' },
    mismatches: [
      { date: '2026-11-19', dashboard: 'unknown', calendar: 'XKRX', reference: 'open', market: 'DOMESTIC' },
      { date: '2027-01-04', dashboard: 'unknown', calendar: 'XKRX', reference: 'open', market: 'DOMESTIC', message: 'ignore-me' },
    ],
  }));
  const view = research.calendarCrosscheckView();
  assert.equal(view.stale, false);
  assert.deepEqual(view.messages, [
    'calendar mismatch: 2026-11-19 dashboard=unknown, XKRX=open',
    'calendar mismatch: 2027-01-04 dashboard=unknown, XKRX=open',
  ]);
  const old = new Date(Date.now() - 5 * 86400_000).toISOString();
  fs.writeFileSync(path.join(testDir, 'calendar-crosscheck.json'), JSON.stringify({
    version: 1, generatedAt: old, mismatches: [{ date: '2026-11-19', dashboard: 'unknown', calendar: 'XKRX', reference: 'open' }],
  }));
  fs.utimesSync(path.join(testDir, 'calendar-crosscheck.json'), Date.now() / 1000, Date.now() / 1000);
  const stale = research.calendarCrosscheckView();
  assert.equal(stale.stale, true);
  assert.deepEqual(stale.messages, []);
  fs.writeFileSync(path.join(testDir, 'calendar-crosscheck.json'), JSON.stringify({
    version: 1, generatedAt: new Date().toISOString(), mismatches: [],
    errors: ['import exchange_calendars: ModuleNotFoundError: No module named \'exchange_calendars\''],
  }));
  const failed = research.calendarCrosscheckView();
  assert.equal(failed.stale, false);
  assert.equal(failed.unavailable, true);
  assert.equal(failed.messages[0], research.CALENDAR_CHECK_UNAVAILABLE);
  assert.match(failed.messages[0], /대조 실패 \(미확인\)/);
});

check('risk-contribution JSON renders 미확인 for missing vol/RC and empty files', () => {
  assert.equal(research.riskContributionView().holdings.length, 0);
  fs.writeFileSync(path.join(testDir, 'risk-contribution.json'), JSON.stringify({
    version: 1, generatedAt: new Date().toISOString(), displayOnly: true, usdKrw: 1500,
    fxSource: 'FIXED_1500_NOT_ACTUAL_FX',
    holdings: [
      { market: 'DOMESTIC', stockCode: '005930', stockName: '삼성전자', evaluationKrw: 700000, weightPct: 70, volatilityPct: 28.1, riskContributionPct: 80, theme: '반도체' },
      { market: 'US_NASDAQ', stockCode: 'AAPL', stockName: 'Apple', evaluationKrw: 300000, weightPct: 30, volatilityPct: null, riskContributionPct: null, theme: null },
    ],
    groups: [{ theme: '반도체', weightPct: 70, riskContributionPct: 80 }, { theme: '미확인', weightPct: 30, riskContributionPct: null }],
    semiconductorWeightPct: 70, semiconductorRiskContributionPct: 80, riskSource: 'skfolio',
  }));
  const view = research.riskContributionView();
  assert.equal(view.holdings.length, 2);
  assert.equal(research.formatResearchPct(view.holdings[0].weightPct), '70.0%');
  assert.equal(research.formatResearchPct(view.holdings[1].volatilityPct), '미확인');
  assert.equal(research.formatResearchPct(view.holdings[1].theme ? 1 : null), '미확인');
  assert.equal(view.semiconductorWeightPct, 70);
  fs.writeFileSync(path.join(testDir, 'risk-contribution.json'), '{not json');
  assert.equal(research.riskContributionView().holdings.length, 0);
});

check('research holdings snapshot stores evaluation only and uses the app FX rate', () => {
  data.writeResearchHoldings({
    domestic: [{ stockCode: '005930', stockName: '삼성전자', evaluation: 100000, lastSyncedAt: '2026-11-11T01:00:00.000Z' }],
    overseas: [{ stockCode: 'NVDA', stockName: 'NVIDIA', evaluation: 10, currency: 'USD' }],
    usdKrw: USD_KRW_SAFETY_RATE, domesticSynced: true, overseasSynced: true,
  });
  const snapshot = JSON.parse(fs.readFileSync(path.join(testDir, 'research-holdings.json'), 'utf8'));
  assert.equal(snapshot.usdKrw, 1500);
  assert.equal(snapshot.fxSource, 'FIXED_1500_NOT_ACTUAL_FX');
  assert.equal(snapshot.holdings[1].evaluationKrw, 15000);
  assert.deepEqual(snapshot.syncedMarkets, ['DOMESTIC', 'US_NASDAQ']);
  assert.equal(JSON.stringify(snapshot).includes('account'), false);
  assert.equal(JSON.stringify(snapshot).includes('KIS_'), false);
});

check('failed balance sync does not stamp retained holdings as fresh', () => {
  const file = path.join(testDir, 'research-holdings.json');
  assert.equal(data.writeResearchHoldings({
    domestic: [{ stockCode: '005930', stockName: '삼성전자', evaluation: 1 }],
    overseas: [{ stockCode: 'NVDA', stockName: 'NVIDIA', evaluation: 1 }],
    usdKrw: USD_KRW_SAFETY_RATE, domesticSynced: false, overseasSynced: false,
  }), false);
  const skippedAt = JSON.parse(fs.readFileSync(file, 'utf8')).generatedAt;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  assert.equal(data.writeResearchHoldings({
    domestic: [{ stockCode: '005930', stockName: '삼성전자', evaluation: 200000 }],
    overseas: [{ stockCode: 'NVDA', stockName: 'NVIDIA', evaluation: 99 }],
    usdKrw: USD_KRW_SAFETY_RATE, domesticSynced: true, overseasSynced: false,
  }), true);
  const partial = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.notEqual(partial.generatedAt, skippedAt);
  assert.deepEqual(partial.syncedMarkets, ['DOMESTIC']);
  assert.equal(partial.holdings.length, 1);
  assert.equal(partial.holdings[0].stockCode, '005930');
  const agent = fs.readFileSync(path.join(root, 'src/lib/agent.ts'), 'utf8');
  const holdingsWrite = agent.split('writeResearchHoldings({')[1].split('});')[0];
  assert.ok(holdingsWrite.includes('domesticSynced'));
  assert.ok(holdingsWrite.includes('overseasSynced'));
});

check('order code paths do not import exchange_calendars, skfolio, or research collectors', () => {
  const orderFiles = [
    'src/lib/agent.ts', 'src/lib/safety.ts', 'src/lib/vts-execution.ts', 'src/lib/strategy.ts',
    'src/lib/rule-engine.ts', 'src/lib/market-hours.ts', 'src/lib/market-calendar.ts',
    'src/lib/kis-vts-client.ts',
  ];
  const banned = /skfolio|exchange_calendars|calendar-crosscheck|risk-contribution\.py|research-display/;
  for (const file of orderFiles) {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    assert.equal(banned.test(src), false, file);
  }
  const agent = fs.readFileSync(path.join(root, 'src/lib/agent.ts'), 'utf8');
  const orderBlock = agent.split('const intent = livePaperOrderIntent(signal)')[1].split('function buildScorecard')[0];
  assert.equal(/writeResearchHoldings|calendarCrosscheck|riskContribution/.test(orderBlock), false);
  assert.ok(agent.includes('writeResearchHoldings'));
  assert.equal(DEFAULT_SAFETY_SETTINGS.allowRealDomesticOrder, false);
  assert.equal(DEFAULT_SAFETY_SETTINGS.allowRealOverseasOrder, false);
  const panel = fs.readFileSync(path.join(root, 'src/components/scorecard-panel.tsx'), 'utf8');
  assert.ok(panel.includes('달력 불일치 (표시·연구 전용, 주문 게이트 아님)'));
  assert.ok(panel.includes('달력 대조 실패 (미확인)'));
  const riskPanel = fs.readFileSync(path.join(root, 'src/components/risk-contribution-panel.tsx'), 'utf8');
  assert.ok(riskPanel.includes('표시·연구 전용'));
  assert.ok(riskPanel.includes('미확인'));
});

console.log(`${checks} research-display checks passed`);
fs.rmSync(testDir, { recursive: true, force: true });
