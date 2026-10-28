// Token 统计页，移植自 T3 Code（MIT）apps/web/src/components/usage/UsagePage.tsx
// 改动：
// - 放在 Factory 页右侧主区域，而不是 T3 的全屏浮层；
// - 只有本机一个来源，T3 的「环境」筛选保留为「本机」菜单（扫描状态、模型价格入口）；
// - 「额度」页签、ChatGPT 共享用量、Cursor 钥匙串授权行属于后续批次，这一批不显示；
// - 快捷键固定为 T3 的默认绑定：C 费用、T Tokens、⌘⇧1~4 切换时间段。
import { useEffect, useEffectEvent, useState } from "react";
import type { UsageProviderKind, UsageSummaryInput } from "../../../shared/token-usage";
import {
  costTypeSegments,
  modelShare,
  sortModelsByTokens,
  speedCostSegments,
  tokenTypeSegments,
} from "../../lib/token-usage/breakdown";
import {
  enumerateDays,
  enumerateHourStarts,
  formatCount,
  formatDateTimeShort,
  formatDayShort,
  formatHourShort,
  formatPercent,
  formatTokens,
  formatUsageContractMismatch,
  formatUsd,
} from "../../lib/token-usage/format";
import {
  isCompatibleUsageContractVersion,
  isModelCostUnknown,
  type DailyTotals,
  type HourlyTotals,
  type MergedUsage,
} from "../../lib/token-usage/merge";
import type { UsageMetric, UsageWindowDays } from "../../lib/token-usage/preferences";
import {
  updatingProvidersLabel,
  usageEnvironmentProgress,
  usageLoadingState,
} from "../../lib/token-usage/progress";
import {
  PROVIDER_ORDER,
  PROVIDER_PRESENTATION,
  providersWithUsage,
} from "../../lib/token-usage/providers";
import {
  advanceWindow,
  ensureSummary,
  refreshSummary,
  selectWindow,
  updatePreferences,
  useHiddenProviders,
  usePreviousUsage,
  useTokenUsageState,
  useUsage,
  type EnvironmentUsageStatus,
} from "../../lib/token-usage/store";
import { USAGE_CONTRACT_VERSION } from "../../../shared/token-usage";
import { formatChange } from "../../lib/token-usage/compare";
import { ProviderMark } from "./ProviderMark";
import { SpeedPremium, UsageModelDialog } from "./UsageModelDialog";
import { UsagePriceOverrides } from "./UsagePriceOverrides";
import { UsageProviderChart } from "./UsageProviderChart";
import { UsageShareBar } from "./UsageShareBar";
import {
  AlertIcon,
  ChevronDownIcon,
  Dropdown,
  HoverTip,
  IconButton,
  InfoIcon,
  MenuCheckboxItem,
  MenuItem,
  MenuSeparator,
  RefreshIcon,
  Segmented,
  Skeleton,
  SlidersIcon,
  cn,
} from "./ui";

/** 本应用统一用 24 小时制 */
const HOUR12 = false;

const METRIC_OPTIONS = [
  { value: "cost", label: "费用", shortcut: "C" },
  { value: "tokens", label: "Tokens", shortcut: "T" },
] as const satisfies readonly { value: UsageMetric; label: string; shortcut: string }[];

const WINDOW_OPTIONS = [
  { days: 1, label: "24 小时", shortcut: "⌘⇧1" },
  { days: 7, label: "7 天", shortcut: "⌘⇧2" },
  { days: 30, label: "30 天", shortcut: "⌘⇧3" },
  { days: 90, label: "90 天", shortcut: "⌘⇧4" },
] as const satisfies readonly { days: UsageWindowDays; label: string; shortcut: string }[];

const providerLabel = (provider: UsageProviderKind) => PROVIDER_PRESENTATION[provider].label;

/** 输入框、弹窗里按键不触发页面快捷键 */
function isShortcutTarget(target: EventTarget | null): boolean {
  return !(
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT" ||
      target.isContentEditable ||
      target.closest("dialog[open], [role='menu']"))
  );
}

function usageLoading(
  showingKept: boolean,
  selectedEnvironments: readonly EnvironmentUsageStatus[],
  refreshingUsage: boolean,
  hiddenProviders: ReadonlySet<UsageProviderKind>,
) {
  if (showingKept) {
    return { partial: true, everyProvider: true, providers: new Set<UsageProviderKind>() };
  }
  const state = usageLoadingState(selectedEnvironments, refreshingUsage);
  const providers = new Set([...state.providers].filter((p) => !hiddenProviders.has(p)));
  return {
    partial: state.everyProvider || providers.size > 0,
    everyProvider: state.everyProvider,
    providers,
  };
}

