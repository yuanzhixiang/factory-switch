// 本地 token 统计的数据契约，移植自 T3 Code（MIT）packages/contracts/src/usage.ts
// 主进程扫描各家 CLI 的本地日志后按「天/小时 × 提供方 × 模型」聚合成 bucket 交给页面。

/** 不兼容的 UsageSummary 改动时递增 */
export const USAGE_CONTRACT_VERSION = 6 as const;

export const USAGE_PROVIDER_KINDS = [
  "claude",
  "codex",
  "grok",
  "cursor",
  "opencode",
  "antigravity",
  "pi",
  "muse",
] as const;
export type UsageProviderKind = (typeof USAGE_PROVIDER_KINDS)[number];

/** YYYY-MM-DD，按 UsageSummaryInput.timeZone 划分的日历日 */
export type UsageDay = string;

export type UsageResolution = "day" | "hour";

export type UsageCostSource = "providerReported" | "modelPriced" | "unpriced";

/** 输入合计 = 未缓存输入 + 缓存读取 + 缓存写入；reasoning 已包含在 output 里 */
export interface UsageTokenTotals {
  readonly uncachedInputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
}

export interface UsageCategoryCost {
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
}

export interface UsageBucket {
  readonly day: UsageDay;
  readonly hourStart?: string;
  readonly provider: UsageProviderKind;
  readonly model: string;
  readonly sourcePath?: string;
  readonly totals: UsageTokenTotals;
  readonly costUsd: number;
  readonly cacheSavingsUsd: number;
  readonly categoryCostUsd?: UsageCategoryCost;
  readonly fastCostUsd?: number;
  readonly ultrafastCostUsd?: number;
  readonly speedPremiumUsd?: number;
  readonly costSource: UsageCostSource;
  readonly records: number;
  readonly unpricedRecords: number;
  readonly sessions: number;
}

export interface UsageSourceFingerprint {
  readonly hostId: string;
  readonly provider: UsageProviderKind;
  readonly resolvedHomePath: string;
  /** 日志目录的 device:inode，区分主机名和路径都相同的两台机器 */
  readonly volumeId: string;
}

export type UsageSourceStatus = "ok" | "missing" | "partial" | "failed";

export interface UsageSource {
  readonly fingerprint: UsageSourceFingerprint;
  readonly status: UsageSourceStatus;
  readonly scannedFiles: number;
  readonly skippedFiles: number;
  readonly malformedRecords: number;
  /** 会话可能跨天跨模型，bucket 上的会话数会重复计算，合计用这个 */
  readonly distinctSessions: number;
  readonly message: string | null;
  readonly action?: "enableCursorKeychain";
  /** 正在后台刷新时返回的缓存结果 */
  readonly refreshing?: true;
}

export type UsagePricingStatus = "fresh" | "cached" | "unavailable";

export interface UsagePricing {
  readonly status: UsagePricingStatus;
  readonly source: string;
  readonly fetchedAt: string | null;
  readonly knownModels: number;
}

export interface UsageSummaryInput {
  readonly sinceDay: UsageDay;
  readonly untilDay: UsageDay;
  /** IANA 时区名，用来划分日期 */
  readonly timeZone: string;
  readonly resolution?: UsageResolution;
  readonly sinceTime?: string;
  readonly untilTime?: string;
  readonly awaitRefresh?: boolean;
}

export interface UsageSummary {
  readonly contractVersion: number;
  readonly readAt: string;
  readonly timeZone: string;
  readonly sinceDay: UsageDay;
  readonly untilDay: UsageDay;
  readonly buckets: readonly UsageBucket[];
  readonly sources: readonly UsageSource[];
  readonly pricing: UsagePricing;
  readonly scanDurationMs: number;
}

/** 每百万 token 的美元价格；缓存价缺省时按输入价 */
export interface UsageModelPriceOverride {
  readonly inputCostPerMillionTokens: number;
  readonly outputCostPerMillionTokens: number;
  readonly cacheReadCostPerMillionTokens?: number;
  readonly cacheWriteCostPerMillionTokens?: number;
}

/** token 统计的用户设置，存在 ~/.factory-switch/token-usage/settings.json */
export interface TokenUsageSettings {
  readonly usagePriceOverrides: Readonly<Record<string, UsageModelPriceOverride>>;
  readonly usageModelAliases: Readonly<Record<string, string>>;
}

export const DEFAULT_TOKEN_USAGE_SETTINGS: TokenUsageSettings = {
  usagePriceOverrides: {},
  usageModelAliases: {},
};

/** 按条目合并，null 表示删除该条目（和 T3 的 ServerSettingsPatch 一致） */
export interface TokenUsageSettingsPatch {
  readonly usagePriceOverrides?: Readonly<Record<string, UsageModelPriceOverride | null>>;
  readonly usageModelAliases?: Readonly<Record<string, string | null>>;
}

export type TokenUsageResult =
  | { readonly ok: true; readonly summary: UsageSummary }
  | { readonly ok: false; readonly reason: "scanFailed" | "invalidWindow"; readonly message: string };
