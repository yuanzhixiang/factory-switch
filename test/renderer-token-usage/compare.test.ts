import { describe, expect, it } from "vitest";
import { changeRatio, formatChange, previousWindow } from "../../src/renderer/lib/token-usage/compare";

describe("环比", () => {
  it("按天的窗口整体前移同样天数", () => {
    expect(
      previousWindow({ sinceDay: "2026-10-22", untilDay: "2026-10-28", timeZone: "Asia/Shanghai", resolution: "day" }),
    ).toEqual({ sinceDay: "2026-10-15", untilDay: "2026-10-21", timeZone: "Asia/Shanghai", resolution: "day" });
    // 跨月
    expect(previousWindow({ sinceDay: "2026-09-29", untilDay: "2026-10-28", timeZone: "UTC" })).toMatchObject({
      sinceDay: "2026-08-30",
      untilDay: "2026-09-28",
    });
  });

  it("24 小时窗口前移 24 小时", () => {
    const previous = previousWindow({
      sinceDay: "2026-10-27",
      untilDay: "2026-10-28",
      timeZone: "Asia/Shanghai",
      resolution: "hour",
      sinceTime: "2026-10-27T13:00:00.000Z",
      untilTime: "2026-10-28T13:00:00.000Z",
    });
    expect(previous).toMatchObject({
      sinceTime: "2026-10-26T13:00:00.000Z",
      untilTime: "2026-10-27T13:00:00.000Z",
      sinceDay: "2026-10-26",
      untilDay: "2026-10-27",
    });
  });

  it("变化率格式", () => {
    expect(formatChange(123, 100)).toBe("↑23.0%");
    expect(formatChange(95, 100)).toBe("↓5.0%");
    expect(formatChange(100, 100)).toBe("持平");
    expect(formatChange(5, 0)).toBe("上一周期无用量");
    expect(formatChange(0, 0)).toBe("持平");
    expect(changeRatio(5, 0)).toBeNull();
  });
});
