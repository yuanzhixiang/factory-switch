// token 统计的页面状态：查询缓存、用量页偏好、当前时间窗口和价格设置。
// 对应 T3 Code（MIT）apps/web/src/state/usage.ts 与 client-runtime 里的 usageSummary 查询：
// 结果缓存 60 秒；来源还在后台刷新时先显示缓存结果，再带 awaitRefresh 重新请求一次；
// 价格设置变化后所有结果作废重查。侧边栏和用量页共用这一份状态。
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  USAGE_CONTRACT_VERSION,
  type TokenUsageSettings,
  type TokenUsageSettingsPatch,
  type UsageBucket,
  type UsageProviderKind,
  type UsageSummary,
  type UsageSummaryInput,
} from "../../../shared/token-usage";
import { previousWindow } from "./compare";
import { makeWindow } from "./format";
import { mergeUsage, type EnvironmentUsage, type MergedUsage } from "./merge";
import {
  readUsagePagePreferences,
  saveUsagePagePreferences,
  type UsagePagePreferences,
  type UsageWindowDays,
} from "./preferences";

/** 本应用只有本机这一个来源，对应 T3 的一个环境 */
export const LOCAL_ENVIRONMENT_ID = "local";
export const LOCAL_ENVIRONMENT_LABEL = "本机";

const STALE_TIME_MS = 60_000;

export interface EnvironmentUsageStatus {
  readonly environmentId: string;
  readonly label: string;
  readonly isPending: boolean;
  readonly canReadDiagnostics: boolean;
  readonly isConnected: boolean;
  readonly error: string | null;
  readonly summary: UsageSummary | null;
}

interface QueryEntry {
  readonly summary: UsageSummary | null;
  readonly error: string | null;
  readonly pending: boolean;
  readonly fetchedAt: number;
  /** 设置变化后递增，旧请求的结果不再写回 */
  readonly generation: number;
}

export interface WindowSelection {
  readonly days: UsageWindowDays;
  readonly window: UsageSummaryInput;
}

function windowFor(days: UsageWindowDays): UsageSummaryInput {
  return makeWindow(days, undefined, days === 1 ? "hour" : "day");
}

export function windowKey(input: UsageSummaryInput): string {
  return JSON.stringify({
    sinceDay: input.sinceDay,
    untilDay: input.untilDay,
    timeZone: input.timeZone,
    resolution: input.resolution,
    sinceTime: input.sinceTime,
    untilTime: input.untilTime,
  });
}

const initialPreferences = readUsagePagePreferences();

let state: {
  readonly preferences: UsagePagePreferences;
  readonly windowSelection: WindowSelection;
  readonly entries: ReadonlyMap<string, QueryEntry>;
  readonly settings: TokenUsageSettings | null;
} = {
  preferences: initialPreferences,
  windowSelection: {
    days: initialPreferences.windowDays,
    window: windowFor(initialPreferences.windowDays),
  },
  entries: new Map(),
  settings: null,
};
let generation = 0;
const listeners = new Set<() => void>();

