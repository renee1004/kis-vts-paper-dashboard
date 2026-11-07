/* eslint-disable @typescript-eslint/no-require-imports */
// Research tool: prints new-buy scorecard judgments from the collected cache (no orders, no KIS calls).
// Usage: NEWS_DATA_DIR=<dir with news-research json> node scripts/scorecard-examples.cjs DOMESTIC:005930 US_NASDAQ:AAPL
const path = require('node:path');
const { createLoader } = require('./lib/load-source.cjs');
const dataDir = process.env.DATA_DIR || path.join(process.cwd(), '.data');
process.env.DATA_DIR = process.env.NEWS_DATA_DIR || dataDir;
const load = createLoader();
const news = load('src/lib/news-research.ts');
process.env.DATA_DIR = dataDir;
const sc = load('src/lib/scorecard.ts');
const data = load('src/lib/scorecard-data.ts');
const { completedBars, analyzeTrend } = load('src/lib/strategy.ts');
const { marketRiskLimits } = load('src/lib/trading-limits.ts');
const kst = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date()).replaceAll('-', '');
const et = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date()).replaceAll('-', '');
for (const arg of process.argv.slice(2)) {
  const [market, stockCode] = arg.split(':');
  const d = data.scorecardData(market, stockCode);
  const marketDate = market === 'US_NASDAQ' ? et : kst;
  const bars = completedBars(d.symbol?.bars ?? [], marketDate);
  const technical = sc.technicalLevels(bars);
  let headlines = { fresh: false, directHeadlines: [] };
  try { headlines = news.researchHeadlinesFor({ market, stockCode, stockName: stockCode }, []); } catch {}
  const views = { fundamentals: sc.scoreFundamentals(d.symbol?.fundamentals ?? null), flows: sc.scoreFlows(d.symbol?.flows ?? null),
    technical: sc.scoreTechnical(technical), news: sc.scoreNews(headlines), macro: sc.scoreMacro(d.macro) };
  const card = sc.decideScorecard({ market, stockCode, stockName: stockCode, price: technical?.lastClose ?? null, views, technical,
    stopFraction: analyzeTrend(bars.slice(-80)).stopFraction, holding: null,
    portfolio: { heldNames: 0, maxNames: 5, nameWeight: 0, maxNameFraction: marketRiskLimits(market).nameFraction },
    events: sc.eventStatus(data.eventCalendar(), market, stockCode, marketDate) });
  console.log(JSON.stringify({ symbol: arg, marketDate, priceUsed: 'last completed close', ...card,
    orderSide: sc.conclusionToOrderSide(card.conclusion),
    references: { psr: d.symbol?.psr ?? { psr: null, source: 'unknown' }, crudeOil: d.crudeOil },
    levels: technical && { ma20: +technical.ma20.toFixed(2), ma60: +technical.ma60.toFixed(2), ma200: +technical.ma200.toFixed(2), high52w: technical.high52w, low52w: technical.low52w } }, null, 1));
}
