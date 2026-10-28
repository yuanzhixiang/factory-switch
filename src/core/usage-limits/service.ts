// 额度服务：定时探测各家额度和 CLIProxyAPI 来源，保存最新状态并通知页面。
// 对应 T3 Code（MIT）里各 provider 的定时探测（默认 5 分钟）和 apps/server/src/usage/UsageLimitSources.ts。
import type {
  LimitDriver,
  LimitProvider,
  ProviderConsumeResetCreditInput,
  ProviderConsumeResetCreditOutcome,
  ProviderConsumeResetCreditResult,
  UsageLimitSourceConfig,
  UsageLimitSourceSnapshot,
  UsageLimitsSettingsPatch,
  UsageLimitsSettingsView,
  UsageLimitsState,
} from "../../shared/usage-limits";
import { makeCliproxyApi, UsageLimitSourceError } from "./cliproxy";
import { resolveUsageLimitsAfterProbe } from "./common";
import {
  settingsView,
  type UsageLimitsSettings,
  type UsageLimitsSettingsStore,
} from "./settings";

export const USAGE_LIMITS_REFRESH_INTERVAL_MS = 5 * 60_000;

export interface UsageLimitsProbes {
  readonly claudeAgent: () => Promise<LimitProvider>;
  readonly codex: () => Promise<LimitProvider>;
  readonly cursor: (allowKeychain: boolean) => Promise<LimitProvider>;
  readonly opencode: () => Promise<LimitProvider>;
}

export interface UsageLimitsServiceOptions {
  readonly settings: UsageLimitsSettingsStore;
  readonly probes: UsageLimitsProbes;
  readonly consumeCodexResetCredit: () => Promise<ProviderConsumeResetCreditOutcome>;
  readonly httpFetch: typeof fetch;
  readonly now?: () => Date;
  readonly onChange?: (state: UsageLimitsState) => void;
}

const PROVIDER_ORDER: readonly LimitDriver[] = ["claudeAgent", "codex", "cursor", "opencode"];

function sourceLabel(id: string, config: UsageLimitSourceConfig): string {
  if (config.label) return config.label;
  const fallback = id.trim() || "额度来源";
  try {
    return new URL(config.url).host || fallback;
  } catch {
    return fallback;
  }
}

/** 简单的互斥锁 */
function makeLock(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (task) => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}

export function createUsageLimitsService(options: UsageLimitsServiceOptions) {
  const now = options.now ?? (() => new Date());
  const api = makeCliproxyApi(options.httpFetch, now);
  const providers = new Map<LimitDriver, LimitProvider>();
  let sources: readonly UsageLimitSourceSnapshot[] = [];
  let refreshing = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const state = (): UsageLimitsState => ({
    providers: PROVIDER_ORDER.flatMap((driver) => {
      const provider = providers.get(driver);
      return provider ? [provider] : [];
    }),
    usageLimitSources: sources,
    refreshing,
  });
  const emit = () => options.onChange?.(state());

  /** 探测失败时保留上一次的额度数据（T3 的 resolveUsageLimitsAfterProbe） */
  const publishProvider = (probed: LimitProvider) => {
    const published = providers.get(probed.driver);
    const usageLimits = resolveUsageLimitsAfterProbe({
      published: published?.usageLimits,
      probed: probed.usageLimits,
    });
    providers.set(probed.driver, {
      ...probed,
      ...(usageLimits ? { usageLimits } : {}),
    });
  };

  const readSource = async (
    id: string,
    config: UsageLimitSourceConfig,
  ): Promise<UsageLimitSourceSnapshot> => {
    const base = {
      id,
      kind: config.kind,
      label: sourceLabel(id, config),
      checkedAt: now().toISOString(),
    } as const;
    if (config.managementKey.length === 0) {
      return { ...base, accounts: [], error: "没有设置管理密钥。" };
    }
    try {
      return { ...base, accounts: await api.readAccounts(config) };
    } catch (error) {
      return {
        ...base,
        accounts: [],
        error: error instanceof UsageLimitSourceError ? error.message : "读取额度来源失败。",
      };
    }
  };

  const readSources = async (settings: UsageLimitsSettings) => {
    const entries = Object.entries(settings.usageLimitSources).filter(
      ([, config]) => config.enabled,
    );
    return Promise.all(entries.map(([id, config]) => readSource(id, config)));
  };

  // 刷新和兑换串行，避免旧设置的慢请求覆盖新结果
  const lock = makeLock();

  const refresh = () =>
    lock(async () => {
      refreshing = true;
      emit();
      try {
        const settings = await options.settings.read();
        const [probed, nextSources] = await Promise.all([
          Promise.all([
            options.probes.claudeAgent(),
            options.probes.codex(),
            options.probes.cursor(settings.cursorKeychainUsageEnabled),
            options.probes.opencode(),
          ]),
          readSources(settings),
        ]);
        for (const provider of probed) publishProvider(provider);
        sources = nextSources;
      } finally {
        refreshing = false;
        emit();
      }
      return state();
    });

  const consumeResetCredit = (
    input: ProviderConsumeResetCreditInput,
  ): Promise<ProviderConsumeResetCreditResult> =>
    lock(async () => {
      try {
        if ("instanceId" in input) {
          if (input.instanceId !== "codex") {
            // T3 在 macOS 上读不到 Claude 的登录（存在钥匙串），所以不会显示 Claude 的重置次数
            return { ok: false, message: "这个账号不支持在这里兑换重置次数。" };
          }
          const outcome = await options.consumeCodexResetCredit();
          // 额度刚变，重新探测一次
          publishProvider(await options.probes.codex());
          emit();
          return { ok: true, outcome };
        }
        const settings = await options.settings.read();
        const config = settings.usageLimitSources[input.sourceId];
        if (!config?.enabled || !config.managementKey) {
          return { ok: false, message: "额度来源不存在或已停用。" };
        }
        const result = await api.consume(config, input.accountId, input.creditId);
        const snapshot = await readSource(input.sourceId, config);
        sources = sources.map((source) => (source.id === input.sourceId ? snapshot : source));
        emit();
        return { ok: true, ...result };
      } catch (error) {
        return {
          ok: false,
          message:
            error instanceof UsageLimitSourceError
              ? error.message
              : `兑换失败：${(error as Error).message}`,
        };
      }
    });

  const updateSettings = async (
    patch: UsageLimitsSettingsPatch,
  ): Promise<UsageLimitsSettingsView> => {
    const next = await options.settings.update(patch);
    // 来源或钥匙串开关变了，马上刷新一次
    void refresh();
    return settingsView(next);
  };

  return {
    get: state,
    refresh,
    consumeResetCredit,
    readSettings: async () => settingsView(await options.settings.read()),
    updateSettings,
    /** 启动后马上查一次，之后每 5 分钟一次 */
    start() {
      void refresh();
      timer ??= setInterval(() => void refresh(), USAGE_LIMITS_REFRESH_INTERVAL_MS);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
