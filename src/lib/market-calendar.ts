import "server-only";
import { MARKET_CALENDAR } from "./market-calendar-data";
import type { TradingMarket } from "./domain";

const schedules: Record<TradingMarket, Readonly<Record<string, readonly string[]>>> = MARKET_CALENDAR.markets;

/** Bounded offline schedule. Does not detect unscheduled halts or guarantee KIS fills. */
export function marketSession(market: TradingMarket, at = new Date()) {
  const unknown = { known: false, date: null, isOpen: false, openAt: null, closeAt: null, earlyClose: false } as const;
  if (!Number.isFinite(at.getTime())) return unknown;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: market === "DOMESTIC" ? "Asia/Seoul" : "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(at);
  const value = (key: string) => parts.find(p => p.type === key)?.value ?? "";
  const date = value("year") + value("month") + value("day");
  if (date < MARKET_CALENDAR.from || date > MARKET_CALENDAR.through) return { ...unknown, date };
  const unverified: readonly string[] = MARKET_CALENDAR.unverifiedDates[market];
  if (unverified.includes(date)) return { ...unknown, date };
  const session = schedules[market][date];
  if (!session) return { ...unknown, known: true, date };
  const [openAt, closeAt] = session;
  const open = Date.parse(openAt), close = Date.parse(closeAt);
  if (!Number.isFinite(open) || !Number.isFinite(close) || close <= open) return { ...unknown, date };
  const closeHour = Number(new Intl.DateTimeFormat("en-US", {
    timeZone: market === "DOMESTIC" ? "Asia/Seoul" : "America/New_York", hour: "numeric", hourCycle: "h23",
  }).format(new Date(close)));
  return { known: true, date, isOpen: at.getTime() >= open && at.getTime() < close,
    openAt, closeAt, earlyClose: closeHour < (market === "DOMESTIC" ? 15 : 16) };
}

export const MARKET_CALENDAR_INFO = {
  source: MARKET_CALENDAR.source, version: MARKET_CALENDAR.version,
  from: MARKET_CALENDAR.from, through: MARKET_CALENDAR.through, note: MARKET_CALENDAR.note,
  unverifiedDates: MARKET_CALENDAR.unverifiedDates,
  closureCorrections: MARKET_CALENDAR.closureCorrections,
};
