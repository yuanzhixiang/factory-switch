// token 统计的数字、日期格式化与时间窗口计算，移植自 T3 Code（MIT）packages/shared/src/usageFormat.ts
// 改动：日期、小时等面向用户的文字改成中文写法；计算逻辑不变。
import type { UsageResolution, UsageSummaryInput } from "../../../shared/token-usage";
import type { UsageContractMismatch } from "./merge";

const CURRENCY = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const INTEGER = new Intl.NumberFormat("en-US");

export function formatUsd(value: number): string {
  return CURRENCY.format(value);
}

export function formatCount(value: number): string {
  return INTEGER.format(Math.round(value));
}

export function formatTokens(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${trim(value / 1e12)}T`;
  if (abs >= 1e9) return `${trim(value / 1e9)}B`;
  if (abs >= 1e6) return `${trim(value / 1e6)}M`;
  if (abs >= 1e3) return `${trim(value / 1e3)}K`;
  return INTEGER.format(Math.round(value));
}

function trim(value: number): string {
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return value.toFixed(digits).replace(/\.0+$/, "");
}

export function formatPercent(share: number, digits = 1): string {
  const percent = share * 100;
  const smallest = 10 ** -digits;
  if (percent > 0 && percent < smallest) return `<${smallest.toFixed(digits)}%`;
  return `${percent.toFixed(digits)}%`;
}

export function formatUsageContractMismatch(
  environmentLabel: string,
  mismatch: Pick<UsageContractMismatch, "direction">,
): string {
  return mismatch.direction === "serverBehind"
    ? `${environmentLabel}的数据格式较旧，未计入合计。`
    : `${environmentLabel}的数据格式比页面新，未计入合计。`;
}

/** YYYY-MM-DD → 「7月31日」 */
export function formatDayShort(day: string): string {
  const [year, month, dayOfMonth] = day.split("-").map((part) => Number(part));
  if (year === undefined || month === undefined || dayOfMonth === undefined) return day;
  return `${month}月${dayOfMonth}日`;
}

export function enumerateDays(sinceDay: string, untilDay: string): readonly string[] {
  const days: string[] = [];
  const start = Date.parse(`${sinceDay}T00:00:00Z`);
  const end = Date.parse(`${untilDay}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return days;

  for (let cursor = start; cursor <= end; cursor += 86_400_000) {
    days.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return days;
}

const HOUR_MS = 60 * 60 * 1000;

const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

function dateTimeFormatter(
  locale: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  if (options.timeZone === undefined) return new Intl.DateTimeFormat(locale, options);
  const key = JSON.stringify([locale, options]);
  let formatter = dateTimeFormatters.get(key);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(locale, options);
    if (dateTimeFormatters.size >= 16) dateTimeFormatters.clear();
    dateTimeFormatters.set(key, formatter);
  }
  return formatter;
}

export function enumerateHourStarts(sinceTime: string, untilTime: string): readonly string[] {
  const starts: string[] = [];
  const start = Date.parse(sinceTime);
  const end = Date.parse(untilTime);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return starts;

  for (let cursor = start; cursor < end; cursor += HOUR_MS) {
    starts.push(new Date(cursor).toISOString());
  }
  return starts;
}

function hourOptions(hour12: boolean): Intl.DateTimeFormatOptions {
  return hour12 ? { hour: "numeric" } : { hour: "2-digit", hourCycle: "h23" };
}

function formatHour(formatter: Intl.DateTimeFormat, date: Date, hour12: boolean): string {
  if (hour12) return formatter.format(date);
  // 滚动窗口的小时桶可能不从整点开始，但标签总是写整点
  return formatter
    .formatToParts(date)
    .map((part) => (part.type === "hour" ? `${part.value}:00` : part.value))
    .join("");
}