function setState(patch: Partial<typeof state>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function setEntry(key: string, entry: QueryEntry) {
  setState({ entries: new Map(state.entries).set(key, entry) });
}

export function useTokenUsageState() {
  return useSyncExternalStore(subscribe, () => state);
}

export function updatePreferences(patch: Partial<UsagePagePreferences>) {
  const preferences = { ...state.preferences, ...patch };
  saveUsagePagePreferences(preferences);
  setState({ preferences });
}

/** 切换时间段：保存偏好并按当前时刻重新计算窗口 */
export function selectWindow(days: UsageWindowDays) {
  updatePreferences({ windowDays: days });
  setState({ windowSelection: { days, window: windowFor(days) } });
}

/** 刷新时窗口跟着当前时刻往前走；日期没变就沿用原窗口，避免重复请求 */
export function advanceWindow(): UsageSummaryInput {
  const { days, window } = state.windowSelection;
  const next = windowFor(days);
  if (windowKey(next) === windowKey(window)) return window;
  setState({ windowSelection: { days, window: next } });
  return next;
}

async function fetchSummary(input: UsageSummaryInput, key: string, force: boolean) {
  const existing = state.entries.get(key);
  if (existing?.pending) return;
  if (
    !force &&
    existing !== undefined &&
    existing.generation === generation &&
    existing.error === null &&
    Date.now() - existing.fetchedAt < STALE_TIME_MS
  ) {
    return;
  }
  const requestGeneration = generation;
  const keep = existing?.summary ?? null;
  setEntry(key, {
    summary: keep,
    error: null,
    pending: true,
    fetchedAt: existing?.fetchedAt ?? 0,
    generation: requestGeneration,
  });
  const finish = (summary: UsageSummary | null, error: string | null, pending: boolean) => {
    if (requestGeneration !== generation) return;
    setEntry(key, {
      summary,
      error,
      pending,
      fetchedAt: Date.now(),
      generation: requestGeneration,
    });
  };
  try {
    const result = await window.factorySwitch.getTokenUsage(input);
    if (!result.ok) {
      finish(keep, result.message, false);
      return;
    }
    const refreshing = result.summary.sources.some((source) => source.refreshing === true);
    finish(result.summary, null, refreshing);
    if (!refreshing) return;
    // 慢来源在后台刷新：先显示缓存结果，再等刷新完成的结果
    try {
      const fresh = await window.factorySwitch.getTokenUsage({ ...input, awaitRefresh: true });
      finish(fresh.ok ? fresh.summary : result.summary, null, false);
    } catch (error) {
      console.warn("慢来源用量刷新失败", error);
      finish(result.summary, null, false);
    }
  } catch (error) {
    finish(keep, `读取用量失败：${String(error)}`, false);
  }
}

/** 确保某个窗口有数据：60 秒内的结果直接复用 */
export function ensureSummary(input: UsageSummaryInput) {
  void fetchSummary(input, windowKey(input), false);
}

/** 手动刷新：先强制更新价格表，再重新扫描 */
export async function refreshSummary(input: UsageSummaryInput) {
  try {
    await window.factorySwitch.refreshTokenUsageRates();
  } catch (error) {
    console.warn("刷新价格表失败", error);
  }
  await fetchSummary(input, windowKey(input), true);
}

export async function loadTokenUsageSettings(): Promise<TokenUsageSettings> {
  const settings = await window.factorySwitch.getTokenUsageSettings();
  setState({ settings });
  return settings;
}

/** 保存价格设置；成功后作废所有结果并重查当前窗口 */
export async function saveTokenUsageSettings(
  patch: TokenUsageSettingsPatch,
): Promise<TokenUsageSettings> {
  const settings = await window.factorySwitch.updateTokenUsageSettings(patch);
  generation += 1;
  setState({ settings, entries: new Map() });
  ensureSummary(state.windowSelection.window);
  return settings;
}

function localEnvironmentFrom(entry: QueryEntry | undefined): EnvironmentUsageStatus {
  return {
    environmentId: LOCAL_ENVIRONMENT_ID,
    label: LOCAL_ENVIRONMENT_LABEL,
    isPending: entry === undefined || entry.pending,
    canReadDiagnostics: true,
    isConnected: true,
    error: entry?.error ?? null,
    summary: entry?.summary ?? null,
  };
}

export function mergeAnsweredUsage(
  environments: readonly EnvironmentUsageStatus[],
  keepBucket?: (bucket: UsageBucket) => boolean,
): MergedUsage {
  const answered: EnvironmentUsage[] = environments.flatMap(({ environmentId, label, summary }) =>
    summary === null
      ? []
      : [
          {
            environmentId,
            label,
            summary:
              keepBucket === undefined
                ? summary
                : { ...summary, buckets: summary.buckets.filter(keepBucket) },
          },
        ],
  );
  return mergeUsage(answered, USAGE_CONTRACT_VERSION);
}

export function withoutProviders(
  environments: readonly EnvironmentUsageStatus[],
  hiddenProviders: ReadonlySet<UsageProviderKind>,
): readonly EnvironmentUsageStatus[] {
  if (hiddenProviders.size === 0) return environments;
  return environments.map((environment) =>
    environment.summary === null
      ? environment
      : {
          ...environment,
          summary: {
            ...environment.summary,
            buckets: environment.summary.buckets.filter(
              (bucket) => !hiddenProviders.has(bucket.provider),
            ),
            sources: environment.summary.sources.filter(
              (source) => !hiddenProviders.has(source.fingerprint.provider),
            ),
          },
        },
  );
}

export interface UsageView {
  readonly merged: MergedUsage;
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly selectedEnvironments: readonly EnvironmentUsageStatus[];
  readonly isPending: boolean;
  /** 新窗口还没结果时，继续显示上一个窗口的结果 */
  readonly shown: { readonly window: UsageSummaryInput; readonly merged: MergedUsage } | null;
  readonly isPartial: boolean;
}

/** 对应 T3 的 useUsage：合并选中环境、去掉隐藏的提供方，并在切换窗口时保留上一次的结果 */
export function useUsage(
  input: UsageSummaryInput,
  selectedEnvironmentIds: ReadonlySet<string> | null,
  hiddenProviders: ReadonlySet<UsageProviderKind>,
): UsageView {
  const { entries } = useTokenUsageState();
  const entry = entries.get(windowKey(input));
  const environments = useMemo(() => [localEnvironmentFrom(entry)], [entry]);
  const selectedEnvironments = useMemo(
    () =>
      selectedEnvironmentIds === null
        ? environments
        : environments.filter((environment) =>
            selectedEnvironmentIds.has(environment.environmentId),
          ),
    [environments, selectedEnvironmentIds],
  );
  const merged = useMemo(
    () => mergeAnsweredUsage(withoutProviders(selectedEnvironments, hiddenProviders)),
    [selectedEnvironments, hiddenProviders],
  );

  const answeredCount = selectedEnvironments.filter(
    (environment) => environment.summary !== null,
  ).length;
  const stillReporting = selectedEnvironments.filter(
    (environment) => environment.summary === null && environment.error === null,
  ).length;
  const isPending = answeredCount === 0 && stillReporting > 0;

  const [lastAnswered, setLastAnswered] = useState<{
    readonly window: UsageSummaryInput;
    readonly merged: MergedUsage;
    readonly selection: ReadonlySet<string> | null;
    readonly hidden: ReadonlySet<UsageProviderKind>;
  } | null>(null);
  if (
    answeredCount > 0 &&
    (lastAnswered?.merged !== merged ||
      lastAnswered.window !== input ||
      lastAnswered.selection !== selectedEnvironmentIds ||
      lastAnswered.hidden !== hiddenProviders)
  ) {
    setLastAnswered({
      window: input,
      merged,
      selection: selectedEnvironmentIds,
      hidden: hiddenProviders,
    });
  }
  const kept =
    lastAnswered?.selection === selectedEnvironmentIds && lastAnswered.hidden === hiddenProviders
      ? lastAnswered
      : null;
  const shown =
    answeredCount > 0
      ? { window: input, merged }
      : (kept ?? (isPending ? null : { window: input, merged }));

  return {
    merged,
    environments,
    selectedEnvironments,
    isPending,
    shown,
    isPartial: answeredCount > 0 && stillReporting > 0,
  };
}

/** 隐藏提供方的稳定 Set：偏好里的数组不变就复用同一个 Set */
export function useHiddenProviders(): ReadonlySet<UsageProviderKind> {
  const { preferences } = useTokenUsageState();
  const hidden = preferences.hiddenProviders;
  return useMemo(() => new Set(hidden), [hidden]);
}

/** 侧边栏用：用量页当前时间段、按当前提供方筛选后的总 token；还没有结果时为 null */
export function useTokenUsageTotal(): { readonly totalTokens: number | null; readonly loading: boolean } {
  const { windowSelection, entries } = useTokenUsageState();
  const hiddenProviders = useHiddenProviders();
  const { window } = windowSelection;
  useEffect(() => {
    ensureSummary(window);
  }, [window]);
  const entry = entries.get(windowKey(window));
  const totalTokens = useMemo(
    () =>
      entry?.summary == null
        ? null
        : mergeAnsweredUsage(withoutProviders([localEnvironmentFrom(entry)], hiddenProviders))
            .totalTokens,
    [entry, hiddenProviders],
  );
  return { totalTokens, loading: entry === undefined || entry.pending };
}

/**
 * 环比用的上一周期结果：只在 enabled 时取数，结果同样缓存 60 秒；
 * 价格设置变化清空缓存后会自动重取。还没有结果时 merged 为 null。
 */
export function usePreviousUsage(
  input: UsageSummaryInput,
  hiddenProviders: ReadonlySet<UsageProviderKind>,
  enabled: boolean,
): { readonly window: UsageSummaryInput; readonly merged: MergedUsage | null } {
  const previous = useMemo(() => previousWindow(input), [input]);
  const { entries } = useTokenUsageState();
  const entry = entries.get(windowKey(previous));
  const missing = entry === undefined;
  useEffect(() => {
    if (enabled && missing) ensureSummary(previous);
  }, [enabled, missing, previous]);
  const merged = useMemo(
    () =>
      enabled && entry?.summary
        ? mergeAnsweredUsage(withoutProviders([localEnvironmentFrom(entry)], hiddenProviders))
        : null,
    [enabled, entry, hiddenProviders],
  );
  return { window: previous, merged };
}
