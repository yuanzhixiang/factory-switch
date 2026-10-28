import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { makeUnavailableUsageLimits, makeUsageLimits } from "../../src/core/usage-limits/common";
import { createUsageLimitsService } from "../../src/core/usage-limits/service";
import {
  applyUsageLimitsSettingsPatch,
  createUsageLimitsSettingsStore,
  settingsView,
} from "../../src/core/usage-limits/settings";
import type { LimitDriver, LimitProvider } from "../../src/shared/usage-limits";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "usage-limits-test-"));
  dirs.push(dir);
  return dir;
}

function provider(driver: LimitDriver, usedPercent: number | null, checkedAt: string): LimitProvider {
  return {
    instanceId: driver,
    driver,
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated", email: `${driver}@example.com` },
    usageLimits:
      usedPercent === null
        ? makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed" })
        : makeUsageLimits({
            checkedAt,
            windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent }],
          }),
    checkedAt,
  };
}

describe("额度设置", () => {
  it("编辑来源时不传密钥就沿用原来的，null 删除来源；页面只看到有没有密钥", () => {
    const first = applyUsageLimitsSettingsPatch(
      { usageLimitSources: {}, cursorKeychainUsageEnabled: false },
      {
        usageLimitSources: {
          cpa: { kind: "cliproxy", url: " https://cpa.test ", managementKey: "secret", enabled: true },
        },
      },
    );
    const edited = applyUsageLimitsSettingsPatch(first, {
      usageLimitSources: {
        cpa: { kind: "cliproxy", label: "CPA", url: "https://cpa.test", enabled: false },
      },
      cursorKeychainUsageEnabled: true,
    });
    expect(edited.usageLimitSources["cpa"]).toEqual({
      kind: "cliproxy",
      label: "CPA",
      url: "https://cpa.test",
      managementKey: "secret",
      enabled: false,
    });
    expect(edited.cursorKeychainUsageEnabled).toBe(true);
    expect(JSON.stringify(settingsView(edited))).not.toContain("secret");
    expect(settingsView(edited).usageLimitSources[0]?.hasManagementKey).toBe(true);
    expect(
      applyUsageLimitsSettingsPatch(edited, { usageLimitSources: { cpa: null } }).usageLimitSources,
    ).toEqual({});
  });

  it("设置文件权限是 600", async () => {
    const dir = await tempDir();
    const store = createUsageLimitsSettingsStore(dir);
    await store.update({ cursorKeychainUsageEnabled: true });
    expect((await fs.stat(path.join(dir, "settings.json"))).mode & 0o777).toBe(0o600);
    expect((await store.read()).cursorKeychainUsageEnabled).toBe(true);
  });
});

describe("额度服务", () => {
  it("探测失败时保留上一次的额度，并把 Cursor 开关传给探测", async () => {
    const dir = await tempDir();
    let claudePercent: number | null = 40;
    const cursorAllowed: boolean[] = [];
    const states: boolean[] = [];
    const service = createUsageLimitsService({
      settings: createUsageLimitsSettingsStore(dir),
      probes: {
        claudeAgent: async () => provider("claudeAgent", claudePercent, new Date().toISOString()),
        codex: async () => provider("codex", 10, new Date().toISOString()),
        cursor: async (allowKeychain) => {
          cursorAllowed.push(allowKeychain);
          return provider("cursor", 5, new Date().toISOString());
        },
        opencode: async () => provider("opencode", 1, new Date().toISOString()),
      },
      consumeCodexResetCredit: async () => "reset",
      httpFetch: () => Promise.reject(new Error("no network")),
      onChange: (state) => states.push(state.refreshing),
    });
    const first = await service.refresh();
    expect(first.providers.map((entry) => entry.driver)).toEqual([
      "claudeAgent",
      "codex",
      "cursor",
      "opencode",
    ]);
    claudePercent = null;
    const second = await service.refresh();
    expect(second.providers[0]?.usageLimits?.windows[0]?.usedPercent).toBe(40);
    expect(second.providers[0]?.usageLimits?.unavailable).toBeUndefined();
    expect(cursorAllowed).toEqual([false, false]);
    expect(states).toEqual([true, false, true, false]);
  });

  it("本机 Codex 兑换后重新探测；不支持的账号直接拒绝；没有密钥的来源报错", async () => {
    const dir = await tempDir();
    let codexProbes = 0;
    let consumed = 0;
    const settings = createUsageLimitsSettingsStore(dir);
    await settings.update({
      usageLimitSources: {
        cpa: { kind: "cliproxy", url: "https://cpa.test", managementKey: "", enabled: true },
      },
    });
    const service = createUsageLimitsService({
      settings,
      probes: {
        claudeAgent: async () => provider("claudeAgent", 1, new Date().toISOString()),
        codex: async () => {
          codexProbes += 1;
          return provider("codex", 1, new Date().toISOString());
        },
        cursor: async () => provider("cursor", 1, new Date().toISOString()),
        opencode: async () => provider("opencode", 1, new Date().toISOString()),
      },
      consumeCodexResetCredit: async () => {
        consumed += 1;
        return "reset";
      },
      httpFetch: () => Promise.reject(new Error("no network")),
    });
    expect(await service.consumeResetCredit({ instanceId: "codex" })).toEqual({
      ok: true,
      outcome: "reset",
    });
    expect([consumed, codexProbes]).toEqual([1, 1]);
    expect((await service.consumeResetCredit({ instanceId: "claudeAgent" })).ok).toBe(false);
    expect(
      (await service.consumeResetCredit({ sourceId: "cpa", accountId: "a", creditId: "c" })).ok,
    ).toBe(false);
    const state = await service.refresh();
    expect(state.usageLimitSources[0]?.error).toBe("没有设置管理密钥。");
  });
});
