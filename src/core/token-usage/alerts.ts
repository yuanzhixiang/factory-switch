// Claude Code 当天用量提醒：当天 token 超过 1B、2B 各通知一次，第二天重新计
import fs from "node:fs/promises";
import path from "node:path";

import type { UsageSummary, UsageSummaryInput } from "../../shared/token-usage";
import { writeFileAtomic } from "../fs-utils";
import { totalTokens } from "./types";

export const CLAUDE_DAILY_THRESHOLDS = [1e9, 2e9] as const;

/** 已经通知过的日期和阈值，存盘避免重启后同一天重复通知 */
export interface DailyAlertState {
  readonly day: string;
  readonly notified: readonly number[];
}

/** 本地时区的「今天」窗口 */
export function todayWindow(now: Date, timeZone: string): UsageSummaryInput {
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return { sinceDay: day, untilDay: day, timeZone };
}

export function claudeTokens(summary: UsageSummary): number {
  return summary.buckets
    .filter((bucket) => bucket.provider === "claude")
    .reduce((sum, bucket) => sum + totalTokens(bucket.totals), 0);
}

/**
 * 算出这次要通知的阈值。一次跨过多个阈值只通知最高的那个，低的一并记为已通知。
 * 换了一天就清空记录。
 */
export function nextDailyAlert(
  state: DailyAlertState | null,
  day: string,
  tokens: number,
  thresholds: readonly number[] = CLAUDE_DAILY_THRESHOLDS,
): { readonly threshold: number | null; readonly state: DailyAlertState } {
  const notified = state?.day === day ? state.notified : [];
  const crossed = thresholds.filter((threshold) => tokens >= threshold);
  const fresh = crossed.filter((threshold) => !notified.includes(threshold));
  if (fresh.length === 0) {
    return { threshold: null, state: { day, notified } };
  }
  return {
    threshold: Math.max(...fresh),
    state: { day, notified: [...new Set([...notified, ...crossed])].sort((a, b) => a - b) },
  };
}

export async function readAlertState(file: string): Promise<DailyAlertState | null> {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8")) as Partial<DailyAlertState>;
    if (typeof value.day !== "string" || !Array.isArray(value.notified)) return null;
    return {
      day: value.day,
      notified: value.notified.filter((entry): entry is number => typeof entry === "number"),
    };
  } catch {
    return null;
  }
}

export async function writeAlertState(file: string, state: DailyAlertState): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeFileAtomic(file, JSON.stringify(state));
}
