const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLoader } = require('./lib/load-source.cjs');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kis-scorecard-ref-'));
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
const sc = load('src/lib/scorecard.ts');
const data = load('src/lib/scorecard-data.ts');
const root = path.join(__dirname, '..');

const day = (i) => new Date(Date.UTC(2025, 0, 1) + i * 86400_000).toISOString().slice(0, 10).replaceAll('-', '');
const rising = Array.from({ length: 260 }, (_, i) => ({ date: day(i), close: 100 + i * 0.2 }));
const tech = sc.technicalLevels(rising);
const plus = (reason = 'test') => ({ score: 1, reason });
const allPlus = () => ({ fundamentals: plus(), flows: plus(), technical: plus(), news: plus(), macro: plus() });
const base = (over = {}) => ({ market: 'DOMESTIC', stockCode: '005930', stockName: '삼성전자', price: tech.lastClose * 1.005,
  views: allPlus(), technical: tech, stopFraction: 0.05, holding: null,
  portfolio: { heldNames: 0, maxNames: 5, nameWeight: 0, maxNameFraction: 0.10 },
  events: { fomc: 'CLEAR', earnings: 'CLEAR', detail: 'ok' }, ...over });
const snapshot = (card) => ({
  conclusion: card.conclusion, filters: card.filters, knownTotal: card.knownTotal, unknownCount: card.unknownCount,
  views: Object.fromEntries(Object.entries(card.views).map(([k, v]) => [k, { score: v.score, reason: v.reason }])),
  bullCase: card.bullCase, bearCase: card.bearCase, entryPrice: card.entryPrice, stopLoss: card.stopLoss,
  invalidation: card.invalidation, orderSide: sc.conclusionToOrderSide(card.conclusion), version: card.version,
});

check('PSR and crude-oil fields do not change view scores, conclusions, filters, or order side', () => {
  const fund = { per: 10, pbr: 1, marketCapKrw: 1e12, source: 'NAVER' };
  assert.deepEqual(sc.scoreFundamentals(fund), sc.scoreFundamentals({ ...fund, psr: 0.2, psrSource: 'NAVER' }));
  assert.deepEqual(sc.scoreFundamentals(fund), sc.scoreFundamentals({ ...fund, psr: 99, psrSource: 'KIS' }));
  assert.deepEqual(sc.scoreFundamentals(fund), sc.scoreFundamentals({ ...fund, psr: null, psrSource: 'unknown' }));
  const macro = { vix: 15, usdKrwChange20dPct: 0.2, us10yChange20dBp: 5 };
  assert.deepEqual(sc.scoreMacro(macro), sc.scoreMacro({ ...macro, lastClose: 80, ma20: 78, ma60: 70, trend: '상승', laggedChange40dPct: 12 }));
  const clean = snapshot(sc.decideScorecard(base()));
  const dirty = snapshot(sc.decideScorecard(base({
    references: { psr: { psr: 0.01, source: 'NAVER' } },
    crudeOil: { lastClose: 999, trend: '하락', laggedChange40dPct: -50, source: 'FDR' },
  })));
  assert.deepEqual(clean, dirty);
  assert.equal(clean.conclusion, '매수검토');
  assert.equal(clean.orderSide, 'BUY');
  assert.equal(sc.SCORECARD_VERSION, 'scorecard-5view-v3-paper-unvalidated');
});

check('scoringFundamentals / scoringMacro drop reference fields', () => {
  const f = sc.scoringFundamentals({ per: 12, pbr: 1.1, marketCapKrw: 5e12, source: 'KIS', psr: 1.4, psrSource: 'KIS', at: 'x' });
  assert.deepEqual(f, { per: 12, pbr: 1.1, marketCapKrw: 5e12, source: 'KIS' });
  const m = sc.scoringMacro({ vix: 18, usdKrwChange20dPct: 0, us10yChange20dBp: 1, lastClose: 80, trend: '상승' });
  assert.deepEqual(m, { vix: 18, usdKrwChange20dPct: 0, us10yChange20dBp: 1 });
});

check('referencePsr records source per value and unknown when missing', () => {
  assert.deepEqual(sc.referencePsr(null), { psr: null, source: 'unknown' });
  assert.deepEqual(sc.referencePsr({ per: 10, psrSource: 'NAVER' }), { psr: null, source: 'unknown' });
  assert.deepEqual(sc.referencePsr({ psr: 1.25, psrSource: 'NAVER' }), { psr: 1.25, source: 'NAVER' });
  assert.deepEqual(sc.referencePsr({ psr: 1.25 }), { psr: 1.25, source: 'unknown' });
});

