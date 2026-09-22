import "server-only";
import crypto from "node:crypto";
import { companyNames, targetKey, type NewsArticle, type NewsTarget } from "@/lib/news-model";

export interface FeedSpec { id: string; label: string; url: string; official: boolean }
export function feedSpecs(targets: NewsTarget[]): FeedSpec[] {
  const google = (id: string, label: string, query: string, korean: boolean): FeedSpec => ({
    id, label, official: false,
    url: "https://news.google.com/rss/search?" + new URLSearchParams({
      q: `${query} when:2d`, hl: korean ? "ko" : "en-US", gl: korean ? "KR" : "US", ceid: korean ? "KR:ko" : "US:en",
    }),
  });
  return [
    google("macro:KR", "국내 경제 주요 기사", "한국 경제 금리 물가 증시", true),
    google("macro:US", "미국 경제 주요 기사", "US economy Federal Reserve inflation stocks", false),
    { id: "official:FED", label: "미 연준 공식 통화정책 발표", url: "https://www.federalreserve.gov/feeds/press_monetary.xml", official: true },
    { id: "official:BOK", label: "한국은행 공식 금통위 의결사항", url: "https://www.bok.or.kr/portal/bbs/P0000093/news.rss?menuNo=200789", official: true },
    ...targets.slice(0, 40).map((t) => google(targetKey(t), t.stockName,
      `"${companyNames(t)[0].replace(/["\\]/g, " ").slice(0, 100)}"${t.market === "US_NASDAQ" ? " (stock OR shares OR earnings OR guidance OR revenue OR chip OR cloud OR iPhone)" : ""}`, t.market === "DOMESTIC")),
  ];
}
function decode(value: string): string {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
      const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
      if (!entity.startsWith("#")) return named[entity.toLowerCase()] ?? "";
      const n = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "";
    }).replace(/\s+/g, " ").trim();
}
export function safeNewsUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port ||
        !url.hostname.includes(".") || /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname) || url.hostname.includes(":")) return null;
    return url.href;
  } catch { return null; }
}
export function parseNewsRss(xml: string, spec: FeedSpec, at: string): NewsArticle[] {
  if (xml.length > 2_000_000 || /<!DOCTYPE|<!ENTITY/i.test(xml) || !/<rss[\s>]/i.test(xml) || !/<\/rss>/i.test(xml))
    throw new Error("지원하지 않는 RSS 응답");
  const rows: NewsArticle[] = [];
  for (const entry of [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].slice(0, 100)) {
    const field = (name: string) => decode(entry[1].match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"))?.[1] ?? "");
    const title = field("title").slice(0, 500), url = safeNewsUrl(field("link"));
    const published = Date.parse(field("pubDate"));
    if (!title || !url || !Number.isFinite(published) || published > Date.parse(at) || Date.parse(at) - published > 48 * 3600_000) continue;
    const source = field("source").slice(0, 120) || spec.label;
    const cleanTitle = title.endsWith(` - ${source}`) ? title.slice(0, -source.length - 3) : title;
    const id = crypto.createHash("sha256").update(`${source.toLowerCase()}:${cleanTitle.toLowerCase().replace(/\s+/g, " ")}`).digest("hex").slice(0, 24);
    rows.push({ id, title: cleanTitle, url, source, feedId: spec.id, publishedAt: new Date(published).toISOString(), firstSeenAt: at, official: spec.official });
  }
  return [...new Map(rows.map((row) => [row.id, row])).values()];
}
export async function fetchNewsFeed(spec: FeedSpec): Promise<NewsArticle[]> {
  // Only URLs produced by feedSpecs are fetched. Article links are never followed.
  const response = await fetch(spec.url, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(8000), headers: { Accept: "application/rss+xml, application/xml, text/xml" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (!response.body) throw new Error("응답 본문 없음");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 2_000_000) throw new Error("RSS 크기 제한 초과");
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel(); }
  return parseNewsRss(Buffer.concat(chunks).toString("utf8"), spec, new Date().toISOString());
}
