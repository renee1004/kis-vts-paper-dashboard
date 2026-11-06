/**
 * 5-perspective scorecard that decides VTS paper orders (replaces the legacy trend signal
 * as the live paper-order decision). Pure functions only: no I/O, no order placement.
 * Every conclusion still goes through rule-engine/safety (SAFE_LOCKED) gates downstream.
 * Procedure reference: TradingAgents (analyst views -> bull/bear -> risk -> decision); no code reused.
 */
import type { TradingMarket } from "./domain";
import type { DailyBar } from "./strategy";
import { headlineDirection } from "./news-model";

export const DECISION_ENGINE_VERSION = "scorecard-5view-v3-paper-unvalidated";
export const LEGACY_DECISION_ENGINE_VERSION = "trend-breakout-v2-capital30m-unvalidated";

export type ViewScore = 1 | 0 | -1 | "UNKNOWN";
export type Perspective = "fundamentals" | "flows" | "technical" | "news" | "macro";
export const PERSPECTIVES: Perspective[] = ["fundamentals", "flows", "technical", "news", "macro"];
export const CONCLUSIONS = ["매수검토", "조건부매수", "보유", "추가매수", "일부매도", "전량매도", "관망", "보류"] as const;
export type Conclusion = (typeof CONCLUSIONS)[number];

export interface ViewResult { score: ViewScore; reason: string }
export interface FundamentalsInput { per: number | null; pbr: number | null; marketCapKrw: number | null }
export interface FlowsInput { foreignNetKrw: number | null; institutionNetKrw: number | null; days: number }
export interface MacroInput { vix: number | null; usdKrwChange20dPct: number | null; us10yChange20dBp: number | null }
/** Headline-only input. Deliberately has no price/chart fields. */
export interface NewsOnlyInput { fresh: boolean; directHeadlines: string[] }

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

export function scoreFundamentals(f: FundamentalsInput | null): ViewResult {
  if (!f || !finite(f.per) || !finite(f.pbr) || !finite(f.marketCapKrw) || f.marketCapKrw <= 0)
    return { score: "UNKNOWN", reason: "PER·PBR·시가총액 데이터 없음" };
  if (f.marketCapKrw < 100_000_000_000) return { score: -1, reason: "시가총액 1,000억 원 미만(유동성 위험)" };
  if (f.per <= 0 || f.per > 40 || f.pbr > 5) return { score: -1, reason: `적자 또는 고평가 (PER ${f.per.toFixed(1)}, PBR ${f.pbr.toFixed(2)})` };
  if (f.per <= 15 && f.pbr > 0 && f.pbr <= 1.5) return { score: 1, reason: `저평가 구간 (PER ${f.per.toFixed(1)}, PBR ${f.pbr.toFixed(2)})` };
  return { score: 0, reason: `중립 밸류에이션 (PER ${f.per.toFixed(1)}, PBR ${f.pbr.toFixed(2)})` };
}

export function scoreFlows(f: FlowsInput | null): ViewResult {
  if (!f || !finite(f.foreignNetKrw) || !finite(f.institutionNetKrw)) return { score: "UNKNOWN", reason: "외국인·기관 순매수 데이터 없음" };
  if (f.foreignNetKrw > 0 && f.institutionNetKrw > 0) return { score: 1, reason: `최근 ${f.days}일 외국인·기관 동반 순매수` };
  if (f.foreignNetKrw < 0 && f.institutionNetKrw < 0) return { score: -1, reason: `최근 ${f.days}일 외국인·기관 동반 순매도` };
  return { score: 0, reason: `최근 ${f.days}일 외국인·기관 방향 엇갈림` };
}