export function TokenUsagePage() {
  const { preferences, windowSelection } = useTokenUsageState();
  const metric = preferences.metric;
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [priceDialog, setPriceDialog] = useState<{ readonly model?: string } | null>(null);
  const [selectedModelKey, setSelectedModelKey] = useState<string | null>(null);
  const [selectedEnvironmentIds, setSelectedEnvironmentIds] =
    useState<ReadonlySet<string> | null>(null);
  const hiddenProviders = useHiddenProviders();
  const { days: windowDays, window } = windowSelection;
  const { merged: answeredUsage, environments, selectedEnvironments, shown, isPartial } =
    useUsage(window, selectedEnvironmentIds, hiddenProviders);
  const merged = shown?.merged ?? answeredUsage;
  const shownWindow = shown?.window ?? window;
  const shownHourly = shownWindow.resolution === "hour";
  const refreshingUsage = isRefreshing;
  const showingKept = shown !== null && shown.window !== window;
  // 只看一家提供方时显示环比
  const compareEnabled =
    PROVIDER_ORDER.filter((provider) => !hiddenProviders.has(provider)).length === 1;
  const previous = usePreviousUsage(shownWindow, hiddenProviders, compareEnabled);

  // 窗口变化时取数据；60 秒内的结果直接复用
  useEffect(() => {
    ensureSummary(window);
  }, [window]);

  const refreshWindow = () => {
    if (isRefreshing) return;
    const nextWindow = advanceWindow();
    setIsRefreshing(true);
    void refreshSummary(nextWindow).finally(() => setIsRefreshing(false));
  };

  const onUsageKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.repeat || event.isComposing) return;
    if (!isShortcutTarget(event.target)) return;
    const mod = event.metaKey || event.ctrlKey;
    let handled = true;
    if (!mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "c") {
      updatePreferences({ metric: "cost" });
    } else if (!mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "t") {
      updatePreferences({ metric: "tokens" });
    } else if (mod && event.shiftKey && /^Digit[1-4]$/.test(event.code)) {
      const option = WINDOW_OPTIONS[Number(event.code.slice(5)) - 1];
      if (option) selectWindow(option.days);
    } else {
      handled = false;
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  });

  useEffect(() => {
    const listener = (event: KeyboardEvent) => onUsageKeyDown(event);
    globalThis.addEventListener("keydown", listener, true);
    return () => globalThis.removeEventListener("keydown", listener, true);
  }, []);

  const days = enumerateDays(shownWindow.sinceDay, shownWindow.untilDay);
  const hours =
    shownWindow.sinceTime === undefined || shownWindow.untilTime === undefined
      ? []
      : enumerateHourStarts(shownWindow.sinceTime, shownWindow.untilTime);

  const windowLabel =
    shownHourly && shownWindow.sinceTime !== undefined && shownWindow.untilTime !== undefined
      ? `${formatDateTimeShort(shownWindow.sinceTime, shownWindow.timeZone, HOUR12)} 至 ${formatDateTimeShort(shownWindow.untilTime, shownWindow.timeZone, HOUR12)}`
      : `${formatDayShort(shownWindow.sinceDay)} 至 ${formatDayShort(shownWindow.untilDay)}`;

  const selectedModel =
    selectedModelKey === null
      ? undefined
      : merged.models.find(
          (candidate) => `${candidate.provider}:${candidate.model}` === selectedModelKey,
        );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-10 py-2">
        <nav aria-label="用量导航" className="flex min-w-0 items-center gap-2 text-sm">
          <h1 className="shrink-0 text-muted-foreground">用量</h1>
          <span className="text-muted-foreground" aria-hidden>
            /
          </span>
          <UsageEnvironmentFilter
            environments={environments}
            selectedEnvironments={selectedEnvironments}
            selectedEnvironmentIds={selectedEnvironmentIds}
            onSelectionChange={setSelectedEnvironmentIds}
            refreshing={refreshingUsage}
            isPartial={isPartial}
            duplicateSources={merged.duplicateSources}
            contractMismatches={merged.contractMismatches}
            onOpenModelPrices={() => setPriceDialog({})}
          />
          <span className="text-muted-foreground" aria-hidden>
            /
          </span>
          <UsageProviderFilter
            hiddenProviders={hiddenProviders}
            onChange={(next) => updatePreferences({ hiddenProviders: next })}
          />
        </nav>
        <span className="hidden min-w-0 truncate text-xs text-muted-foreground xl:block">
          {windowLabel}
        </span>
        <div className="ms-auto flex shrink-0 items-center gap-2">
          <Segmented
            ariaLabel="时间段"
            value={windowDays}
            options={WINDOW_OPTIONS.map((option) => ({
              value: option.days,
              label: option.label,
              title: `${option.label}（${option.shortcut}）`,
            }))}
            onChange={selectWindow}
          />
          <Segmented
            ariaLabel="指标"
            value={metric}
            options={METRIC_OPTIONS.map((option) => ({
              value: option.value,
              label: option.label,
              title: `${option.label}（${option.shortcut}）`,
            }))}
            onChange={(value) => updatePreferences({ metric: value })}
          />
          <IconButton
            onClick={refreshWindow}
            aria-label="刷新用量"
            title="重新扫描并更新价格表"
            aria-busy={isRefreshing}
            disabled={isRefreshing}
          >
            <RefreshIcon refreshing={isRefreshing} />
          </IconButton>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-10 py-8">
          {selectedEnvironments.length === 0 ? (
            <p className="text-sm text-muted-foreground">选择一个来源后查看用量。</p>
          ) : shown === null ? (
            <UsageSkeleton />
          ) : (
            <UsageOverview
              merged={merged}
              shownWindow={shownWindow}
              days={days}
              hours={hours}
              showingKept={showingKept}
              metric={metric}
              selectedEnvironments={selectedEnvironments}
              hiddenProviders={hiddenProviders}
              refreshingUsage={refreshingUsage}
              onSelectModel={setSelectedModelKey}
              previous={compareEnabled ? previous : null}
              onSelectProvider={(provider) => {
                const onlyThis = PROVIDER_ORDER.every(
                  (entry) => (entry === provider) !== hiddenProviders.has(entry),
                );
                // 点一家只看这一家；已经只看这一家时再点恢复全部
                updatePreferences({
                  hiddenProviders: onlyThis
                    ? []
                    : PROVIDER_ORDER.filter((entry) => entry !== provider),
                });
              }}
            />
          )}
        </div>
      </div>
      {selectedModel ? (
        <UsageModelDialog
          model={selectedModel}
          environments={selectedEnvironments}
          metric={metric}
          chartWindow={{
            days,
            hours,
            resolution: shownHourly ? "hour" : "day",
            timeZone: shownWindow.timeZone,
            referenceTime: shownWindow.untilTime,
            hour12: HOUR12,
          }}
          onSetPrice={() => {
            setSelectedModelKey(null);
            setPriceDialog({ model: selectedModel.model });
          }}
          onClose={() => setSelectedModelKey(null)}
        />
      ) : null}
      {priceDialog ? (
        <UsagePriceOverrides
          usage={environments}
          initialSelectedEnvironmentIds={selectedEnvironmentIds}
          initialModel={priceDialog.model}
          onOpenChange={(open) => {
            if (!open) setPriceDialog(null);
          }}
        />
      ) : null}
    </div>
  );
}

