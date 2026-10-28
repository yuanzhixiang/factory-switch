// 扫描进度与加载状态，移植自 T3 Code（MIT）packages/client-runtime/src/state/usageProgress.ts
import type { UsageProviderKind, UsageSummary } from "../../../shared/token-usage";

interface UsageProgressEnvironment {
  readonly label: string;
  readonly isConnected: boolean;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly summary: UsageSummary | null;
}

export function usageEnvironmentProgress(
  environment: UsageProgressEnvironment,
  refreshing = false,
) {
  const { summary } = environment;
  if (!environment.isConnected || environment.error !== null) return { phase: "inactive" } as const;
  if (summary === null) return { phase: "loading" } as const;
  if (refreshing) return { phase: "stale" } as const;
  if (!environment.isPending) return { phase: "ready" } as const;
  const providers = [
    ...new Set(
      summary.sources.flatMap((source) => (source.refreshing ? [source.fingerprint.provider] : [])),
    ),
  ];
  return providers.length > 0
    ? ({ phase: "partway", providers } as const)
    : ({ phase: "stale" } as const);
}

export function updatingProvidersLabel(
  providers: readonly UsageProviderKind[],
  providerLabel: (provider: UsageProviderKind) => string,
) {
  return providers.length === 1
    ? `正在更新 ${providerLabel(providers[0]!)}…`
    : `正在更新 ${providers.length} 个提供方…`;
}

export function usageLoadingState(
  environments: readonly UsageProgressEnvironment[],
  refreshing = false,
) {
  const providers = new Set<UsageProviderKind>();
  let everyProvider = false;
  for (const environment of environments) {
    const progress = usageEnvironmentProgress(environment, refreshing);
    if (progress.phase === "loading" || progress.phase === "stale") everyProvider = true;
    if (progress.phase === "partway")
      for (const provider of progress.providers) providers.add(provider);
  }
  return { partial: everyProvider || providers.size > 0, everyProvider, providers };
}