export interface TechnicalLevels { lastClose: number; prevClose: number; ma20: number; ma60: number; ma200: number; high52w: number; low52w: number; lastDate: string }
export function technicalLevels(bars: DailyBar[]): TechnicalLevels | null {
  const ok = bars.filter((b) => /^\d{8}$/.test(b.date) && finite(b.close) && b.close > 0);
  if (ok.length < 200) return null;
  const closes = ok.map((b) => b.close), year = ok.slice(-250);
  return { lastClose: closes.at(-1)!, prevClose: closes.at(-2)!, ma20: mean(closes.slice(-20)), ma60: mean(closes.slice(-60)),
    ma200: mean(closes.slice(-200)), high52w: Math.max(...year.map((b) => b.close)), low52w: Math.min(...year.map((b) => b.low ?? b.close)), lastDate: ok.at(-1)!.date };
}
export function scoreTechnical(t: TechnicalLevels | null): ViewResult {
  if (!t) return { score: "UNKNOWN", reason: "완료 일봉 200개 미만" };
  if (t.lastClose > t.ma20 && t.ma20 > t.ma60 && t.ma60 > t.ma200 && t.lastClose >= t.high52w * 0.85)
    return { score: 1, reason: "종가>20일>60일>200일선 정배열, 52주 고점 15% 이내" };
  if (t.lastClose < t.ma60 && t.ma20 < t.ma60) return { score: -1, reason: "종가·20일선이 60일선 아래" };
  return { score: 0, reason: "이평선 혼조" };
}

/**
 * News view. Structurally isolated: it re-picks only the headline fields so any price/chart
 * values a caller passes are dropped before scoring.
 */
export function newsOnly(input: unknown): NewsOnlyInput {
  const raw = (input ?? {}) as Record<string, unknown>;
  const headlines = Array.isArray(raw.directHeadlines) ? raw.directHeadlines.filter((h): h is string => typeof h === "string") : [];
  return { fresh: raw.fresh === true, directHeadlines: headlines.slice(0, 20) };
}
export function scoreNews(input: unknown): ViewResult {
  const n = newsOnly(input);
  if (!n.fresh) return { score: "UNKNOWN", reason: "종목 뉴스 수집 실패·지연" };
  const dirs = n.directHeadlines.map((h) => headlineDirection(h).direction);
  const pos = dirs.filter((d) => d === "POSITIVE").length, neg = dirs.filter((d) => d === "NEGATIVE").length;
  if (pos && !neg) return { score: 1, reason: `직접 긍정 제목 ${pos}건(가설)` };
  if (neg && !pos) return { score: -1, reason: `직접 부정 제목 ${neg}건(가설)` };
  return { score: 0, reason: pos && neg ? "긍정·부정 제목 충돌" : "명확한 직접 뉴스 없음" };
}

export function scoreMacro(m: MacroInput | null): ViewResult {
  if (!m || !finite(m.vix) || !finite(m.usdKrwChange20dPct) || !finite(m.us10yChange20dBp)) return { score: "UNKNOWN", reason: "환율·금리·VIX 중 데이터 없음" };
  if (m.vix >= 30 || m.usdKrwChange20dPct >= 3 || m.us10yChange20dBp >= 40) return { score: -1, reason: `위험회피 (VIX ${m.vix.toFixed(1)}, 원달러 20일 ${m.usdKrwChange20dPct.toFixed(1)}%, 미10년 ${m.us10yChange20dBp.toFixed(0)}bp)` };
  if (m.vix < 20 && m.usdKrwChange20dPct < 1 && m.us10yChange20dBp < 15) return { score: 1, reason: `우호적 (VIX ${m.vix.toFixed(1)})` };
  return { score: 0, reason: `중립 (VIX ${m.vix.toFixed(1)})` };
}

export type EventStatus = "CLEAR" | "BLOCKED" | "UNKNOWN";
export interface ScorecardInput {
  market: TradingMarket; stockCode: string; stockName: string; price: number | null;
  views: Record<Perspective, ViewResult>;
  technical: TechnicalLevels | null;
  stopFraction: number;
  holding: { quantity: number; averagePrice: number } | null;
  portfolio: { heldNames: number; maxNames: number; nameWeight: number | null; maxNameFraction: number };
  events: { fomc: EventStatus; earnings: EventStatus; detail: string };
}
export interface Scorecard {
  version: string; conclusion: Conclusion; views: Record<Perspective, ViewResult>;
  knownTotal: number; unknownCount: number; filters: string[];
  bullCase: string; bearCase: string; portfolioNote: string;
  entryPrice: number | null; stopLoss: number | null; invalidation: string;
}

const won = (v: number) => v.toLocaleString("ko-KR", { maximumFractionDigits: 2 });