function UsageOverview({
  merged,
  shownWindow,
  days,
  hours,
  showingKept,
  metric,
  selectedEnvironments,
  hiddenProviders,
  refreshingUsage,
  onSelectModel,
  onSelectProvider,
  previous,
}: {
  readonly merged: MergedUsage;
  readonly shownWindow: UsageSummaryInput;
  readonly days: readonly string[];
  readonly hours: readonly string[];
  readonly showingKept: boolean;
  readonly metric: UsageMetric;
  readonly selectedEnvironments: readonly EnvironmentUsageStatus[];
  readonly hiddenProviders: ReadonlySet<UsageProviderKind>;
  readonly refreshingUsage: boolean;
  readonly onSelectModel: (key: string) => void;
  readonly onSelectProvider: (provider: UsageProviderKind) => void;
  /** 上一周期，用于环比；null 表示不显示环比 */
  readonly previous: {
    readonly window: UsageSummaryInput;
    readonly merged: MergedUsage | null;
  } | null;
}) {
  const prior = previous?.merged ?? null;
  // 上一周期还没查到时先占位，不显示数字
  const changeOf = (current: number, pick: (usage: MergedUsage) => number) =>
    previous === null ? undefined : prior === null ? "…" : formatChange(current, pick(prior));
  const onlyProvider = PROVIDER_ORDER.filter((provider) => !hiddenProviders.has(provider));
  const [breakdown, setBreakdown] = useState<"model" | "time">("model");
  const shownHourly = shownWindow.resolution === "hour";
  const loading = usageLoading(showingKept, selectedEnvironments, refreshingUsage, hiddenProviders);
  const loadingPartial = loading.partial === true;
  const loadingProviders = new Set(
    PROVIDER_ORDER.filter((provider) => loading.everyProvider || loading.providers.has(provider)),
  );
  const providersWithData = new Set(providersWithUsage(merged.providers));
  const activeProviders = [...PROVIDER_ORDER].filter(
    (provider) => providersWithData.has(provider) || loading.providers.has(provider),
  );
  const chartLoadingProviders = new Set(
    activeProviders.filter((provider) => loadingProviders.has(provider)),
  );
  const sourceMessages = [
    ...new Set(
      selectedEnvironments.flatMap(
        (environment) =>
          environment.summary?.sources.flatMap((source) =>
            source.message &&
            !hiddenProviders.has(source.fingerprint.provider) &&
            (source.status === "partial" ||
              source.status === "failed" ||
              source.fingerprint.provider === "cursor")
              ? [source.message]
              : [],
          ) ?? [],
      ),
    ),
  ];
  const breakdownPeriods: readonly (DailyTotals | HourlyTotals)[] = (
    shownHourly ? merged.hourly : merged.daily
  ).toReversed();
  const breakdownModels =
    breakdown === "model" && metric === "tokens"
      ? sortModelsByTokens(merged.models)
      : merged.models;
  const breakdownPeak = breakdownModels.reduce(
    (peak, model) => Math.max(peak, metric === "tokens" ? model.totalTokens : model.costUsd),
    0,
  );

  return (
    <div aria-busy={loadingPartial} className="flex flex-col gap-10">
      {sourceMessages.length > 0 ? (
        <div className="flex flex-col gap-1">
          {sourceMessages.map((message) => (
            <p key={message} className="text-xs text-warning-foreground">
              {message}
            </p>
          ))}
        </div>
      ) : null}
      <section className="grid gap-8 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <div className="flex flex-col gap-1">
            <span
              className={cn(
                "text-4xl font-semibold text-foreground tabular-nums",
                figureClass(loadingPartial),
              )}
            >
              {metric === "cost" ? formatUsd(merged.costUsd) : formatTokens(merged.totalTokens)}
            </span>
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <span>
                <span className={figureClass(loadingPartial)}>
                  {formatCount(merged.sessions)} 个会话
                </span>
                {metric === "cost" && " · 按 API 价格估算"}
              </span>
              {metric === "cost" && merged.costQuality.unpricedShare > 0 && (
                <HoverTip
                  label="无价格记录说明"
                  tip={`估算未包含 ${formatPercent(merged.costQuality.unpricedShare)} 没有价格的记录。`}
                >
                  <InfoIcon className="size-3" />
                </HoverTip>
              )}
            </span>
            {previous !== null ? (
              <span className="text-xs text-muted-foreground tabular-nums">
                {`上一周期（${formatWindowRange(previous.window)}）：`}
                {prior === null
                  ? "统计中…"
                  : `${
                      metric === "cost" ? formatUsd(prior.costUsd) : formatTokens(prior.totalTokens)
                    } · ${formatCount(prior.sessions)} 个会话 · 环比 ${
                      metric === "cost"
                        ? formatChange(merged.costUsd, prior.costUsd)
                        : formatChange(merged.totalTokens, prior.totalTokens)
                    }`}
              </span>
            ) : null}
          </div>

          {activeProviders.map((provider) => {
            const totals = merged.providers.find((entry) => entry.provider === provider);
            const share = metric === "cost" ? (totals?.costShare ?? 0) : (totals?.tokenShare ?? 0);
            const providerSessions = totals?.sessions ?? 0;
            const providerLoading = loadingProviders.has(provider);
            const awaitingData = providerLoading && !providersWithData.has(provider);
            return (
              <button
                key={provider}
                type="button"
                onClick={() => onSelectProvider(provider)}
                title={
                  onlyProvider.length === 1 && onlyProvider[0] === provider
                    ? "显示全部提供方"
                    : `只看 ${PROVIDER_PRESENTATION[provider].label}`
                }
                className="-mx-2 flex flex-col gap-1 rounded-[2px] px-2 py-1 text-left transition-colors hover:bg-muted"
              >
                <div className="flex w-full items-baseline justify-between gap-4">
                  <span className="flex min-w-0 items-center gap-2 text-sm text-foreground">
                    <span
                      aria-hidden
                      className="size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: PROVIDER_PRESENTATION[provider].color }}
                    />
                    <ProviderMark provider={provider} className="size-4" />
                    <span className="flex min-w-0 items-baseline gap-1.5">
                      <span className="truncate">{PROVIDER_PRESENTATION[provider].label}</span>
                      <span
                        className={cn(
                          "shrink-0 text-[11px] whitespace-nowrap text-muted-foreground tabular-nums",
                          figureClass(providerLoading),
                          awaitingData && "invisible",
                        )}
                      >
                        {formatCount(providerSessions)} 个会话
                      </span>
                    </span>
                  </span>
                  <span
                    className={cn(
                      "shrink-0 text-sm font-medium text-foreground tabular-nums",
                      figureClass(providerLoading),
                    )}
                  >
                    {awaitingData
                      ? "-"
                      : metric === "cost"
                        ? formatUsd(totals?.costUsd ?? 0)
                        : formatTokens(totals?.totalTokens ?? 0)}
                  </span>
                </div>
                <span
                  className={cn(
                    "text-xs text-muted-foreground",
                    figureClass(providerLoading),
                    awaitingData && "invisible",
                  )}
                >
                  {metric === "cost"
                    ? `占费用 ${formatPercent(share)} · ${formatTokens(totals?.totalTokens ?? 0)} token`
                    : `占 token ${formatPercent(share)} · ${formatUsd(totals?.costUsd ?? 0)}`}
                </span>
              </button>
            );
          })}
          {activeProviders.length === 0 ? (
            <p className="text-xs text-muted-foreground">这段时间没有找到任何用量记录。</p>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <h2 className="text-sm text-foreground">
            {shownHourly ? "每小时" : "每日"}
            {metric === "tokens" ? "处理的 token" : "费用"}
          </h2>
          <UsageProviderChart
            providers={activeProviders}
            loadingProviders={chartLoadingProviders}
            days={days}
            daily={merged.daily}
            hours={hours}
            hourly={merged.hourly}
            metric={metric}
            referenceTime={shownWindow.untilTime}
            resolution={shownHourly ? "hour" : "day"}
            timeZone={shownWindow.timeZone}
            hour12={HOUR12}
          />
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm text-foreground">合计</h2>
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 py-1 md:grid-cols-5">
          <Metric
            loading={loadingPartial}
            label="处理的 token"
            value={formatTokens(merged.totalTokens)}
            change={changeOf(merged.totalTokens, (usage) => usage.totalTokens)}
          />
          <Metric
            loading={loadingPartial}
            label="缓存输入"
            value={formatTokens(merged.cachedInputTokens)}
            change={changeOf(merged.cachedInputTokens, (usage) => usage.cachedInputTokens)}
          />
          <Metric
            loading={loadingPartial}
            label="未缓存输入"
            value={formatTokens(merged.uncachedInputTokens)}
            change={changeOf(merged.uncachedInputTokens, (usage) => usage.uncachedInputTokens)}
          />
          <Metric
            loading={loadingPartial}
            label="输出"
            value={formatTokens(merged.outputTokens)}
            change={changeOf(merged.outputTokens, (usage) => usage.outputTokens)}
          />
          <Metric
            loading={loadingPartial}
            label="缓存节省"
            value={formatUsd(merged.costQuality.cacheSavingsUsd)}
            change={changeOf(
              merged.costQuality.cacheSavingsUsd,
              (usage) => usage.costQuality.cacheSavingsUsd,
            )}
          />
        </div>
      </section>

      {merged.totalTokens > 0 ? (
        <section className={cn("grid gap-x-12 gap-y-8 lg:grid-cols-2", figureClass(loadingPartial))}>
          {metric === "tokens" ? (
            <UsageShareBar
              label="按类型的 token"
              segments={tokenTypeSegments(merged)}
              format={formatTokens}
            />
          ) : (
            <>
              <UsageShareBar
                label="按类型的费用"
                segments={costTypeSegments(merged.categoryCost)}
                format={formatUsd}
              />
              {merged.speedCost.fast + merged.speedCost.ultrafast > 0 ? (
                <UsageShareBar
                  label="按速度档位的费用"
                  segments={speedCostSegments(merged.speedCost)}
                  format={formatUsd}
                  aside={<SpeedPremium premiumUsd={merged.speedCost.premium} />}
                />
              ) : null}
            </>
          )}
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm text-foreground">明细</h2>
          <Segmented
            ariaLabel="明细维度"
            value={breakdown}
            options={[
              { value: "model", label: "模型" },
              { value: "time", label: shownHourly ? "小时" : "日期" },
            ]}
            onChange={setBreakdown}
          />
        </div>

        {breakdown === "model" ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-right text-xs text-muted-foreground">
                <th className="py-2 pr-3 text-left font-normal">#</th>
                <th className="w-full py-2 text-left font-normal">模型</th>
                <th className="py-2 pl-6 font-normal whitespace-nowrap">费用</th>
                <th className="hidden py-2 pl-6 font-normal whitespace-nowrap sm:table-cell">占比</th>
                <th className="py-2 pl-6 font-normal whitespace-nowrap">Tokens</th>
              </tr>
            </thead>
            <tbody>
              {breakdownModels.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-muted-foreground">
                    这段时间没有用量。
                  </td>
                </tr>
              ) : (
                breakdownModels.map((model, index) => {
                  const key = `${model.provider}:${model.model}`;
                  const value = metric === "tokens" ? model.totalTokens : model.costUsd;
                  const hasBar = value > 0 && breakdownPeak > 0;
                  const share = modelShare(model, metric);
                  const rowFigures = figureClass(loadingProviders.has(model.provider));
                  return (
                    <tr
                      key={key}
                      className="relative border-b border-border text-right whitespace-nowrap text-muted-foreground tabular-nums transition-colors hover:bg-muted has-focus-visible:bg-muted"
                    >
                      <td className="py-2.5 pr-3 text-left text-xs">{index + 1}</td>
                      <td className="py-2.5 text-left whitespace-normal">
                        <button
                          type="button"
                          onClick={() => onSelectModel(key)}
                          className={cn(
                            "flex items-center gap-2 text-left text-foreground outline-none after:absolute after:inset-0",
                            !hasBar && "py-1",
                          )}
                        >
                          <ProviderMark provider={model.provider} className="size-3.5" />
                          {model.model}
                        </button>
                        {hasBar ? (
                          <div aria-hidden className={cn("mt-1.5 h-0.5 max-w-48", rowFigures)}>
                            <div
                              className="h-full rounded-full"
                              style={{
                                width: `max(0.5rem, ${(value / breakdownPeak) * 100}%)`,
                                backgroundColor: PROVIDER_PRESENTATION[model.provider].color,
                              }}
                            />
                          </div>
                        ) : null}
                      </td>
                      <td className={cn("py-2.5 pl-6 text-foreground", rowFigures)}>
                        {isModelCostUnknown(model) ? (
                          <span className="text-muted-foreground">无价格</span>
                        ) : (
                          formatUsd(model.costUsd)
                        )}
                      </td>
                      <td className={cn("hidden py-2.5 pl-6 sm:table-cell", rowFigures)}>
                        {share === null ? "" : formatPercent(share)}
                      </td>
                      <td className={cn("py-2.5 pl-6", rowFigures)}>
                        {formatTokens(model.totalTokens)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        ) : (
          <div
            className="overflow-x-auto outline-none focus-visible:outline-2 focus-visible:outline-primary"
            role="region"
            aria-label="按时间的用量明细"
            tabIndex={0}
          >
            <table className="w-full text-sm whitespace-nowrap">
              <colgroup>
                <col className="w-2/5" />
              </colgroup>
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-2 font-normal">{shownHourly ? "小时" : "日期"}</th>
                  {activeProviders.map((provider) => (
                    <th key={provider} className="py-2 pl-4 text-right font-normal">
                      {PROVIDER_PRESENTATION[provider].label}
                    </th>
                  ))}
                  <th className="py-2 pl-4 text-right font-normal">合计</th>
                  <th className="py-2 pl-4 text-right font-normal">Tokens</th>
                </tr>
              </thead>
              <tbody>
                {breakdownPeriods.length === 0 ? (
                  <tr>
                    <td
                      colSpan={activeProviders.length + 3}
                      className="py-6 text-center text-muted-foreground"
                    >
                      这段时间没有用量。
                    </td>
                  </tr>
                ) : (
                  breakdownPeriods.map((period) => (
                    <tr
                      key={"hourStart" in period ? period.hourStart : period.day}
                      className="border-b border-border transition-colors hover:bg-muted"
                    >
                      <td className="py-2 text-foreground">
                        {"hourStart" in period
                          ? formatHourShort(period.hourStart, shownWindow.timeZone, HOUR12)
                          : formatDayShort(period.day)}
                      </td>
                      {activeProviders.map((provider) => (
                        <td
                          key={provider}
                          className={cn(
                            "py-2 pl-4 text-right text-muted-foreground tabular-nums",
                            figureClass(loadingProviders.has(provider)),
                          )}
                        >
                          {formatUsd(period.byProvider.get(provider)?.costUsd ?? 0)}
                        </td>
                      ))}
                      <td
                        className={cn(
                          "py-2 pl-4 text-right text-foreground tabular-nums",
                          figureClass(loadingPartial),
                        )}
                      >
                        {formatUsd(period.costUsd)}
                      </td>
                      <td
                        className={cn(
                          "py-2 pl-4 text-right text-muted-foreground tabular-nums",
                          figureClass(loadingPartial),
                        )}
                      >
                        {formatTokens(period.totalTokens)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function figureClass(loading: boolean) {
  return cn("transition-opacity", loading && "opacity-40 delay-150");
}

function Metric({
  label,
  value,
  loading,
  change,
}: {
  readonly label: string;
  readonly value: string;
  readonly loading: boolean;
  /** 环比文字，不传则不显示 */
  readonly change?: string | undefined;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn("text-base font-medium text-foreground tabular-nums", figureClass(loading))}>
        {value}
      </span>
      {change !== undefined ? (
        <span className="text-[11px] text-muted-foreground tabular-nums">环比 {change}</span>
      ) : null}
    </div>
  );
}

/** 「10月15日 至 10月21日」或 24 小时窗口的起止时间 */
function formatWindowRange(window: UsageSummaryInput): string {
  return window.resolution === "hour" &&
    window.sinceTime !== undefined &&
    window.untilTime !== undefined
    ? `${formatDateTimeShort(window.sinceTime, window.timeZone, HOUR12)} 至 ${formatDateTimeShort(window.untilTime, window.timeZone, HOUR12)}`
    : `${formatDayShort(window.sinceDay)} 至 ${formatDayShort(window.untilDay)}`;
}

function UsageCoverageNotice({
  environments,
  duplicateSources,
  contractMismatches,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly duplicateSources: readonly string[];
  readonly contractMismatches: MergedUsage["contractMismatches"];
}) {
  const failed = environments.filter((environment) => environment.error !== null);
  const mismatchByEnvironment = new Map(
    contractMismatches.map((mismatch) => [mismatch.environmentId, mismatch]),
  );
  const incompatible = environments.flatMap((environment) => {
    const mismatch = mismatchByEnvironment.get(environment.environmentId);
    return mismatch === undefined ? [] : [{ environment, mismatch }];
  });
  if (failed.length === 0 && incompatible.length === 0 && duplicateSources.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1 border-t border-border px-2 py-2 text-xs text-muted-foreground">
      {failed.map((environment) => (
        <span key={environment.label}>
          {environment.label}：{environment.error}
        </span>
      ))}
      {incompatible.map(({ environment, mismatch }) => (
        <span key={environment.environmentId}>
          {formatUsageContractMismatch(environment.label, mismatch)}
        </span>
      ))}
      {duplicateSources.length > 0 ? (
        <span>共用同一日志目录的来源只计一次：{duplicateSources.join("，")}</span>
      ) : null}
    </div>
  );
}

function UsageEnvironmentFilter({
  environments,
  selectedEnvironments,
  selectedEnvironmentIds,
  onSelectionChange,
  refreshing,
  isPartial,
  duplicateSources,
  contractMismatches,
  onOpenModelPrices,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly selectedEnvironments: readonly EnvironmentUsageStatus[];
  readonly selectedEnvironmentIds: ReadonlySet<string> | null;
  readonly onSelectionChange: (ids: ReadonlySet<string> | null) => void;
  readonly refreshing: boolean;
  readonly isPartial: boolean;
  readonly duplicateSources: readonly string[];
  readonly contractMismatches: MergedUsage["contractMismatches"];
  readonly onOpenModelPrices: () => void;
}) {
  const allSelected = selectedEnvironmentIds === null;
  const label = allSelected
    ? "全部来源"
    : selectedEnvironments.length === 1
      ? selectedEnvironments[0]!.label
      : `${selectedEnvironments.length} 个来源`;
  const hasIssue =
    selectedEnvironments.some((environment) => environment.error !== null) ||
    contractMismatches.length > 0;

  return (
    <Dropdown
      ariaLabel={`来源：${label}`}
      triggerClassName="group min-w-0 max-w-full text-foreground"
      trigger={() => (
        <>
          <span className="min-w-0 truncate">{label}</span>
          {hasIssue ? (
            <AlertIcon className="size-3.5 shrink-0 text-warning-foreground" aria-label="有来源无法报告用量" />
          ) : (
            <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground opacity-60 group-hover:opacity-100" />
          )}
        </>
      )}
    >
      {(close) => (
        <>
          <MenuCheckboxItem
            checked={allSelected}
            onCheckedChange={(checked) => onSelectionChange(checked ? null : new Set())}
          >
            全部来源
          </MenuCheckboxItem>
          <MenuSeparator />
          {environments.map((environment) => {
            const checked =
              selectedEnvironmentIds === null ||
              selectedEnvironmentIds.has(environment.environmentId);
            const progress = usageEnvironmentProgress(environment, refreshing);
            const status =
              environment.error !== null
                ? "不可用"
                : environment.summary !== null &&
                    !isCompatibleUsageContractVersion(
                      environment.summary.contractVersion,
                      USAGE_CONTRACT_VERSION,
                    )
                  ? "需要更新"
                  : !environment.isConnected
                    ? "连接中…"
                    : progress.phase === "loading"
                      ? "正在扫描…"
                      : progress.phase === "stale"
                        ? "正在刷新…"
                        : progress.phase === "partway"
                          ? updatingProvidersLabel(progress.providers, providerLabel)
                          : "就绪";
            return (
              <MenuCheckboxItem
                key={environment.environmentId}
                checked={checked}
                onCheckedChange={(nextChecked) => {
                  const next = new Set(selectedEnvironments.map((entry) => entry.environmentId));
                  if (nextChecked) next.add(environment.environmentId);
                  else next.delete(environment.environmentId);
                  onSelectionChange(next.size === environments.length ? null : next);
                }}
              >
                <span className="flex min-w-0 items-center gap-3">
                  <span className="min-w-0 flex-1 truncate">{environment.label}</span>
                  <span
                    className={cn(
                      "shrink-0 text-muted-foreground",
                      environment.error !== null && "text-destructive-foreground",
                    )}
                  >
                    {status}
                  </span>
                </span>
              </MenuCheckboxItem>
            );
          })}
          {isPartial ? (
            <p className="px-2 py-2 text-muted-foreground">所选来源还在扫描，合计暂不完整。</p>
          ) : null}
          <UsageCoverageNotice
            environments={selectedEnvironments}
            duplicateSources={duplicateSources}
            contractMismatches={contractMismatches}
          />
          <MenuSeparator />
          <MenuItem
            onClick={() => {
              close();
              onOpenModelPrices();
            }}
          >
            <SlidersIcon />
            模型价格
          </MenuItem>
        </>
      )}
    </Dropdown>
  );
}

function UsageProviderFilter({
  hiddenProviders,
  onChange,
}: {
  readonly hiddenProviders: ReadonlySet<UsageProviderKind>;
  readonly onChange: (hiddenProviders: readonly UsageProviderKind[]) => void;
}) {
  const visible = PROVIDER_ORDER.filter((provider) => !hiddenProviders.has(provider));
  const label =
    visible.length === PROVIDER_ORDER.length
      ? "全部提供方"
      : visible.length === 0
        ? "未选提供方"
        : visible.length === 1
          ? PROVIDER_PRESENTATION[visible[0]!].label
          : `${visible.length} 个提供方`;

  return (
    <Dropdown
      ariaLabel={`提供方：${label}`}
      triggerClassName="group min-w-0 max-w-full text-foreground"
      trigger={() => (
        <>
          <span className="min-w-0 truncate">{label}</span>
          <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground opacity-60 group-hover:opacity-100" />
        </>
      )}
    >
      <MenuCheckboxItem
        checked={hiddenProviders.size === 0}
        onCheckedChange={(checked) => onChange(checked ? [] : PROVIDER_ORDER)}
      >
        全部提供方
      </MenuCheckboxItem>
      <MenuSeparator />
      {PROVIDER_ORDER.map((provider) => (
        <MenuCheckboxItem
          key={provider}
          checked={!hiddenProviders.has(provider)}
          onCheckedChange={(checked) =>
            onChange(
              PROVIDER_ORDER.filter((entry) =>
                entry === provider ? !checked : hiddenProviders.has(entry),
              ),
            )
          }
        >
          <span className="flex min-w-0 items-center gap-2">
            <ProviderMark provider={provider} className="size-3.5" />
            <span className="truncate">{PROVIDER_PRESENTATION[provider].label}</span>
          </span>
        </MenuCheckboxItem>
      ))}
    </Dropdown>
  );
}

function UsageSkeleton() {
  return (
    <>
      <section className="grid gap-8 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1">
            <Skeleton className="h-10 w-36" />
            <Skeleton className="h-4 w-32" />
          </div>
          {PROVIDER_ORDER.slice(0, 3).map((provider) => (
            <div key={provider} className="flex flex-col gap-1">
              <div className="flex min-h-5 items-center justify-between gap-4">
                <span className="flex items-center gap-2">
                  <Skeleton className="size-2 shrink-0 rounded-full" />
                  <Skeleton className="size-4 shrink-0" />
                  <Skeleton className="h-3.5 w-20" />
                </span>
                <Skeleton className="h-3.5 w-14" />
              </div>
              <Skeleton className="h-4 w-36" />
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-3">
          <Skeleton className="h-5 w-24" />
          <div className="flex flex-col gap-1">
            <Skeleton className="ml-16 h-56" />
            <Skeleton className="ml-16 h-4" />
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm text-foreground">合计</h2>
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 py-1 md:grid-cols-5">
          {["处理的 token", "缓存输入", "未缓存输入", "输出", "缓存节省"].map((label) => (
            <div key={label} className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">{label}</span>
              <Skeleton className="h-6 w-16" />
            </div>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm text-foreground">明细</h2>
        <Skeleton className="h-44" />
      </section>
    </>
  );
}
