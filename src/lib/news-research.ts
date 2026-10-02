import "server-only";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { assessNews, NEWS_VERSION, targetKey, type NewsArticle, type NewsFeed, type NewsTarget } from "@/lib/news-model";
import { feedSpecs, fetchNewsFeed } from "@/lib/news-feeds";
import { advanceShadow, bookSummary, emptyBook, type ResearchObservation, type ShadowBook } from "@/lib/news-shadow";
import type { StrategySignal } from "@/lib/strategy";
import { newsDefendBuyVerdict } from "@/lib/news-defend";

const finite = z.number().finite();
const positive = finite.positive(), nonnegative = finite.nonnegative();
const timestamp = z.string().datetime();
const record = <T extends z.ZodType>(schema: T) => z.record(z.string(), schema);
const bookSchema = z.object({
  cashKrw: nonnegative, positions: record(z.object({ quantity: positive.int(), averagePriceKrw: positive,
    stopFraction: positive.max(0.08), partialTaken: z.boolean() })),
  pending: record(z.object({ side: z.enum(["BUY", "SELL"]), decidedAt: timestamp, signalKey: z.string(), reason: z.string(),
    evidenceIds: z.array(z.string()), quantity: positive.int(), stopFraction: positive.max(0.08), partial: z.boolean(), referencePriceKrw: positive })),
  marks: record(z.object({ priceKrw: positive, at: timestamp })),
  usedBuySignals: record(z.string()), lastSoldSession: record(z.string()),
  dailyBuy: z.object({ date: z.string(), notionalKrw: nonnegative }),
  fills: nonnegative.int(), closedLots: nonnegative.int(), feesKrw: nonnegative,
  peakNavKrw: positive, maxDrawdownPct: nonnegative, lastEvent: z.string(),
});
const articleSchema = z.object({ id: z.string(), title: z.string(), url: z.string().url(), source: z.string(), feedId: z.string(),
  publishedAt: timestamp, firstSeenAt: timestamp, official: z.boolean() });
