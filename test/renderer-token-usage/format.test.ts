// 移植自 T3 Code（MIT）packages/shared/src/usageFormat.test.ts
// 改动：日期、小时的展示改成中文写法，相应断言随之调整；默认 24 小时制。
import { describe, expect, it, vi } from "vitest";
import {
  formatDayShort,
  formatHourShort,
  formatRelativeHourShort,
  formatTokens,
  makeWindow,
} from "../../src/renderer/lib/token-usage/format";

describe("小时用量格式化", () => {
  it("多次调用时各时区互不干扰", () => {
    const instant = "2026-08-11T12:37:00.000Z";
    for (const zone of ["UTC", "America/New_York", "Asia/Kathmandu", "UTC"]) {
      expect(formatHourShort(instant, zone, true)).toBe(
        new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric" }).format(
          new Date(instant),
        ),
      );
    }
    expect(() => formatHourShort(instant, "Etc/Unknown")).toThrow(RangeError);
    expect(formatHourShort("invalid", "UTC")).toBe("invalid");
  });

  it("夏令时回拨时重复的钟点带上时区缩写", () => {
    expect(formatHourShort("2026-11-01T05:37:00.000Z", "America/New_York", true)).toBe("1 AM EDT");
    expect(formatHourShort("2026-11-01T06:37:00.000Z", "America/New_York", true)).toBe("1 AM EST");
    expect(formatHourShort("2026-11-01T05:37:00.000Z", "America/New_York")).toBe("01:00 EDT");
    expect(formatHourShort("2026-11-01T06:37:00.000Z", "America/New_York")).toBe("01:00 EST");
  });

  it("按分钟对齐生成 24 小时窗口", () => {
    const window = makeWindow(1, new Date("2026-08-11T12:37:42.123Z"), "hour");

    expect(window.resolution).toBe("hour");
    expect(window.sinceTime).toBe("2026-08-10T12:37:00.000Z");
    expect(window.untilTime).toBe("2026-08-11T12:37:00.000Z");
  });

  it("系统时区无法识别时退回 UTC 而不是崩溃", () => {
    const resolved = new Intl.DateTimeFormat().resolvedOptions();
    const resolvedOptions = vi
      .spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
      .mockReturnValue({ ...resolved, timeZone: "Etc/Unknown" });

    try {
      const now = new Date("2026-08-11T12:37:42.123Z");

      expect(makeWindow(1, now, "hour").timeZone).toBe("UTC");
      expect(makeWindow(30, now).timeZone).toBe("UTC");
    } finally {
      resolvedOptions.mockRestore();
    }
  });

  it("中文日期和相对小时", () => {
    expect(formatDayShort("2026-07-31")).toBe("7月31日");
    const reference = "2026-08-11T12:37:00.000Z";
    expect(formatRelativeHourShort("2026-08-11T09:00:00.000Z", reference, "UTC")).toBe(
      "今天 09:00",
    );
    expect(formatRelativeHourShort("2026-08-10T23:00:00.000Z", reference, "UTC")).toBe(
      "昨天 23:00",
    );
    expect(formatRelativeHourShort("2026-08-08T23:00:00.000Z", reference, "UTC")).toBe(
      "8月8日 23:00",
    );
  });

  it("token 数按量级缩写", () => {
    expect(formatTokens(32_800_000_000)).toBe("32.8B");
    expect(formatTokens(145_000_000)).toBe("145M");
    expect(formatTokens(999)).toBe("999");
  });
});