/** 夏令时回拨时同一个钟点会出现两次，这两个小时加上时区缩写区分 */
export function formatHourShort(hourStart: string, timeZone?: string, hour12 = false): string {
  const instant = new Date(hourStart);
  if (Number.isNaN(instant.getTime())) return hourStart;
  const options = timeZone === undefined ? {} : { timeZone };
  const hourFormat = dateTimeFormatter("en-US", {
    ...options,
    ...hourOptions(hour12),
  });
  const wallHourFormat = dateTimeFormatter("en-CA", {
    ...options,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  });
  const wallHour = wallHourFormat.format(instant);
  const isRepeatedHour = [-HOUR_MS, HOUR_MS].some(
    (offset) => wallHourFormat.format(new Date(instant.getTime() + offset)) === wallHour,
  );

  if (!isRepeatedHour) return formatHour(hourFormat, instant, hour12);
  const zonedHourFormat = dateTimeFormatter("en-US", {
    ...options,
    ...hourOptions(hour12),
    timeZoneName: "short",
  });
  return formatHour(zonedHourFormat, instant, hour12);
}

/** 「10月28日 14:00」 */
export function formatDateTimeShort(instant: string, timeZone?: string, hour12 = false): string {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return instant;
  const dayFormat = dateTimeFormatter("en-CA", {
    ...(timeZone === undefined ? {} : { timeZone }),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return `${formatDayShort(dayFormat.format(date))} ${formatHourShort(instant, timeZone, hour12)}`;
}

/** 今天、昨天的小时写成「今天 14:00」「昨天 14:00」，更早的带日期 */
export function formatRelativeHourShort(
  hourStart: string,
  relativeTo: string,
  timeZone?: string,
  hour12 = false,
): string {
  const instant = new Date(hourStart);
  const reference = new Date(relativeTo);
  if (Number.isNaN(instant.getTime()) || Number.isNaN(reference.getTime())) {
    return formatDateTimeShort(hourStart, timeZone, hour12);
  }

  const dayFormat = dateTimeFormatter("en-CA", {
    ...(timeZone === undefined ? {} : { timeZone }),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const instantDay = Date.parse(`${dayFormat.format(instant)}T00:00:00Z`);
  const referenceDay = Date.parse(`${dayFormat.format(reference)}T00:00:00Z`);
  const calendarDaysAgo = Math.round((referenceDay - instantDay) / (24 * HOUR_MS));
  const hour = formatHourShort(hourStart, timeZone, hour12);

  if (calendarDaysAgo === 0) return `今天 ${hour}`;
  if (calendarDaysAgo === 1) return `昨天 ${hour}`;
  return formatDateTimeShort(hourStart, timeZone, hour12);
}

/** 按查看者所在时区算出最近 days 天（或最近 24 小时）的查询窗口 */
export function makeWindow(
  days: number,
  now = new Date(),
  resolution: UsageResolution = "day",
): UsageSummaryInput {
  let timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    timeZone = "UTC";
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  }
  const untilDay = format.format(now);
  if (resolution === "hour") {
    const untilTimeMs = Math.floor(now.getTime() / 60_000) * 60_000;
    const sinceTimeMs = untilTimeMs - 24 * HOUR_MS;
    const sinceTime = new Date(sinceTimeMs);
    const untilTime = new Date(untilTimeMs);
    return {
      sinceDay: format.format(sinceTime),
      untilDay: format.format(untilTime),
      timeZone,
      resolution,
      sinceTime: sinceTime.toISOString(),
      untilTime: untilTime.toISOString(),
    };
  }
  // 用 UTC 日历运算往前推，固定毫秒数相减在夏令时切换日会算错
  const [year = 0, month = 1, dayOfMonth = 1] = untilDay
    .split("-")
    .map((part) => Number.parseInt(part, 10));
  const start = new Date(Date.UTC(year, month - 1, dayOfMonth - (days - 1)));
  return {
    sinceDay: start.toISOString().slice(0, 10),
    untilDay,
    timeZone,
    resolution,
  };
}
