// Claude 订阅额度的换算，移植自 T3 Code（MIT）apps/server/src/provider/claudeUsageLimits.ts
import type {
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "../../shared/usage-limits";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
  type ProviderUsageLimitsUpdate,
} from "./common";

/** SDK 的 get_usage 返回里额度页用到的部分 */
export interface ClaudeUsageWindowResponse {
  readonly utilization: number | null;
  readonly resets_at: string | null;
}

export interface ClaudeRateLimits {
  readonly five_hour?: ClaudeUsageWindowResponse | null;
  readonly seven_day?: ClaudeUsageWindowResponse | null;
  readonly extra_usage?: {
    readonly is_enabled?: boolean | null;
    readonly used_credits?: number | null;
    readonly monthly_limit?: number | null;
    readonly utilization?: number | null;
  } | null;
  readonly [key: string]: unknown;
}

export interface ClaudeUsageResponse {
  readonly rate_limits_available: boolean;
  readonly rate_limits?: ClaudeRateLimits | null;
}

/** SDK 流式 rate_limit 事件 */
export interface ClaudeRateLimitInfo {
  readonly status?: string;
  readonly rateLimitType?: string;
  readonly utilization?: number;
  readonly resetsAt?: number;
}

const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;

const WINDOWS: Readonly<
  Record<string, Pick<ServerProviderUsageWindow, "kind" | "label" | "windowDurationMins">>
> = {
  five_hour: { kind: "session", label: "Session", windowDurationMins: SESSION_MINS },
  seven_day: { kind: "weekly", label: "Weekly", windowDurationMins: WEEK_MINS },
};

/** 流式事件里的桶类型沿用探测到的显示名，保证更新落到同一行 */
const OVERAGE_INCLUDED_EVENT_TYPE = "seven_day_overage_included";

// SDK 还没给 `get_usage` 返回的消费预算写类型
interface SpendMoney {
  readonly amount_minor: number;
  readonly currency: string;
  readonly exponent: number;
}

function isNatural(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function readSpendMoney(value: unknown): SpendMoney | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const money = value as Record<string, unknown>;
  return isNatural(money["amount_minor"]) &&
    typeof money["currency"] === "string" &&
    money["currency"].length > 0 &&
    isNatural(money["exponent"])
    ? (money as unknown as SpendMoney)
    : undefined;
}

function decodeSpendBudget(
  value: unknown,
): { readonly enabled: boolean; readonly used: SpendMoney; readonly limit: SpendMoney } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const spend = value as Record<string, unknown>;
  const used = readSpendMoney(spend["used"]);
  const limit = readSpendMoney(spend["limit"]);
  return typeof spend["enabled"] === "boolean" && used && limit
    ? { enabled: spend["enabled"], used, limit }
    : undefined;
}

export interface ClaudeScopedLimitNames {
  readonly overageIncluded: string | undefined;
}

