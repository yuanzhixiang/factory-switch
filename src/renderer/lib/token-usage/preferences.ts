// 用量页偏好（指标、时间段、隐藏的提供方），移植自 T3 Code（MIT）apps/web/src/components/usage/usagePagePreferences.ts
// 改动：T3 用 Effect Schema 校验，这里手写校验；默认指标是 Tokens（T3 默认是额度）。
import { USAGE_PROVIDER_KINDS, type UsageProviderKind } from "../../../shared/token-usage";

const STORAGE_KEY = "token-usage-page-preferences:v1";

export const USAGE_METRICS = ["cost", "tokens", "limits"] as const;
export type UsageMetric = (typeof USAGE_METRICS)[number];
export const USAGE_WINDOW_DAYS = [1, 7, 30, 90] as const;
export type UsageWindowDays = (typeof USAGE_WINDOW_DAYS)[number];

export interface UsagePagePreferences {
  readonly metric: UsageMetric;
  readonly windowDays: UsageWindowDays;
  readonly hiddenProviders?: readonly UsageProviderKind[];
}

export const DEFAULT_PREFERENCES: UsagePagePreferences = { metric: "tokens", windowDays: 30 };

function decodePreferences(raw: string | null): UsagePagePreferences | null {
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const metric = USAGE_METRICS.find((entry) => entry === record["metric"]);
  const windowDays = USAGE_WINDOW_DAYS.find((entry) => entry === record["windowDays"]);
  if (metric === undefined || windowDays === undefined) return null;
  const hidden = record["hiddenProviders"];
  if (hidden === undefined) return { metric, windowDays };
  if (
    !Array.isArray(hidden) ||
    !hidden.every((entry) => (USAGE_PROVIDER_KINDS as readonly unknown[]).includes(entry))
  ) {
    return null;
  }
  return { metric, windowDays, hiddenProviders: hidden as UsageProviderKind[] };
}

export function readUsagePagePreferences(): UsagePagePreferences {
  try {
    return decodePreferences(window.localStorage.getItem(STORAGE_KEY)) ?? DEFAULT_PREFERENCES;
  } catch (error) {
    console.error("读取用量页偏好失败", error);
    return DEFAULT_PREFERENCES;
  }
}

export function saveUsagePagePreferences(preferences: UsagePagePreferences): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch (error) {
    console.error("保存用量页偏好失败", error);
  }
}
