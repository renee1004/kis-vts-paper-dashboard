import "server-only";
import { marketSession } from "./market-calendar";

const NY_TZ = "America/New_York";
const KST_TZ = "Asia/Seoul";

function partMap(
  at: Date,
  timeZone: string,
  extra: Intl.DateTimeFormatOptions = {},
): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    ...extra,
  }).formatToParts(at);
  return Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
  );
}

function hour24(value: string | undefined): number {
  const hour = Number(value ?? NaN);
  return hour === 24 ? 0 : hour;
}

function formatClock(at: Date, timeZone: string): { date: string; time: string } {
  const parts = partMap(at, timeZone, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const hour = String(hour24(parts.hour)).padStart(2, "0");
  const minute = String(Number(parts.minute)).padStart(2, "0");
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${hour}:${minute}`,
  };
}

export function usMarketDate(at: Date = new Date()): string {
  const parts = partMap(at, NY_TZ, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return `${parts.year}${parts.month}${parts.day}`;
}

/** Scheduled regular equity session (inclusive open, exclusive close). */
export function isUsRegularMarketOpen(at: Date = new Date()): boolean {
  return marketSession("US_NASDAQ", at).isOpen;
}

export function usMarketStatusLabel(at: Date = new Date()): string {
  const session = marketSession("US_NASDAQ", at);
  return !session.known ? "UNKNOWN" : session.isOpen ? "OPEN" : "CLOSED";
}

/** Regular hours in ET, plus today's Korea-time window (DST-aware). */
export function usRegularHoursDescriptionKo(at: Date = new Date()): string {
  const session = marketSession("US_NASDAQ", at);
  if (!session.known) return "미국 거래일 달력 범위 밖: 달력 갱신 전 주문 보류";
  if (!session.openAt || !session.closeAt) return "미국 정규시장 휴장일";
  const open = new Date(session.openAt);
  const close = new Date(session.closeAt);
  const kstOpen = formatClock(open, KST_TZ);
  const kstClose = formatClock(close, KST_TZ);
  const closeLabel =
    kstClose.date === kstOpen.date
      ? kstClose.time
      : `다음날 ${kstClose.time}`;
  return `미국 정규장${session.earlyClose ? " 조기 폐장" : ""} · 한국시간 ${kstOpen.time}–${closeLabel} (서머타임 자동 반영)`;
}

export function domesticMarketDate(at: Date = new Date()): string {
  return formatClock(at, KST_TZ).date.replaceAll("-", "");
}
// Holidays and special session times come from the bounded calendar snapshot.
export function isDomesticRegularMarketOpen(at: Date = new Date()): boolean {
  return marketSession("DOMESTIC", at).isOpen;
}