function scopedWindowId(displayName: string): string {
  return `seven_day_${displayName.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
}

function scopedWindow(
  displayName: string,
  usedPercent: number,
  resetsAt: string | undefined,
): ServerProviderUsageWindow {
  return {
    id: scopedWindowId(displayName),
    kind: "weekly",
    label: `Weekly · ${displayName}`,
    windowDurationMins: WEEK_MINS,
    usedPercent: clampPercent(usedPercent),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

function percentFromAmounts(used: number | null | undefined, limit: number | null | undefined) {
  if (
    typeof used !== "number" ||
    typeof limit !== "number" ||
    !Number.isFinite(used) ||
    !Number.isFinite(limit) ||
    used < 0 ||
    limit <= 0
  ) {
    return undefined;
  }
  const percent = (used / limit) * 100;
  return Number.isFinite(percent) ? clampPercent(percent) : undefined;
}

function readSpendPercent(rateLimits: ClaudeRateLimits) {
  const spend = decodeSpendBudget((rateLimits as { readonly spend?: unknown }).spend);
  // 按最小货币单位算比例要求币种和精度一致；spend.percent 是取整过的
  if (
    spend?.enabled &&
    spend.used.currency.trim().length > 0 &&
    spend.used.currency.trim() === spend.limit.currency.trim() &&
    spend.used.exponent === spend.limit.exponent
  ) {
    const percent = percentFromAmounts(spend.used.amount_minor, spend.limit.amount_minor);
    if (percent !== undefined) return percent;
  }

  const extra = rateLimits.extra_usage;
  if (extra?.is_enabled !== true) return undefined;
  const percent = percentFromAmounts(extra.used_credits, extra.monthly_limit) ?? extra.utilization;
  return typeof percent === "number" && Number.isFinite(percent) && percent >= 0
    ? clampPercent(percent)
    : undefined;
}

/** `model_scoped` 比固定版本的 SDK 类型新，先按结构读 */
interface ModelScopedWindow {
  readonly display_name: string;
  readonly utilization: number | null;
  readonly resets_at: string | null;
}

function readModelScoped(rateLimits: object): ReadonlyArray<ModelScopedWindow> {
  const raw = (rateLimits as { readonly model_scoped?: unknown }).model_scoped;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is ModelScopedWindow =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as ModelScopedWindow).display_name === "string",
  );
}

function isoFromEpochSeconds(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function isoFromString(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function makeWindow(
  id: keyof typeof WINDOWS & string,
  usedPercent: number,
  resetsAt: string | undefined,
): ServerProviderUsageWindow {
  const window = WINDOWS[id]!;
  return {
    id,
    ...window,
    usedPercent: clampPercent(usedPercent),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

/** 流式事件的 utilization 是 0-1；未探测到名字的超额桶先丢弃，避免出现对不上的行 */
export function claudeRateLimitEventToUpdate(
  info: ClaudeRateLimitInfo,
  names: ClaudeScopedLimitNames,
): ProviderUsageLimitsUpdate | undefined {
  const type: string | undefined = info.rateLimitType;
  if (!type || typeof info.utilization !== "number") {
    return undefined;
  }
  const usedPercent = info.utilization * 100;
  const resetsAt = isoFromEpochSeconds(info.resetsAt);
  if (type in WINDOWS) {
    return { windows: [makeWindow(type, usedPercent, resetsAt)] };
  }
  if (type === OVERAGE_INCLUDED_EVENT_TYPE && names.overageIncluded) {
    return { windows: [scopedWindow(names.overageIncluded, usedPercent, resetsAt)] };
  }
  return undefined;
}

/** get_usage 的百分比已经是 0-100 */
export function claudeUsageResponseToLimits(input: {
  readonly response: ClaudeUsageResponse;
  readonly checkedAt: string;
}): { readonly limits: ServerProviderUsageLimits; readonly names: ClaudeScopedLimitNames } {
  const { response, checkedAt } = input;
  if (!response.rate_limits_available || !response.rate_limits) {
    return {
      limits: makeUnavailableUsageLimits({
        checkedAt,
        reason: response.rate_limits_available ? "probeFailed" : "unsupported",
      }),
      names: { overageIncluded: undefined },
    };
  }
  const windows: ServerProviderUsageWindow[] = [];
  for (const id of Object.keys(WINDOWS)) {
    const window = response.rate_limits[id as "five_hour" | "seven_day"];
    if (!window || typeof window.utilization !== "number") continue;
    windows.push(makeWindow(id, window.utilization, isoFromString(window.resets_at)));
  }
  // CLI 的超额白名单目前只有一个模型，事件指的是第一个
  let overageIncluded: string | undefined;
  for (const entry of readModelScoped(response.rate_limits)) {
    if (typeof entry.utilization !== "number") continue;
    windows.push(
      scopedWindow(entry.display_name, entry.utilization, isoFromString(entry.resets_at)),
    );
    overageIncluded ??= entry.display_name;
  }
  const spendPercent = readSpendPercent(response.rate_limits);
  if (spendPercent !== undefined) {
    windows.push({
      id: "monthly_spend",
      kind: "monthly",
      label: "Monthly spend",
      usedPercent: spendPercent,
    });
  }
  return {
    limits: makeUsageLimits({ checkedAt, windows }),
    names: { overageIncluded },
  };
}

