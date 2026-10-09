import type { UsagePool, UsageSnapshot, UsageWindow } from "../../shared/types";
import { HIGH_USAGE_PERCENT } from "../../shared/usage";

/** 周期已经结束时按 0% 展示，避免显示过期的高用量 */
export function effectivePercent(window: UsageWindow, now: number): number {
  if (window.windowEnd !== null && window.windowEnd <= now) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.ceil(window.usedPercent)));
}

/** 用量等级，决定进度条和数字的颜色 */
export type UsageLevel = "normal" | "high" | "full";

export function usageLevel(percent: number): UsageLevel {
  if (percent >= 100) {
    return "full";
  }
  return percent >= HIGH_USAGE_PERCENT ? "high" : "normal";
}

/** 三个周期里最高的使用率，侧边栏展示用 */
export function highestPercent(pool: UsagePool, now: number): number {
  return Math.max(
    effectivePercent(pool.fiveHour, now),
    effectivePercent(pool.weekly, now),
    effectivePercent(pool.monthly, now),
  );
}

/** 距离重置还有多久，格式对齐 Factory：2h 40min / 6 days */
export function formatReset(windowEnd: number | null, now: number): string {
  if (windowEnd === null || windowEnd <= now) {
    return "—";
  }
  const minutes = Math.floor((windowEnd - now) / 60_000);
  if (minutes < 60) {
    return `${minutes}min`;
  }
  if (minutes < 24 * 60) {
    return `${Math.floor(minutes / 60)}h ${minutes % 60}min`;
  }
  const days = Math.floor(minutes / (24 * 60));
  return `${days} ${days === 1 ? "day" : "days"}`;
}

/** 额外额度显示成美元 */
export function formatDollars(snapshot: UsageSnapshot): string {
  return `$${(snapshot.extraUsageCents / 100).toFixed(2)}`;
}