const feedSchema = z.object({ id: z.string(), label: z.string(), lastAttemptAt: timestamp, lastSuccessAt: timestamp.nullable(), error: z.string().nullable(), count: nonnegative.int() });
const snapshotSchema = z.object({
  version: z.literal(NEWS_VERSION), startedAt: timestamp, updatedAt: timestamp,
  articles: z.array(articleSchema), feeds: z.array(feedSchema), price: bookSchema, news: bookSchema,
  decisions: record(z.object({ at: timestamp, target: z.object({ market: z.enum(["DOMESTIC", "US_NASDAQ"]), stockCode: z.string(), stockName: z.string() }),
    priceSide: z.enum(["BUY", "SELL", "HOLD"]), newsSide: z.enum(["BUY", "SELL", "HOLD"]), reason: z.string(),
    evidenceIds: z.array(z.string()), fresh: z.boolean() })),
  observations: nonnegative.int(), journalError: z.string().nullable(),
});
type ResearchState = z.infer<typeof snapshotSchema>;
const root = process.env.DATA_DIR || path.join(process.cwd(), ".data");
// Preserve the 3M experiment intact; a changed capital base is a new experiment.
const statePath = path.join(root, "news-research-capital30m-v2.json");
const runtime = globalThis as typeof globalThis & { __newsResearch?: ResearchState; __newsRefresh?: Promise<void> };
function getState(): ResearchState {
  if (runtime.__newsResearch?.version === NEWS_VERSION) return runtime.__newsResearch;
  let text: string;
  try { text = fs.readFileSync(statePath, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("뉴스 비교 원장을 읽을 수 없습니다. 기존 기록을 확인하세요.");
    const now = new Date().toISOString();
    return runtime.__newsResearch = { version: NEWS_VERSION, startedAt: now, updatedAt: now, articles: [], feeds: [],
      price: emptyBook(), news: emptyBook(), decisions: {}, observations: 0, journalError: null };
  }
  const result = snapshotSchema.safeParse(JSON.parse(text));
  if (!result.success) throw new Error("뉴스 비교 원장 손상·버전 불일치. 자동 초기화하지 않습니다.");
  // Pending hypothetical orders cannot fill retroactively across a server restart.
  result.data.price.pending = {}; result.data.news.pending = {};
  return runtime.__newsResearch = result.data;
}
function commit(next: ResearchState): void {
  snapshotSchema.parse(next);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const temp = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(next), { mode: 0o600 });
  fs.renameSync(temp, statePath);
  runtime.__newsResearch = next;
}
function journal(next: ResearchState, kind: string, data: unknown): void {
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(root, `news-evidence-capital30m-v2-${next.updatedAt.slice(0, 7)}.jsonl`),
      JSON.stringify({ version: NEWS_VERSION, recordedAt: next.updatedAt, kind, data }) + "\n", { mode: 0o600 });
  } catch { next.journalError = "뉴스 근거 기록 저장 실패. 비교 데이터의 완전성을 확인하세요."; }
}
export async function refreshResearchNews(targets: NewsTarget[]): Promise<void> {
  if (runtime.__newsRefresh) return runtime.__newsRefresh;
  const work = async () => {
    const specs = feedSpecs(targets).filter((spec) => {
      const old = getState().feeds.find((f) => f.id === spec.id);
      return !old || Date.now() - Date.parse(old.lastAttemptAt) >= 5 * 60_000;
    });
    if (!specs.length) return;
    // Bounded concurrency and one in-flight refresh shared by the UI and agent.
    for (let start = 0; start < specs.length; start += 4) {
      const batch = specs.slice(start, start + 4);
      const results = await Promise.allSettled(batch.map(fetchNewsFeed));
      const next = structuredClone(getState());
      next.updatedAt = new Date().toISOString();
      const newArticles: NewsArticle[] = [];
      results.forEach((result, index) => {
        const spec = batch[index], old = next.feeds.find((f) => f.id === spec.id);
        const feed: NewsFeed = { id: spec.id, label: spec.label, lastAttemptAt: next.updatedAt,
          lastSuccessAt: result.status === "fulfilled" ? next.updatedAt : old?.lastSuccessAt ?? null,
          error: result.status === "fulfilled" ? null : "RSS 수집 실패 · 다음 주기에 재시도", count: result.status === "fulfilled" ? result.value.length : 0 };
        next.feeds = next.feeds.filter((f) => f.id !== spec.id).concat(feed);
        if (result.status === "fulfilled") for (const article of result.value) {
          if (next.articles.some((a) => a.id === article.id)) continue;
          next.articles.push(article); newArticles.push(article);
        }
      });
      next.articles = next.articles.filter((a) => Date.parse(next.updatedAt) - Date.parse(a.publishedAt) <= 7 * 86400_000);
      if (newArticles.length) journal(next, "first_seen_articles", newArticles);
      commit(next);
    }
  };
  runtime.__newsRefresh = work().finally(() => { runtime.__newsRefresh = undefined; });
  return runtime.__newsRefresh;
}
export function observeResearch(input: {
  target: NewsTarget; universe: NewsTarget[]; signal: StrategySignal; price: number; previousClose: number; at: string;
}): void {
  const next = structuredClone(getState());
  const key = targetKey(input.target);
  if (next.decisions[key] && next.decisions[key].at >= input.at) return;
  const news = assessNews({ ...input, articles: next.articles, feeds: next.feeds });
  const observation: ResearchObservation = { ...input, news };
  const events = { price: advanceShadow(next.price as ShadowBook, observation, "price"), news: advanceShadow(next.news as ShadowBook, observation, "news") };
  const decision = { at: input.at, target: input.target, priceSide: input.signal.side,
    newsSide: news.side, reason: news.reason, evidenceIds: news.evidenceIds, fresh: news.fresh };
  next.updatedAt = new Date().toISOString(); next.observations++; next.decisions[key] = decision;
  // Keep the exact inputs, first-seen evidence and virtual events for forward-only audit.
  journal(next, "observation", { ...observation, news: { ...news,
    matches: news.matches.map((m) => ({ articleId: m.article.id, relation: m.relation, direction: m.direction, reason: m.reason })) }, events });
  commit(next);
}
export function researchView(targets: NewsTarget[]) {
  const current = getState(), now = Date.now();
  return { version: current.version, asOf: new Date(now).toISOString(), startedAt: current.startedAt, updatedAt: current.updatedAt, observations: current.observations,
    executionMode: "LOCAL_SHADOW_ONLY" as const, journalError: current.journalError,
    price: bookSummary(current.price, now), news: bookSummary(current.news, now),
    feeds: current.feeds, articles: current.articles.filter((a) => now - Date.parse(a.publishedAt) <= 48 * 3600_000)
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)),
    decisions: targets.map((t) => current.decisions[targetKey(t)]).filter((d) => !!d),
  };
}

export function researchBuyNewsBlock(
  market: "DOMESTIC" | "US_NASDAQ",
  stockCode: string,
  nowMs: number = Date.now(),
): ReturnType<typeof newsDefendBuyVerdict> & { headline: string | null } {
  const allow = { block: false as const, blockedReason: null, reason: "", headline: null };
  let current: ResearchState;
  try {
    current = getState();
  } catch {
    return allow;
  }
  const decision = current.decisions[`${market}:${stockCode}`];
  if (!decision) return allow;
  const verdict = newsDefendBuyVerdict({
    newsSide: decision.newsSide,
    reason: decision.reason,
    fresh: decision.fresh,
    at: decision.at,
  }, nowMs);
  if (!verdict.block) return { ...verdict, headline: null };
  const headline = decision.evidenceIds
    .map((id) => current.articles.find((article) => article.id === id)?.title)
    .find((title): title is string => typeof title === "string" && title.length > 0) ?? null;
  return { ...verdict, headline };
}

export type NewsResearchView = ReturnType<typeof researchView>;
