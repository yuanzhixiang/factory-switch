// 明细排序、单价、缓存命中率和占比条分段，移植自 T3 Code（MIT）apps/web/src/components/usage/usageBreakdown.ts
import type { UsageTokenTotals } from "../../../shared/token-usage";
import {
  isModelCostUnknown,
  type CategoryCost,
  type ModelTotals,
  type SpeedCost,
} from "./merge";

export interface ShareSegment {
  readonly label: string;
  readonly value: number;
  readonly color: string;
}

export function sortModelsByTokens(models: readonly ModelTotals[]) {
  return models.toSorted(
    (left, right) => right.totalTokens - left.totalTokens || right.costUsd - left.costUsd,
  );
}

/** 费用未知时费用占比为 null；没有价格的模型仍有 token 占比 */
export function modelShare(model: ModelTotals, metric: "cost" | "tokens"): number | null {
  if (metric === "tokens") return model.tokenShare;
  return isModelCostUnknown(model) ? null : model.costShare;
}

/** 没有输入时返回 null；缓存写入算未命中，因为这部分输入是完整处理过的 */
export function cacheHitRate({ tokens }: ModelTotals): number | null {
  const input = tokens.uncachedInputTokens + tokens.cachedInputTokens + tokens.cacheCreationTokens;
  return input === 0 ? null : tokens.cachedInputTokens / input;
}

/** 有价格部分的每百万 token 实际单价；完全没有价格时返回 null */
export function costPerMillionTokens(model: ModelTotals): number | null {
  const pricedTokens = model.totalTokens - model.unpricedTokens;
  return pricedTokens <= 0 || isModelCostUnknown(model)
    ? null
    : (model.costUsd / pricedTokens) * 1_000_000;
}

const ink = (percent: number) =>
  `color-mix(in oklab, var(--foreground) ${percent}%, var(--background))`;

const TYPE_COLORS = {
  input: ink(60),
  cacheRead: ink(30),
  cacheWrite: ink(72),
  output: ink(100),
  other: ink(44),
};

export function costTypeSegments(cost: CategoryCost): readonly ShareSegment[] {
  return [
    { label: "输入", value: cost.input, color: TYPE_COLORS.input },
    { label: "缓存读取", value: cost.cacheRead, color: TYPE_COLORS.cacheRead },
    { label: "缓存写入", value: cost.cacheWrite, color: TYPE_COLORS.cacheWrite },
    { label: "输出", value: cost.output, color: TYPE_COLORS.output },
    { label: "其他", value: cost.unsplit >= 0.005 ? cost.unsplit : 0, color: TYPE_COLORS.other },
  ];
}

export function tokenTypeSegments(
  tokens: Omit<UsageTokenTotals, "reasoningTokens">,
): readonly ShareSegment[] {
  return [
    { label: "输入", value: tokens.uncachedInputTokens, color: TYPE_COLORS.input },
    { label: "缓存读取", value: tokens.cachedInputTokens, color: TYPE_COLORS.cacheRead },
    { label: "缓存写入", value: tokens.cacheCreationTokens, color: TYPE_COLORS.cacheWrite },
    { label: "输出", value: tokens.outputTokens, color: TYPE_COLORS.output },
  ];
}

export function speedCostSegments(cost: SpeedCost): readonly ShareSegment[] {
  return [
    { label: "标准", value: cost.standard, color: ink(34) },
    { label: "Fast", value: cost.fast, color: ink(66) },
    { label: "Ultrafast", value: cost.ultrafast, color: ink(100) },
  ];
}
