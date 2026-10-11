import { describe, expect, it } from "vitest";
import type { UsagePool, UsageSnapshot } from "../src/shared/types";
import { summarizePeriod, summarizeWindows } from "../src/renderer/lib/usage";

const NOW = 1_000_000;

function pool(weekly: number, monthly: number): UsagePool {
  return {
    fiveHour: { usedPercent: 0, windowEnd: null },
    weekly: { usedPercent: weekly, windowEnd: NOW + weekly },
    monthly: { usedPercent: monthly, windowEnd: NOW + monthly },
  };
}

function snapshot(standard: UsagePool, core: UsagePool): UsageSnapshot {
  return {
    standard,
    core,
    extraUsageCents: 0,
    overagePreference: null,
    fetchedAt: NOW,
  };
}

describe("summarizePeriod", () => {
  const snapshots = [
    snapshot(pool(51, 26), pool(5, 1)),
    snapshot(pool(33, 17), pool(7, 3)),
  ];

  it("按池和周期取对应的用量相加", () => {
    expect(summarizePeriod(snapshots, "standard", "weekly", NOW)).toEqual({
      accounts: 2,
      usedAccounts: 0.84,
      percent: 42,
      nextReset: NOW + 33,
    });
    expect(summarizePeriod(snapshots, "standard", "monthly", NOW)?.percent).toBe(22);
    expect(summarizePeriod(snapshots, "core", "weekly", NOW)?.percent).toBe(6);
  });
});

describe("summarizeWindows", () => {
  it("没有账号时返回 null", () => {
    expect(summarizeWindows([], NOW)).toBeNull();
  });

  it("直接相加各账号用量，并算出总额度使用率", () => {
    const summary = summarizeWindows(
      [
        { usedPercent: 34, windowEnd: NOW + 5000 },
        { usedPercent: 98, windowEnd: NOW + 2000 },
        { usedPercent: 0.4, windowEnd: null },
      ],
      NOW,
    );
    // 0.4 按单账号展示规则向上取整成 1
    expect(summary).toEqual({
      accounts: 3,
      usedAccounts: 1.33,
      percent: 45,
      nextReset: NOW + 2000,
    });
  });

  it("已经过期的周期按 0% 计，也不算作下次重置", () => {
    const summary = summarizeWindows(
      [
        { usedPercent: 80, windowEnd: NOW - 1 },
        { usedPercent: 20, windowEnd: NOW + 9000 },
      ],
      NOW,
    );
    expect(summary?.usedAccounts).toBe(0.2);
    expect(summary?.percent).toBe(10);
    expect(summary?.nextReset).toBe(NOW + 9000);
  });
});
