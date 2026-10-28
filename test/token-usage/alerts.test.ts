import { describe, expect, it } from "vitest";
import { nextDailyAlert, todayWindow } from "../../src/core/token-usage/alerts";

describe("Claude Code 当天用量提醒", () => {
  it("跨过 1B 和 2B 各通知一次", () => {
    let state = nextDailyAlert(null, "2026-10-28", 0.5e9).state;
    let step = nextDailyAlert(state, "2026-10-28", 1.2e9);
    expect(step.threshold).toBe(1e9);
    state = step.state;
    step = nextDailyAlert(state, "2026-10-28", 1.5e9);
    expect(step.threshold).toBeNull();
    step = nextDailyAlert(step.state, "2026-10-28", 2.1e9);
    expect(step.threshold).toBe(2e9);
    expect(nextDailyAlert(step.state, "2026-10-28", 3e9).threshold).toBeNull();
  });

  it("一次跨过两个阈值只通知最高的", () => {
    const step = nextDailyAlert(null, "2026-10-28", 2.5e9);
    expect(step.threshold).toBe(2e9);
    expect(step.state.notified).toEqual([1e9, 2e9]);
  });

  it("第二天重新计", () => {
    const yesterday = nextDailyAlert(null, "2026-10-27", 2.5e9).state;
    expect(nextDailyAlert(yesterday, "2026-10-28", 0.1e9)).toEqual({
      threshold: null,
      state: { day: "2026-10-28", notified: [] },
    });
    expect(nextDailyAlert(yesterday, "2026-10-28", 1.1e9).threshold).toBe(1e9);
  });

  it("按指定时区取今天", () => {
    const now = new Date("2026-10-28T20:00:00Z");
    expect(todayWindow(now, "Asia/Shanghai").sinceDay).toBe("2026-10-29");
    expect(todayWindow(now, "UTC").untilDay).toBe("2026-10-28");
  });
});
