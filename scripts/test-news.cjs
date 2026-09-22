const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLoader } = require('./lib/load-source.cjs');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kis-news-test-'));
process.env.DATA_DIR = directory;
const load = createLoader();
const { assessNews, matchNews, headlineDirection } = load('src/lib/news-model.ts');
const { parseNewsRss, safeNewsUrl, feedSpecs } = load('src/lib/news-feeds.ts');
const { emptyBook, advanceShadow, bookSummary } = load('src/lib/news-shadow.ts');
const target = { market: 'US_NASDAQ', stockCode: 'AAPL', stockName: 'Apple' };
const nvidia = { market: 'US_NASDAQ', stockCode: 'NVDA', stockName: 'Nvidia' };
const at = '2026-09-10T14:00:00.000Z'; // Thursday, 10:00 ET.
const before = '2026-09-10T13:00:00.000Z';
const signal = { side: 'BUY', confidence: 100, buyScore: 100, sellScore: 0, reason: 'fixture', signalDate: '20260909', stopFraction: 0.05 };
const article = { id: '1', title: 'Apple raises guidance', url: 'https://example.com/1', source: 'Fixture', feedId: 'US_NASDAQ:AAPL', publishedAt: before, firstSeenAt: before, official: false };
const feed = { id: 'US_NASDAQ:AAPL', label: 'Apple', lastAttemptAt: at, lastSuccessAt: at, error: null, count: 1 };
const input = { target, universe: [target, nvidia], articles: [article], feeds: [feed], signal, price: 100, previousClose: 100, at };
const observation = () => ({ target, signal, price: 100, previousClose: 100, at, news: assessNews(input) });
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS', name); }
const spec = { id: 'fixture', label: 'Fixture', official: false };
const rss = (title, date = before, link = 'https://example.com/1') => `<rss><channel><item><title><![CDATA[${title}]]></title><link>${link}</link><pubDate>${date}</pubDate><source>Fixture</source></item></channel></rss>`;
async function main() {
  test('RSS parses entities and strips source suffix', () => {
    const rows = parseNewsRss(rss('Apple raises guidance &amp; sales - Fixture'), spec, at);
    assert.equal(rows[0].title, 'Apple raises guidance & sales'); assert.equal(rows[0].firstSeenAt, at);
  });
  test('unknown dates, future and old articles excluded', () => {
    for (const date of ['invalid', '2026-09-11T00:00:00Z', '2026-09-01T00:00:00Z']) assert.equal(parseNewsRss(rss('Apple', date), spec, at).length, 0);
  });
  test('external entity documents and non-RSS error pages rejected', () => {
    assert.throws(() => parseNewsRss('<!DOCTYPE rss>' + rss('Apple'), spec, at));
    assert.throws(() => parseNewsRss('<html>error</html>', spec, at));
  });
  test('unsafe links excluded', () => {
    for (const url of ['javascript:alert(1)', 'http://example.com', 'https://user:secret@example.com/', 'https://127.0.0.1/', 'https://10.0.0.2/']) assert.equal(safeNewsUrl(url), null);
  });
  test('duplicated title/source has stable id across feeds', () => {
    assert.equal(parseNewsRss(rss('Apple raises guidance'), spec, at)[0].id, parseNewsRss(rss('Apple raises guidance'), { ...spec, id: 'other' }, at)[0].id);
  });
  test('US ticker matches whole token; company query is explicit', () => {
    assert.equal(matchNews({ ...article, title: 'Pineapple market outlook' }, target, [target]), null);
    assert.equal(feedSpecs([target]).at(-1).id, 'US_NASDAQ:AAPL');
  });
  test('fruit, river and medical meanings are not company mentions', () => {
    for (const title of ['Top Apple Varieties', 'Apple cider vinegar gummies', 'Does apple juice improve health?'])
      assert.equal(matchNews({ ...article, title }, target, [target]), null);
    const amazon = { ...target, stockCode: 'AMZN', stockName: 'Amazon' };
    assert.equal(matchNews({ ...article, title: 'Amazon river rainfall' }, amazon, [amazon]), null);
    const amd = { ...target, stockCode: 'AMD', stockName: 'AMD' };
    assert.equal(matchNews({ ...article, title: 'Treating AMD macular degeneration' }, amd, [amd]), null);
  });
  test('positive and negative headline classifications are hypotheses', () => {
    assert.equal(headlineDirection('Apple raises guidance').direction, 'POSITIVE');
    assert.equal(headlineDirection('Apple cuts guidance').direction, 'NEGATIVE');
    assert.equal(headlineDirection('삼성전자 실적 컨센서스 상회').direction, 'POSITIVE');
  });
  test('negation, speculation and mixed headlines do not pick a direction', () => {
    for (const title of ['Apple may raise guidance', 'Apple does not cut guidance', 'Apple raises guidance but cuts outlook', '삼성전자 계약 체결 가능성']) assert.equal(headlineDirection(title).direction, 'UNCERTAIN');
  });
  test('multi-company headline does not transfer direction', () => {
    assert.equal(matchNews({ ...article, title: 'Apple raises guidance while Nvidia cuts outlook' }, target, [target, nvidia]).direction, 'UNCERTAIN');
  });
  test('sector and macro matches cannot create direct positive evidence', () => {
    assert.equal(matchNews({ ...article, title: 'Semiconductor exports surge' }, nvidia, [nvidia]).relation, 'SECTOR');
    assert.equal(matchNews({ ...article, title: 'Federal Reserve interest rate decision' }, target, [target]).direction, 'UNCERTAIN');
  });
  test('first-seen timestamp prevents retroactive use', () => {
    assert.equal(assessNews({ ...input, articles: [{ ...article, firstSeenAt: '2026-09-10T14:01:00Z' }] }).side, 'HOLD');
  });
  test('absent, stale or failed feeds block news buys', () => {
    for (const feeds of [[], [{ ...feed, lastSuccessAt: before }], [{ ...feed, error: 'network error' }]]) assert.equal(assessNews({ ...input, feeds }).side, 'HOLD');
  });
  test('fresh direct positive needs price confirmation and no chase', () => {
    assert.equal(assessNews(input).side, 'BUY');
    assert.equal(assessNews({ ...input, price: 103 }).side, 'HOLD');
    assert.equal(assessNews({ ...input, price: 99 }).side, 'HOLD');
    assert.equal(assessNews({ ...input, signal: { ...signal, side: 'HOLD' } }).side, 'HOLD');
  });
  test('conflicting direct stories wait', () => {
    assert.equal(assessNews({ ...input, articles: [article, { ...article, id: '2', title: 'Apple cuts guidance' }] }).side, 'HOLD');
  });
  test('negative title needs price decline; existing price exits survive outages', () => {
    const articles = [{ ...article, title: 'Apple cuts guidance' }];
    assert.equal(assessNews({ ...input, articles, price: 99 }).side, 'SELL');
    assert.equal(assessNews({ ...input, articles }).side, 'HOLD');
    assert.equal(assessNews({ ...input, feeds: [], signal: { ...signal, side: 'SELL' } }).side, 'SELL');
  });
  test('shadow fill needs a later quote; replay cannot duplicate fill', () => {
    const book = emptyBook(), obs = observation();
    advanceShadow(book, obs, 'price'); assert.equal(book.fills, 0);
    const next = { ...obs, at: '2026-09-10T14:01:00Z' };
    advanceShadow(book, next, 'price'); assert.equal(book.fills, 1);
    advanceShadow(book, next, 'price'); assert.equal(book.fills, 1);
    assert.ok(book.feesKrw > 0); assert.ok(bookSummary(book).navKrw < 30_000_000);
    assert.ok(book.positions['US_NASDAQ:AAPL'].quantity * 150150 <= 4500000);
  });
  test('price and news books diverge only from news filter under identical prices', () => {
    const a = emptyBook(), b = emptyBook(), obs = { ...observation(), news: assessNews({ ...input, articles: [] }) };
    for (const time of [at, '2026-09-10T14:01:00Z']) { advanceShadow(a, { ...obs, at: time }, 'price'); advanceShadow(b, { ...obs, at: time }, 'news'); }
    assert.equal(a.fills, 1); assert.equal(b.fills, 0);
  });
  test('expired pending order and weekend do not fill', () => {
    const book = emptyBook(), obs = observation(); advanceShadow(book, obs, 'price');
    advanceShadow(book, { ...obs, at: '2026-09-10T14:16:00Z' }, 'price'); assert.equal(book.fills, 0);
    const weekend = emptyBook(); advanceShadow(weekend, { ...obs, at: '2026-09-12T14:00:00Z' }, 'price');
    assert.equal(Object.keys(weekend.pending).length, 0);
  });
  test('pending buy is cancelled if confirmation disappears', () => {
    const book = emptyBook(), obs = observation(); advanceShadow(book, obs, 'news');
    advanceShadow(book, { ...obs, at: '2026-09-10T14:01:00Z', news: { ...obs.news, side: 'HOLD', fresh: false } }, 'news');
    assert.equal(book.fills, 0);
  });
  test('SELL without virtual holdings cannot create short positions', () => {
    const book = emptyBook(), obs = observation();
    advanceShadow(book, { ...obs, signal: { ...signal, side: 'SELL' } }, 'price');
    assert.equal(Object.keys(book.pending).length, 0); assert.equal(book.cashKrw, 30_000_000);
  });
  test('risk exit remains active when news is unavailable', () => {
    const book = emptyBook(), obs = observation();
    advanceShadow(book, obs, 'news'); advanceShadow(book, { ...obs, at: '2026-09-10T14:01:00Z' }, 'news');
    advanceShadow(book, { ...obs, at: '2026-09-10T14:02:00Z', price: 90, news: { ...obs.news, side: 'HOLD', fresh: false } }, 'news');
    assert.equal(book.pending['US_NASDAQ:AAPL'].reason, 'VOLATILITY_STOP');
    advanceShadow(book, { ...obs, at: '2026-09-10T14:03:00Z', price: 90 }, 'news');
    assert.equal(book.closedLots, 1); assert.equal(Object.keys(book.positions).length, 0);
    assert.equal(Object.keys(book.pending).length, 0);
  });
  test('DST-aware US session accepts same local open in winter', () => {
    const book = emptyBook(), obs = observation();
    advanceShadow(book, { ...obs, at: '2026-12-10T14:00:00Z', signal: { ...signal, signalDate: '20261209' } }, 'price');
    assert.equal(Object.keys(book.pending).length, 0);
    advanceShadow(book, { ...obs, at: '2026-12-10T15:00:00Z', signal: { ...signal, signalDate: '20261209' } }, 'price');
    assert.equal(Object.keys(book.pending).length, 1);
  });
  const research = load('src/lib/news-research.ts');
  test('separate journal persists observation without broker state', () => {
    research.observeResearch({ ...input });
    assert.equal(research.researchView([target]).observations, 1);
    assert.equal(fs.existsSync(path.join(directory, 'state.json')), false);
    assert.ok(fs.existsSync(path.join(directory, 'news-research-capital30m-v2.json')));
  });
  test('restart preserves ledger and cancels pending simulated orders', () => {
    delete globalThis.__newsResearch;
    const view = research.researchView([target]);
    assert.equal(view.observations, 1); assert.equal(view.price.pending, 0);
  });
  test('corrupt research history fails closed without erasing it', () => {
    fs.writeFileSync(path.join(directory, 'news-research-capital30m-v2.json'), '{bad'); delete globalThis.__newsResearch;
    assert.throws(() => research.researchView([target]));
    assert.equal(fs.readFileSync(path.join(directory, 'news-research-capital30m-v2.json'), 'utf8'), '{bad');
  });
  console.log(JSON.stringify({ passed, externalOrders: 0, note: 'Fixtures only; does not establish profitability.' }));
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(directory, { recursive: true, force: true }));
