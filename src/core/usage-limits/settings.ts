// 额度设置：CLIProxyAPI 来源和是否允许读 Cursor 钥匙串。
// 存在 ~/.factory-switch/usage-limits/settings.json（权限 600），管理密钥只在主进程里用。
import fs from "node:fs/promises";
import path from "node:path";

import type {
  UsageLimitSourceConfig,
  UsageLimitsSettingsPatch,
  UsageLimitsSettingsView,
} from "../../shared/usage-limits";
import { writeFileAtomic } from "../fs-utils";

export interface UsageLimitsSettings {
  readonly usageLimitSources: Readonly<Record<string, UsageLimitSourceConfig>>;
  readonly cursorKeychainUsageEnabled: boolean;
}

const DEFAULT_SETTINGS: UsageLimitsSettings = {
  usageLimitSources: {},
  cursorKeychainUsageEnabled: false,
};

function normalizeSource(value: unknown): UsageLimitSourceConfig | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const url = typeof raw["url"] === "string" ? raw["url"].trim() : "";
  if (raw["kind"] !== "cliproxy" || url.length === 0) return null;
  const label = typeof raw["label"] === "string" ? raw["label"].trim() : "";
  return {
    kind: "cliproxy",
    ...(label ? { label } : {}),
    url,
    managementKey: typeof raw["managementKey"] === "string" ? raw["managementKey"].trim() : "",
    enabled: raw["enabled"] !== false,
  };
}

export function normalizeUsageLimitsSettings(value: unknown): UsageLimitsSettings {
  if (typeof value !== "object" || value === null) return DEFAULT_SETTINGS;
  const raw = value as Record<string, unknown>;
  const usageLimitSources: Record<string, UsageLimitSourceConfig> = {};
  const sources = raw["usageLimitSources"];
  if (typeof sources === "object" && sources !== null) {
    for (const [id, source] of Object.entries(sources)) {
      const normalized = normalizeSource(source);
      if (id.trim() && normalized) usageLimitSources[id.trim()] = normalized;
    }
  }
  return {
    usageLimitSources,
    cursorKeychainUsageEnabled: raw["cursorKeychainUsageEnabled"] === true,
  };
}

/** 页面看到的设置：不含管理密钥，只告诉它有没有设置 */
export function settingsView(settings: UsageLimitsSettings): UsageLimitsSettingsView {
  return {
    usageLimitSources: Object.entries(settings.usageLimitSources).map(([id, source]) => ({
      id,
      kind: source.kind,
      ...(source.label ? { label: source.label } : {}),
      url: source.url,
      hasManagementKey: source.managementKey.length > 0,
      enabled: source.enabled,
    })),
    cursorKeychainUsageEnabled: settings.cursorKeychainUsageEnabled,
  };
}

/** 按条目合并，null 删除；没传 managementKey 时沿用原来的密钥 */
export function applyUsageLimitsSettingsPatch(
  current: UsageLimitsSettings,
  patch: UsageLimitsSettingsPatch,
): UsageLimitsSettings {
  const usageLimitSources: Record<string, UsageLimitSourceConfig> = {
    ...current.usageLimitSources,
  };
  for (const [key, value] of Object.entries(patch.usageLimitSources ?? {})) {
    const id = key.trim();
    if (!id) continue;
    if (value === null) {
      delete usageLimitSources[id];
      continue;
    }
    const merged = normalizeSource({
      ...value,
      managementKey: value.managementKey ?? current.usageLimitSources[id]?.managementKey ?? "",
    });
    if (merged) usageLimitSources[id] = merged;
  }
  return {
    usageLimitSources,
    cursorKeychainUsageEnabled:
      patch.cursorKeychainUsageEnabled ?? current.cursorKeychainUsageEnabled,
  };
}

export interface UsageLimitsSettingsStore {
  read(): Promise<UsageLimitsSettings>;
  update(patch: UsageLimitsSettingsPatch): Promise<UsageLimitsSettings>;
}

export function createUsageLimitsSettingsStore(stateDir: string): UsageLimitsSettingsStore {
  const file = path.join(stateDir, "settings.json");
  const read = async () => {
    try {
      return normalizeUsageLimitsSettings(JSON.parse(await fs.readFile(file, "utf8")));
    } catch {
      return DEFAULT_SETTINGS;
    }
  };
  // 串行更新，避免两次保存互相覆盖
  let tail: Promise<unknown> = Promise.resolve();
  const update = (patch: UsageLimitsSettingsPatch) => {
    const run = tail.then(async () => {
      const next = applyUsageLimitsSettingsPatch(await read(), patch);
      await writeFileAtomic(file, JSON.stringify(next, null, 2));
      return next;
    });
    tail = run.catch(() => undefined);
    return run;
  };
  return { read, update };
}
