import { describe, expect, it } from "vitest";
import { summarizeWindows } from "../src/renderer/lib/usage";

const NOW = 1_000_000;

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
