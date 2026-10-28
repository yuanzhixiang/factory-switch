// 移植自 T3 Code（MIT）apps/web/src/components/usage/usagePagePreferences.test.ts
// 改动：默认指标是 Tokens（「额度」页签在后续批次加入），存储键名不同。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readUsagePagePreferences,
  saveUsagePagePreferences,
} from "../../src/renderer/lib/token-usage/preferences";

const key = "token-usage-page-preferences:v1";
let values: Map<string, string>;
let storage: Pick<Storage, "getItem" | "setItem">;

beforeEach(() => {
  values = new Map();
  storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
  vi.stubGlobal("window", { localStorage: storage });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("用量页偏好", () => {
  it("隐藏的提供方能存取，旧的保存值没有这一项也能读", () => {
    saveUsagePagePreferences({ metric: "cost", windowDays: 7, hiddenProviders: ["codex"] });
    expect(readUsagePagePreferences().hiddenProviders).toEqual(["codex"]);

    values.set(key, '{"metric":"tokens","windowDays":30}');
    expect(readUsagePagePreferences()).toEqual({ metric: "tokens", windowDays: 30 });
  });

  it.each([
    "not-json",
    '{"metric":"unknown","windowDays":7}',
    '{"metric":"cost","windowDays":365}',
    '{"metric":"cost","windowDays":7,"hiddenProviders":["nope"]}',
  ])("非法的保存值退回默认，并在下次保存时被覆盖：%s", (value) => {
    values.set(key, value);
    expect(readUsagePagePreferences()).toEqual({ metric: "tokens", windowDays: 30 });
    saveUsagePagePreferences({ metric: "cost", windowDays: 7 });
    expect(readUsagePagePreferences()).toEqual({ metric: "cost", windowDays: 7 });
  });

  it("读取存储抛错时返回默认值", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("blocked");
        },
      },
    });
    expect(readUsagePagePreferences()).toEqual({ metric: "tokens", windowDays: 30 });
  });
});