export function decideScorecard(input: ScorecardInput): Scorecard {
  const views = input.views;
  const known = PERSPECTIVES.filter((p) => views[p].score !== "UNKNOWN");
  const unknownCount = PERSPECTIVES.length - known.length;
  const knownTotal = known.reduce((s, p) => s + (views[p].score as number), 0);
  const pos = PERSPECTIVES.filter((p) => views[p].score === 1), neg = PERSPECTIVES.filter((p) => views[p].score === -1);
  const labels: Record<Perspective, string> = { fundamentals: "펀더멘털", flows: "수급", technical: "기술적", news: "뉴스", macro: "거시" };
  const bullCase = pos.length ? `매수 이유: ${pos.map((p) => `${labels[p]}(${views[p].reason})`).join(", ")}` : "매수 이유: 뚜렷한 긍정 관점 없음";
  const bearCase = neg.length ? `안 할 이유: ${neg.map((p) => `${labels[p]}(${views[p].reason})`).join(", ")}` : unknownCount ? `안 할 이유: 미확인 관점 ${unknownCount}개` : "안 할 이유: 뚜렷한 부정 관점 없음";
  const t = input.technical, price = input.price;
  const held = !!input.holding && input.holding.quantity > 0;
  const filters: string[] = [];
  const stopBase = held ? input.holding!.averagePrice : price ?? 0;
  const stopLoss = stopBase > 0 ? stopBase * (1 - input.stopFraction) : null;
  const portfolioNote = `보유 ${input.portfolio.heldNames}/${input.portfolio.maxNames}종목 · 종목비중 ${input.portfolio.nameWeight == null ? "미확인" : (input.portfolio.nameWeight * 100).toFixed(1) + "%"} (한도 ${(input.portfolio.maxNameFraction * 100).toFixed(0)}%) · 레버리지·인버스 상품은 매수 금지(3~5% 한도보다 엄격)`;
  const base = { version: DECISION_ENGINE_VERSION, views, knownTotal, unknownCount, filters, bullCase, bearCase, portfolioNote };
  const out = (conclusion: Conclusion, invalidation: string, entry: number | null = price): Scorecard =>
    ({ ...base, conclusion, entryPrice: entry, stopLoss, invalidation });

  // Protective line on completed close (never intraday).
  if (held && t && stopLoss && t.lastClose <= stopLoss) {
    filters.push("PROTECTIVE_STOP_ON_CLOSE");
    return out("전량매도", `종가 ${won(t.lastClose)} ≤ 보호선 ${won(stopLoss)}`, null);
  }
  if (unknownCount >= 2) { filters.push("TWO_OR_MORE_UNKNOWN"); return out("보류", "미확인 관점 데이터가 채워질 때까지 판단 보류", null); }
  if (!finite(price) || price <= 0 || !t) { filters.push("PRICE_OR_BARS_MISSING"); return out("보류", "현재가·일봉 확인 후 재판단", null); }

  if (held) {
    const exitInvalid = `종가가 20일선 ${won(t.ma20)} 위로 회복하면 매도 판단이 틀린 것`;
    if (input.events.fomc === "BLOCKED") { filters.push("FOMC_DAY"); return out("보류", input.events.detail, null); }
    if (views.technical.score === -1 && knownTotal <= -2) return out("전량매도", exitInvalid, null);
    if (views.technical.score === -1 || knownTotal <= -1) return out("일부매도", exitInvalid, null);
    const wantsAdd = knownTotal >= 3 && views.technical.score === 1;
    if (wantsAdd && price < input.holding!.averagePrice) { filters.push("NO_AVERAGING_DOWN"); return out("보유", `평균단가 ${won(input.holding!.averagePrice)} 아래 추가매수(물타기) 금지 · 종가 ${stopLoss ? won(stopLoss) : "-"} 이탈 시 틀림`); }
    if (wantsAdd && input.portfolio.nameWeight != null && input.portfolio.nameWeight < input.portfolio.maxNameFraction && input.events.earnings === "CLEAR")
      return out("추가매수", `종가가 20일선 ${won(t.ma20)} 아래로 마감하면 틀림`);
    return out("보유", `종가 보호선 ${stopLoss ? won(stopLoss) : "-"} 이탈 시 틀림`);
  }

  // Not held: rule filters override scores.
  if (input.events.fomc !== "CLEAR") { filters.push(input.events.fomc === "BLOCKED" ? "FOMC_DAY" : "FOMC_DATE_UNKNOWN"); return out("보류", input.events.detail, null); }
  if (input.events.earnings !== "CLEAR") { filters.push(input.events.earnings === "BLOCKED" ? "EARNINGS_EVE" : "EARNINGS_DATE_UNKNOWN"); return out("보류", input.events.detail, null); }
  if (price / t.ma20 > 1.08 || price / t.lastClose > 1.03) { filters.push("NO_CHASING"); return out("관망", `20일선 대비 ${((price / t.ma20 - 1) * 100).toFixed(1)}% · 전일 대비 ${((price / t.lastClose - 1) * 100).toFixed(1)}% 추격 금지`, null); }
  if (input.portfolio.heldNames >= input.portfolio.maxNames) { filters.push("PORTFOLIO_FULL"); return out("관망", "보유 종목 수 한도", null); }
  const invalid = `종가가 20일선 ${won(t.ma20)} 아래로 마감하거나 손절선 ${stopLoss ? won(stopLoss) : "-"} 이탈`;
  if (views.technical.score === 1 && knownTotal >= 3 && neg.length === 0) return out("매수검토", invalid);
  if (views.technical.score !== -1 && knownTotal >= 2) return out("조건부매수", `조건: 기술적 +1과 부정 관점 0개 확인 후 · ${invalid}`);
  return out("관망", "합계 점수 부족");
}

