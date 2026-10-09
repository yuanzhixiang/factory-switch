import type { UsageSnapshot, UsageWindow } from "../../shared/types";
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

/** 多个账号同一周期的汇总 */
export interface WindowSummary {
  /** 参与汇总的账号数 */
  accounts: number;
  /** 各账号已用百分比之和，按「账号额度」为单位，如 1.6 表示用掉 1.6 个账号的额度 */
  usedAccounts: number;
  /** 总额度的使用率：已用之和 / 账号数 */
  percent: number;
  /** 最早一个重置的周期结束时间；都没开始计时为 null */
  nextReset: number | null;
}

/** 把多个账号同一周期的用量直接相加；没有账号时返回 null */
export function summarizeWindows(
  windows: UsageWindow[],
  now: number,
): WindowSummary | null {
  if (windows.length === 0) {
    return null;
  }
  const used = windows.reduce(
    (total, window) => total + effectivePercent(window, now),
    0,
  );
  const resets = windows
    .map((window) => window.windowEnd)
    .filter((end): end is number => end !== null && end > now);
  return {
    accounts: windows.length,
    usedAccounts: used / 100,
    percent: Math.ceil(used / windows.length),
    nextReset: resets.length > 0 ? Math.min(...resets) : null,
  };
}

/** 有快照的账号某个池的月度汇总，侧边栏和汇总页共用 */
export function summarizeMonthly(
  snapshots: UsageSnapshot[],
  pool: "standard" | "core",
  now: number,
): WindowSummary | null {
  return summarizeWindows(
    snapshots.map((snapshot) => snapshot[pool].monthly),
    now,
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
export function formatDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
