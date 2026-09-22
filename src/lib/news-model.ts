import type { TradingMarket } from "@/lib/domain";
import type { StrategySignal } from "@/lib/strategy";

export const NEWS_VERSION = "news-shadow-v2-capital30m-unvalidated";
export interface NewsTarget { market: TradingMarket; stockCode: string; stockName: string }
export interface NewsArticle {
  id: string; title: string; url: string; source: string; feedId: string;
  publishedAt: string; firstSeenAt: string; official: boolean;
}
export interface NewsFeed {
  id: string; label: string; lastAttemptAt: string; lastSuccessAt: string | null;
  error: string | null; count: number;
}
export interface NewsMatch {
  article: NewsArticle; relation: "DIRECT" | "SECTOR" | "MACRO";
  direction: "POSITIVE" | "NEGATIVE" | "UNCERTAIN"; reason: string;
}
export interface NewsAssessment {
  side: "BUY" | "SELL" | "HOLD"; reason: string; matches: NewsMatch[];
  evidenceIds: string[]; fresh: boolean;
}
export const targetKey = (t: NewsTarget) => `${t.market}:${t.stockCode}`;
const aliases: Record<string, string[]> = {
  "005930": ["삼성전자", "Samsung Electronics"], "005935": ["삼성전자우"],
  "000660": ["SK하이닉스", "SK hynix"], "035420": ["네이버", "NAVER"],
  "005380": ["현대차", "현대자동차", "Hyundai Motor"], "051910": ["LG화학", "LG Chem"],
  "006400": ["삼성SDI", "Samsung SDI"], "003670": ["포스코홀딩스", "POSCO Holdings"],
  "000720": ["현대건설"], "069500": ["KODEX 200"],
  AAPL: ["Apple", "애플"], NVDA: ["Nvidia", "엔비디아"],
  AMD: ["AMD", "Advanced Micro Devices"], AMZN: ["Amazon", "아마존"],
  MSFT: ["Microsoft", "마이크로소프트"],
};
const sectorRules: Array<{ symbols: string[]; pattern: RegExp; label: string }> = [
  { symbols: ["005930", "005935", "000660", "NVDA", "AMD"], pattern: /반도체|semiconductor|메모리|memory chip|HBM/i, label: "반도체 업종 연관" },
  { symbols: ["051910", "006400", "005380"], pattern: /전기차|배터리|electric vehicle|batter(?:y|ies)/i, label: "전기차·배터리 업종 연관" },
  { symbols: ["035420", "MSFT", "AMZN"], pattern: /클라우드|cloud computing|인공지능|artificial intelligence/i, label: "클라우드·AI 업종 연관" },
];
function contains(text: string, term: string): boolean {
  if (!term.trim()) return false;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "i").test(text);
}
export function companyNames(target: NewsTarget): string[] {
  return [...new Set([...(aliases[target.stockCode] ?? []), target.stockName, target.stockCode])]
    .filter((s) => s.length >= 2);
}
function directMention(title: string, target: NewsTarget): boolean {
  if (!companyNames(target).some((name) => contains(title, name))) return false;
  // Common company names also refer to fruit, a river, or a medical condition.
  if (["AAPL", "AMZN", "AMD"].includes(target.stockCode)) {
    if (target.stockCode === "AAPL" && /apple\s+(?:cider|juice|variet|orchard|fruit)/i.test(title)) return false;
    if (target.stockCode === "AMZN" && /amazon\s+(?:river|rainforest|basin)/i.test(title)) return false;
    if (target.stockCode === "AMD" && /macular degeneration/i.test(title)) return false;
    return /\b(?:AAPL|AMZN|stock|shares?|earnings|revenue|profit|guidance|outlook|contract|CEO|Nasdaq|iPhone|iPad|MacBook|iOS|AWS|cloud|retail|ecommerce|chip|Ryzen|Radeon|EPYC|GPU|AI)\b|주가|실적|매출|이익|계약|수주|아이폰|반도체|클라우드|가이던스/i.test(title);
  }
  return true;
}
export function headlineDirection(title: string): { direction: NewsMatch["direction"]; reason: string } {
  // This is a transparent headline hypothesis, never a fact/consensus verification.
  if (/\?|전망되|예상되|가능성|루머|소문|부인|아니|않|미확인|않았|할까|할 것|기대|관측|우려|\b(?:may|might|could|rumou?r|denies?|not|no|expected|likely|preview)\b/i.test(title))
    return { direction: "UNCERTAIN", reason: "예상·부정·질문 표현: 방향 자동 판단 보류" };
  const positive = /실적.{0,12}(?:예상|전망|컨센서스).{0,6}상회|(?:매출|이익|가이던스|실적 전망).{0,8}상향|수주.{0,5}확정|계약.{0,5}체결|\b(?:beats? (?:earnings |profit |revenue )?(?:estimates|expectations)|raises? (?:guidance|outlook)|wins? contract)\b/i.test(title);
  const negative = /(?:매출|이익|가이던스|실적 전망).{0,8}하향|실적.{0,12}(?:예상|전망|컨센서스).{0,6}하회|계약.{0,5}해지|영업정지|회계부정|\b(?:misses? (?:earnings |profit |revenue )?(?:estimates|expectations)|cuts? (?:guidance|outlook)|accounting fraud|files? for bankruptcy)\b/i.test(title);
  if (positive === negative) return { direction: "UNCERTAIN", reason: positive ? "긍정·부정 내용 혼재" : "명확한 실적·계약 사건 표현 없음" };
  return { direction: positive ? "POSITIVE" : "NEGATIVE", reason: "제목의 실적·계약 표현으로 분류한 가설 · 본문·예상치 미검증" };
}
export function matchNews(article: NewsArticle, target: NewsTarget, universe: NewsTarget[]): NewsMatch | null {
  const direct = directMention(article.title, target);
  if (direct) {
    // Several named companies can have opposite outcomes in the same headline.
    const others = universe.some((other) => targetKey(other) !== targetKey(target) &&
      directMention(article.title, other));
    const classification = others ? { direction: "UNCERTAIN" as const, reason: "여러 종목이 함께 언급되어 회사별 방향 보류" } : headlineDirection(article.title);
    return { article, relation: "DIRECT", ...classification };
  }
  const sector = sectorRules.find((rule) => rule.symbols.includes(target.stockCode) && rule.pattern.test(article.title));
  if (sector) return { article, relation: "SECTOR", direction: "UNCERTAIN", reason: `${sector.label} · 개별 기업 수혜·피해 미확인` };
  if (/금리|물가|관세|환율|고용|연준|한국은행|FOMC|inflation|tariff|interest rate|monetary policy|payroll/i.test(article.title))
    return { article, relation: "MACRO", direction: "UNCERTAIN", reason: "거시 환경 참고 · 종목별 방향으로 전이하지 않음" };
  return null;
}
export function assessNews(input: {
  target: NewsTarget; universe: NewsTarget[]; articles: NewsArticle[]; feeds: NewsFeed[];
  signal: StrategySignal; price: number; previousClose: number; at: string;
}): NewsAssessment {
  const now = Date.parse(input.at);
  const matches = input.articles.filter((a) => {
    const published = Date.parse(a.publishedAt), seen = Date.parse(a.firstSeenAt);
    return Number.isFinite(published) && Number.isFinite(seen) && published <= now && seen <= now && now - published <= 48 * 3600_000;
  }).map((a) => matchNews(a, input.target, input.universe)).filter((m): m is NewsMatch => !!m)
    .sort((a, b) => Number(b.relation === "DIRECT") - Number(a.relation === "DIRECT") || b.article.publishedAt.localeCompare(a.article.publishedAt));
  const feed = input.feeds.find((f) => f.id === targetKey(input.target));
  const age = now - Date.parse(feed?.lastSuccessAt ?? "");
  const fresh = !!feed && !feed.error && Number.isFinite(age) && age >= 0 && age <= 15 * 60_000;
  const positive = matches.filter((m) => m.relation === "DIRECT" && m.direction === "POSITIVE");
  const negative = matches.filter((m) => m.relation === "DIRECT" && m.direction === "NEGATIVE");
  const result: NewsAssessment = { side: "HOLD", reason: "직접 연결된 명확한 뉴스 조건 대기", matches: matches.slice(0, 8), evidenceIds: [], fresh };
  if (input.signal.side === "SELL") return { ...result, side: "SELL", reason: "기존 가격 전략의 추세 이탈 매도 유지" };
  if (!fresh) return { ...result, reason: "종목 뉴스 수집 실패·지연: 신규 뉴스 판단 대기" };
  if (positive.length && negative.length) return { ...result, reason: "관련 긍정·부정 뉴스 충돌: 대기" };
  if (!Number.isFinite(input.price) || input.price <= 0 || !Number.isFinite(input.previousClose) || input.previousClose <= 0)
    return { ...result, reason: "가격 데이터 부족" };
  if (negative.length && input.price < input.previousClose)
    return { ...result, side: "SELL", evidenceIds: negative.map((m) => m.article.id), reason: "부정 제목 가설 + 전일 종가 대비 하락 · 가상 보유분만 매도" };
  if (positive.length && input.signal.side === "BUY" && input.price >= input.previousClose && input.price / input.previousClose <= 1.02)
    return { ...result, side: "BUY", evidenceIds: positive.map((m) => m.article.id), reason: "긍정 제목 가설 + 추세·돌파 충족 + 전일 종가 대비 0~2% · 가상 매수 후보" };
  return { ...result, reason: positive.length ? "긍정 제목 가설은 있으나 가격·진입 조건 대기" : negative.length ? "부정 제목 가설은 있으나 가격 하락 확인 대기" : result.reason };
}