check('crudeOilFromBars 20/60 trend and 40-trading-day lagged change', () => {
  const up = Array.from({ length: 80 }, (_, i) => ({ date: day(i), close: 50 + i * 0.5 }));
  const down = Array.from({ length: 80 }, (_, i) => ({ date: day(i), close: 100 - i * 0.4 }));
  const mixed = Array.from({ length: 80 }, (_, i) => ({ date: day(i), close: i < 60 ? 100 - i : 40 + (i - 60) * 2 }));
  const oilUp = sc.crudeOilFromBars(up, 'FDR', 'CL=F');
  assert.equal(oilUp.trend, '상승');
  assert.equal(oilUp.source, 'FDR');
  assert.equal(oilUp.symbol, 'CL=F');
  assert.equal(oilUp.lagTradingDays, 40);
  assert.ok(oilUp.laggedChange40dPct > 0);
  assert.equal(oilUp.laggedChange40dPct.toFixed(6), ((up[79].close / up[79 - 40].close - 1) * 100).toFixed(6));
  assert.equal(sc.crudeOilFromBars(down, 'YFINANCE', 'CL=F').trend, '하락');
  assert.equal(sc.crudeOilFromBars(mixed, 'FDR', 'CL=F').trend, '혼조');
  assert.equal(sc.crudeOilFromBars([], 'FDR', 'CL=F').source, 'unknown');
});

check('collected PSR / crudeOil are exposed as references but stripped from scoring inputs', () => {
  const generatedAt = new Date().toISOString();
  const fund = { per: 10, pbr: 1, marketCapKrw: 1e12, asOf: '2026-11-07', source: 'NAVER' };
  const flows = { foreignNetKrw: 1e9, institutionNetKrw: 1e9, days: 5, asOf: '20261106', source: 'NAVER' };
  const macro = { vix: 15, usdKrwChange20dPct: 0.2, us10yChange20dBp: 5, asOf: '2026-11-07' };
  const bars = rising.slice(-250);
  let stamp = Date.now();
  const write = (payload) => {
    const file = path.join(testDir, 'scorecard-data.json');
    fs.writeFileSync(file, JSON.stringify(payload));
    stamp += 1000;
    fs.utimesSync(file, stamp / 1000, stamp / 1000);
  };
  write({ version: 1, generatedAt, symbols: { 'DOMESTIC:005930': { bars, fundamentals: fund, flows, isEtf: false } }, macro });
  const without = data.scorecardData('DOMESTIC', '005930');
  const viewsWithout = {
    fundamentals: sc.scoreFundamentals(without.symbol.fundamentals),
    flows: sc.scoreFlows(without.symbol.flows),
    technical: sc.scoreTechnical(sc.technicalLevels(without.symbol.bars)),
    news: sc.scoreNews({ fresh: true, directHeadlines: ['삼성전자 실적 컨센서스 상회'] }),
    macro: sc.scoreMacro(without.macro),
  };
  const cardWithout = snapshot(sc.decideScorecard(base({ views: viewsWithout, technical: sc.technicalLevels(without.symbol.bars), price: sc.technicalLevels(without.symbol.bars).lastClose })));
  write({
    version: 1, generatedAt, macro: { ...macro, oilPollute: 1 },
    crudeOil: { lastClose: 80.5, ma20: 78, ma60: 70, trend: '상승', laggedChange40dPct: 11.2, lagTradingDays: 40, asOf: '20261106', source: 'FDR', symbol: 'CL=F' },
    symbols: { 'DOMESTIC:005930': { bars, fundamentals: { ...fund, psr: 1.25, psrSource: 'NAVER' }, flows, isEtf: false } },
  });
  const withRefs = data.scorecardData('DOMESTIC', '005930');
  const viewsWith = {
    fundamentals: sc.scoreFundamentals(withRefs.symbol.fundamentals),
    flows: sc.scoreFlows(withRefs.symbol.flows),
    technical: sc.scoreTechnical(sc.technicalLevels(withRefs.symbol.bars)),
    news: sc.scoreNews({ fresh: true, directHeadlines: ['삼성전자 실적 컨센서스 상회'] }),
    macro: sc.scoreMacro(withRefs.macro),
  };
  const cardWith = snapshot(sc.decideScorecard(base({ views: viewsWith, technical: sc.technicalLevels(withRefs.symbol.bars), price: sc.technicalLevels(withRefs.symbol.bars).lastClose })));
  assert.deepEqual(viewsWithout, viewsWith);
  assert.deepEqual(cardWithout, cardWith);
  assert.equal('psr' in (withRefs.symbol.fundamentals || {}), false);
  assert.equal('oilPollute' in (withRefs.macro || {}), false);
  assert.equal(withRefs.symbol.psr.psr, 1.25);
  assert.equal(withRefs.symbol.psr.source, 'NAVER');
  assert.equal(withRefs.crudeOil.trend, '상승');
  assert.equal(withRefs.crudeOil.source, 'FDR');
  assert.equal(without.crudeOil.source, 'unknown');
  assert.equal(without.symbol.psr.source, 'unknown');
  write({ version: 1, generatedAt, symbols: { 'DOMESTIC:005930': { bars, fundamentals: { ...fund, psr: 'N/A', psrSource: 'NAVER' }, flows, isEtf: false } }, macro, crudeOil: 'bad' });
  const malformed = data.scorecardData('DOMESTIC', '005930');
  assert.deepEqual(sc.scoreFundamentals(malformed.symbol.fundamentals), viewsWithout.fundamentals);
  assert.deepEqual(sc.scoreMacro(malformed.macro), viewsWithout.macro);
  assert.equal(malformed.symbol.psr.source, 'unknown');
  assert.equal(malformed.crudeOil.source, 'unknown');
});

