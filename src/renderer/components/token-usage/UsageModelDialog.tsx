// 单个模型的详情弹窗，移植自 T3 Code（MIT）apps/web/src/components/usage/UsageModelDialog.tsx
import {
  cacheHitRate,
  costPerMillionTokens,
  costTypeSegments,
  speedCostSegments,
  tokenTypeSegments,
} from "../../lib/token-usage/breakdown";
import { formatPercent, formatTokens, formatUsd } from "../../lib/token-usage/format";
import { isModelCostUnknown, type ModelTotals } from "../../lib/token-usage/merge";
import { PROVIDER_PRESENTATION } from "../../lib/token-usage/providers";
import { mergeAnsweredUsage, type EnvironmentUsageStatus } from "../../lib/token-usage/store";
import { Button } from "../shared/Button";
import { ProviderMark } from "./ProviderMark";
import { UsageProviderChart, type UsageChartMetric } from "./UsageProviderChart";
import { UsageShareBar } from "./UsageShareBar";
import { Dialog } from "./ui";

export interface UsageChartWindow {
  readonly days: readonly string[];
  readonly hours: readonly string[];
  readonly resolution: "day" | "hour";
  readonly timeZone: string;
  readonly referenceTime: string | undefined;
  readonly hour12: boolean;
}

export function UsageModelDialog({
  model,
  environments,
  metric,
  chartWindow,
  onSetPrice,
  onClose,
}: {
  readonly model: ModelTotals;
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly metric: UsageChartMetric;
  readonly chartWindow: UsageChartWindow;
  readonly onSetPrice: () => void;
  readonly onClose: () => void;
}) {
  const usage = mergeAnsweredUsage(
    environments,
    (bucket) => bucket.provider === model.provider && bucket.model === model.model,
  );
  const providers = [model.provider];
  const presentation = PROVIDER_PRESENTATION[model.provider];
  const costUnknown = isModelCostUnknown(model);
  const hitRate = cacheHitRate(model);
  const perMillion = costPerMillionTokens(model);
  const stats = [
    { label: "费用", value: costUnknown ? "无价格" : formatUsd(model.costUsd) },
    { label: "Tokens", value: formatTokens(model.totalTokens) },
    perMillion === null ? null : { label: "每百万 token", value: formatUsd(perMillion) },
    hitRate === null ? null : { label: "缓存命中", value: formatPercent(hitRate) },
  ].filter((stat) => stat !== null);

  return (
    <Dialog
      className="max-w-3xl"
      title={model.model}
      titleAside={<ProviderMark provider={model.provider} className="size-5" />}
      description={`${presentation.label}${costUnknown ? "" : ` · 占费用 ${formatPercent(model.costShare)}`}`}
      onClose={onClose}
      footer={
        model.unpricedTokens > 0 ? (
          <>
            <span className="text-xs text-muted-foreground">
              {formatTokens(model.unpricedTokens)} token 没有已知价格
            </span>
            <Button variant="primary" onClick={onSetPrice}>
              设置价格
            </Button>
          </>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-8">
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
          {stats.map((stat) => (
            <div key={stat.label} className="flex min-w-0 flex-col gap-0.5">
              <span className="text-xs text-muted-foreground">{stat.label}</span>
              <span className="text-2xl font-semibold text-foreground tabular-nums">
                {stat.value}
              </span>
            </div>
          ))}
        </div>

        {/* 没有价格时费用是未知而不是 0，所以趋势改看 token */}
        <UsageProviderChart
          providers={providers}
          days={chartWindow.days}
          daily={usage.daily}
          hours={chartWindow.hours}
          hourly={usage.hourly}
          metric={costUnknown ? "tokens" : metric}
          referenceTime={chartWindow.referenceTime}
          resolution={chartWindow.resolution}
          timeZone={chartWindow.timeZone}
          hour12={chartWindow.hour12}
        />

        <div className="grid gap-x-10 gap-y-8 sm:grid-cols-2">
          {costUnknown ? null : (
            <UsageShareBar
              label="按类型的费用"
              segments={costTypeSegments(usage.categoryCost)}
              format={formatUsd}
            />
          )}
          <UsageShareBar
            label="按类型的 token"
            segments={tokenTypeSegments(model.tokens)}
            format={formatTokens}
          />
          {usage.speedCost.fast + usage.speedCost.ultrafast > 0 ? (
            <UsageShareBar
              label="按速度档位的费用"
              segments={speedCostSegments(usage.speedCost)}
              format={formatUsd}
              aside={<SpeedPremium premiumUsd={usage.speedCost.premium} />}
            />
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}

export function SpeedPremium({ premiumUsd }: { readonly premiumUsd: number }) {
  return (
    <span className="text-xs text-muted-foreground">
      加速溢价 <span className="text-foreground tabular-nums">{formatUsd(premiumUsd)}</span>
    </span>
  );
}
