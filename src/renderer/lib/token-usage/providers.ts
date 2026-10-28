// 各提供方的展示名和配色，移植自 T3 Code（MIT）apps/web/src/components/usage/usageProviders.ts
import type { UsageProviderKind } from "../../../shared/token-usage";

interface UsageProviderPresentation {
  readonly label: string;
  readonly color: string;
  /** 没有品牌图标时显示的字母徽标 */
  readonly mark: string;
}

export const PROVIDER_PRESENTATION = {
  codex: { label: "Codex", color: "var(--foreground)", mark: "Cx" },
  claude: { label: "Claude Code", color: "#d97757", mark: "C" },
  grok: {
    label: "Grok Build",
    color: "color-mix(in oklab, var(--foreground) 72%, var(--background))",
    mark: "G",
  },
  cursor: { label: "Cursor", color: "#8b8b8b", mark: "Cu" },
  opencode: { label: "OpenCode", color: "#5b9bbd", mark: "O" },
  antigravity: { label: "Antigravity", color: "#8c7bd1", mark: "A" },
  pi: { label: "Pi", color: "#4d9f8a", mark: "π" },
  muse: { label: "Muse Code", color: "#0866ff", mark: "M" },
} satisfies Record<UsageProviderKind, UsageProviderPresentation>;

export const PROVIDER_ORDER = Object.keys(PROVIDER_PRESENTATION) as UsageProviderKind[];

export function providersWithUsage(
  totals: readonly {
    readonly provider: UsageProviderKind;
    readonly costUsd: number;
    readonly totalTokens: number;
  }[],
): readonly UsageProviderKind[] {
  const active = new Set(
    totals
      .filter((entry) => entry.totalTokens > 0 || entry.costUsd > 0)
      .map((entry) => entry.provider),
  );
  return PROVIDER_ORDER.filter((provider) => active.has(provider));
}