/** Conservative mapping: only clear conclusions may request a paper order. */
export function conclusionToOrderSide(c: Conclusion): "BUY" | "SELL" | "HOLD" {
  if (c === "매수검토") return "BUY";
  if (c === "전량매도") return "SELL";
  return "HOLD"; // 조건부매수/추가매수(무피라미딩)/일부매도(부분청산 미지원)/보유/관망/보류
}

/** FOMC/earnings status for a market date. Dates outside verified coverage are UNKNOWN. */
export interface EventCalendar {
  fomc: { verifiedFrom: string; verifiedThrough: string; blackout: Record<TradingMarket, string[]> };
  earnings: Record<string, { verifiedThrough: string; dates: string[] }>;
}
const nextDays = (d: string, n: number) => {
  const t = Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8));
  return Array.from({ length: n }, (_, i) => new Date(t + (i + 1) * 86400_000).toISOString().slice(0, 10).replaceAll("-", ""));
};
export function eventStatus(cal: EventCalendar | null, market: TradingMarket, stockCode: string, marketDate: string): ScorecardInput["events"] {
  if (!cal || !/^\d{8}$/.test(marketDate)) return { fomc: "UNKNOWN", earnings: "UNKNOWN", detail: "이벤트 달력 없음: 보류" };
  const f = cal.fomc;
  const fomc: EventStatus = marketDate < f.verifiedFrom || marketDate > f.verifiedThrough ? "UNKNOWN"
    : (f.blackout[market] ?? []).includes(marketDate) ? "BLOCKED" : "CLEAR";
  const e = cal.earnings[`${market}:${stockCode}`];
  // Day before earnings (= next weekday is the earnings date) and the earnings day itself.
  const nextWeekday = nextDays(marketDate, 7).find((x) => { const w = new Date(Date.UTC(+x.slice(0, 4), +x.slice(4, 6) - 1, +x.slice(6, 8))).getUTCDay(); return w !== 0 && w !== 6; })!;
  const earnings: EventStatus = !e || marketDate > e.verifiedThrough || nextWeekday > e.verifiedThrough ? "UNKNOWN"
    : e.dates.some((d) => d === marketDate || d === nextWeekday) ? "BLOCKED" : "CLEAR";
  const detail = fomc === "BLOCKED" ? "FOMC 당일 매매 금지" : fomc === "UNKNOWN" ? "FOMC 일정 미확인: 보류"
    : earnings === "BLOCKED" ? "실적 발표 전날·당일 매매 금지" : earnings === "UNKNOWN" ? "실적 발표일 미확인: 보류" : "이벤트 필터 통과";
  return { fomc, earnings, detail };
}