check('decideScorecard / score views / vts-execution / agent order path ignore PSR and crude oil', () => {
  const scoreSrc = fs.readFileSync(path.join(root, 'src/lib/scorecard.ts'), 'utf8');
  const decide = scoreSrc.split('export function decideScorecard')[1].split('export function conclusionToOrderSide')[0];
  assert.equal(/psr|crudeOil|WTI|CL=F|priceToSales/i.test(decide), false);
  const fundFn = scoreSrc.split('export function scoreFundamentals')[1].split('export function scoreFlows')[0];
  assert.equal(/psr|sales|crude|oil|wti/i.test(fundFn), false);
  const macroFn = scoreSrc.split('export function scoreMacro')[1].split('export type EventStatus')[0];
  assert.equal(/psr|crude|oil|wti|CL=F/i.test(macroFn), false);
  const agent = fs.readFileSync(path.join(root, 'src/lib/agent.ts'), 'utf8');
  assert.equal(agent.includes('conclusionToOrderSide'), false);
  assert.ok(agent.includes('livePaperOrderIntent(signal)'));
  const build = agent.split('function buildScorecard')[1].split('export async function runAgentCycle')[0];
  const beforeDecide = build.split('const card = decideScorecard')[0];
  const afterDecide = build.split('const card = decideScorecard')[1];
  assert.equal(/psr|crudeOil/i.test(beforeDecide), false);
  assert.ok(afterDecide.includes('references:'));
  assert.ok(beforeDecide.includes('displayFundamentals('));
  assert.ok(beforeDecide.includes('kisFund ? { ...kisFund, source: "KIS" } : data.symbol?.fundamentals ?? null'));
  assert.ok(beforeDecide.includes('dartFundamentals(item.market, item.stockCode)'));
  assert.ok(beforeDecide.includes('scoreMacro(data.macro)'));
  const vts = fs.readFileSync(path.join(root, 'src/lib/vts-execution.ts'), 'utf8');
  assert.equal(/psr|crudeOil|WTI|CL=F|priceToSales/i.test(vts), false);
  const panel = fs.readFileSync(path.join(root, 'src/components/scorecard-panel.tsx'), 'utf8');
  assert.ok(panel.includes('참고 (미검증)'));
  assert.ok(panel.includes('PSR(주가매출비율)'));
  assert.ok(panel.includes('원유(WTI)'));
  const collect = fs.readFileSync(path.join(root, 'scripts/scorecard-collect.py'), 'utf8');
  assert.ok(collect.includes('priceToSalesTrailing12Months'));
  assert.ok(collect.includes('CL=F'));
  assert.ok(collect.includes('psrSource'));
  assert.ok(collect.includes('crudeOil'));
});

console.log(`${checks} scorecard-reference checks passed`);
fs.rmSync(testDir, { recursive: true, force: true });
