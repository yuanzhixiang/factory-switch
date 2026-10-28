// token 统计的用户设置（自定义价格、模型别名），对应 T3 服务端设置里的 usagePriceOverrides / usageModelAliases
import fs from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_TOKEN_USAGE_SETTINGS,
  type TokenUsageSettings,
  type TokenUsageSettingsPatch,
  type UsageModelPriceOverride,
} from "../../shared/token-usage";
import { writeFileAtomic } from "../fs-utils";

function isPrice(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPriceOverride(value: unknown): value is UsageModelPriceOverride {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    isPrice(entry["inputCostPerMillionTokens"]) &&
    isPrice(entry["outputCostPerMillionTokens"]) &&
    (entry["cacheReadCostPerMillionTokens"] === undefined ||
      isPrice(entry["cacheReadCostPerMillionTokens"])) &&
    (entry["cacheWriteCostPerMillionTokens"] === undefined ||
      isPrice(entry["cacheWriteCostPerMillionTokens"]))
  );
}

/** 只保留合法条目，模型名去掉首尾空白，空名丢弃 */
export function normalizeTokenUsageSettings(value: unknown): TokenUsageSettings {
  if (typeof value !== "object" || value === null) return DEFAULT_TOKEN_USAGE_SETTINGS;
  const raw = value as Record<string, unknown>;
  const usagePriceOverrides: Record<string, UsageModelPriceOverride> = {};
  const overrides = raw["usagePriceOverrides"];
  if (typeof overrides === "object" && overrides !== null) {
    for (const [model, price] of Object.entries(overrides)) {
      const key = model.trim();
      if (key.length > 0 && isPriceOverride(price)) usagePriceOverrides[key] = price;
    }
  }
  const usageModelAliases: Record<string, string> = {};
  const aliases = raw["usageModelAliases"];
  if (typeof aliases === "object" && aliases !== null) {
    for (const [model, target] of Object.entries(aliases)) {
      const key = model.trim();
      if (key.length > 0 && typeof target === "string" && target.trim().length > 0) {
        usageModelAliases[key] = target.trim();
      }
    }
  }
  return { usagePriceOverrides, usageModelAliases };
}

/** 补丁按条目合并，null 删除条目 */
function mergeEntries<T>(
  current: Readonly<Record<string, T>>,
  patch: Readonly<Record<string, T | null>> | undefined,
): Record<string, T> {
  const merged: Record<string, T> = { ...current };
  for (const [key, value] of Object.entries(patch ?? {})) {
    const name = key.trim();
    if (value === null) delete merged[name];
    else merged[name] = value;
  }
  return merged;
}

export interface TokenUsageSettingsStore {
  read(): Promise<TokenUsageSettings>;
  update(patch: TokenUsageSettingsPatch): Promise<TokenUsageSettings>;
}

export function createTokenUsageSettingsStore(stateDir: string): TokenUsageSettingsStore {
  const file = path.join(stateDir, "settings.json");
  const read = async () => {
    try {
      return normalizeTokenUsageSettings(JSON.parse(await fs.readFile(file, "utf8")));
    } catch {
      return DEFAULT_TOKEN_USAGE_SETTINGS;
    }
  };
  // 串行更新，避免两次保存互相覆盖
  let tail: Promise<unknown> = Promise.resolve();
  const update = (patch: TokenUsageSettingsPatch) => {
    const run = tail.then(async () => {
      const current = await read();
      const next = normalizeTokenUsageSettings({
        usagePriceOverrides: mergeEntries(current.usagePriceOverrides, patch.usagePriceOverrides),
        usageModelAliases: mergeEntries(current.usageModelAliases, patch.usageModelAliases),
      });
      await writeFileAtomic(file, JSON.stringify(next, null, 2));
      return next;
    });
    tail = run.catch(() => undefined);
    return run;
  };
  return { read, update };
}
