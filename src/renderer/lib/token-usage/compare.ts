// 环比：取与当前时间段等长、紧挨在前面的上一周期
import type { UsageSummaryInput } from "../../../shared/token-usage";

const DAY_MS = 86_400_000;

function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function dayIn(timeZone: string, instantMs: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instantMs));
}

/**
 * 上一周期：按天的窗口整体前移同样的天数（7 天 → 再往前 7 天）；
 * 按小时的 24 小时窗口前移 24 小时。
 */
export function previousWindow(input: UsageSummaryInput): UsageSummaryInput {
  if (
    input.resolution === "hour" &&
    input.sinceTime !== undefined &&
    input.untilTime !== undefined
  ) {
    const sinceMs = Date.parse(input.sinceTime);
    const untilMs = Date.parse(input.untilTime);
    const span = untilMs - sinceMs;
    const prevSince = sinceMs - span;
    return {
      ...input,
      sinceDay: dayIn(input.timeZone, prevSince),
      untilDay: dayIn(input.timeZone, sinceMs),
      sinceTime: new Date(prevSince).toISOString(),
      untilTime: new Date(sinceMs).toISOString(),
    };
  }
  const span =
    Math.round(
      (Date.parse(`${input.untilDay}T00:00:00Z`) - Date.parse(`${input.sinceDay}T00:00:00Z`)) /
        DAY_MS,
    ) + 1;
  return {
    ...input,
    sinceDay: shiftDay(input.sinceDay, -span),
    untilDay: shiftDay(input.sinceDay, -1),
  };
}

/** 环比变化率；上一周期为 0 时无法计算，返回 null */
export function changeRatio(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return (current - previous) / previous;
}

/** 「↑23.3%」「↓5.0%」「持平」；上一周期没有用量时显示「上一周期无用量」 */
export function formatChange(current: number, previous: number): string {
  const ratio = changeRatio(current, previous);
  if (ratio === null) return current > 0 ? "上一周期无用量" : "持平";
  const percent = Math.abs(ratio) * 100;
  if (percent < 0.05) return "持平";
  return `${ratio > 0 ? "↑" : "↓"}${percent.toFixed(1)}%`;
}
