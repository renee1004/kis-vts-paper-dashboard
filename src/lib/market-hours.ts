import "server-only";

const NY_TZ = "America/New_York";
const KST_TZ = "Asia/Seoul";
const NY_WEEKDAYS = new Set(["Mon", "Tue", "Wed", "Thu", "Fri"]);

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

function tzOffsetMs(date: Date, timeZone: string): number {
  const parts = partMap(date, timeZone, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour24(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - date.getTime();
}

function wallClockInZone(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  let utc = wallAsUtc;
  for (let i = 0; i < 4; i += 1) {
    utc = wallAsUtc - tzOffsetMs(new Date(utc), timeZone);
  }
  return new Date(utc);
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

/** America/New_York regular session: weekdays 09:30–16:00 ET (inclusive start, exclusive end at 16:00). */
export function isUsRegularMarketOpen(at: Date = new Date()): boolean {
  const parts = partMap(at, NY_TZ, {
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
  });

  const weekday = parts.weekday ?? "";
  if (!NY_WEEKDAYS.has(weekday)) return false;

  const hour = hour24(parts.hour);
  const minute = Number(parts.minute ?? NaN);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false;

  const minutes = hour * 60 + minute;
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

export function usMarketStatusLabel(at: Date = new Date()): string {
  return isUsRegularMarketOpen(at) ? "OPEN" : "CLOSED";
}

/** Regular hours in ET, plus today's Korea-time window (DST-aware). */
export function usRegularHoursDescriptionKo(at: Date = new Date()): string {
  const parts = partMap(at, NY_TZ, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const open = wallClockInZone(year, month, day, 9, 30, NY_TZ);
  const close = wallClockInZone(year, month, day, 16, 0, NY_TZ);
  const kstOpen = formatClock(open, KST_TZ);
  const kstClose = formatClock(close, KST_TZ);
  const closeLabel =
    kstClose.date === kstOpen.date
      ? kstClose.time
      : `다음날 ${kstClose.time}`;
  return `미국 동부시간(ET) 평일 09:30–16:00 · 한국시간 ${kstOpen.time}–${closeLabel} (서머타임 자동 반영)`;
}

export function domesticMarketDate(at: Date = new Date()): string {
  return formatClock(at, KST_TZ).date.replaceAll("-", "");
}
// Weekday/time gate only; exchange holidays/halts remain subject to broker rejection.
export function isDomesticRegularMarketOpen(at: Date = new Date()): boolean {
  const parts = partMap(at, KST_TZ, { weekday: "short", hour: "numeric", minute: "numeric" });
  const minutes = hour24(parts.hour) * 60 + Number(parts.minute);
  return NY_WEEKDAYS.has(parts.weekday) && minutes >= 540 && minutes < 930;
}
