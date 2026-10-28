// 额度页签的公共部件：节奏图标、匀速刻度、重置额度兑换，以及按提供方筛选后的整页入口。
// 移植自 T3 Code（MIT）apps/web/src/components/usage/UsageLimits.tsx。
// 改动：只有「本机」一个环境，没有权限范围（scope）检查；只在聊天界面用到的 LimitWindows、ResetCredits 未移植。
import { useLayoutEffect, useState, type ReactNode, type SVGProps } from "react";
import type { UsageProviderKind } from "../../../shared/token-usage";
import type {
  LimitDriver,
  LimitProvider,
  ProviderConsumeResetCreditInput,
  ProviderConsumeResetCreditOutcome,
  ServerProviderResetCredits,
} from "../../../shared/usage-limits";
import { PROVIDER_PRESENTATION } from "../../lib/token-usage/providers";
import { LOCAL_ENVIRONMENT_ID, LOCAL_ENVIRONMENT_LABEL } from "../../lib/token-usage/store";
import {
  formatDuration,
  type LimitPace,
  type LimitPresentations,
  type LimitRedeemInput,
} from "../../lib/usage-limits/limits";
import { DRIVER_PROVIDER, useUsageLimitsState } from "../../lib/usage-limits/store";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { HoverTip } from "../token-usage/ui";
import { UsageLimitsPooled } from "./UsageLimitsPooled";

function Icon({ children, className = "size-3.5", ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
      {...props}
    >
      {children}
    </svg>
  );
}

export const GaugeIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="m12 14 4-4" />
    <path d="M3.34 19a10 10 0 1 1 17.32 0" />
  </Icon>
);

export const TrendingUpIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="M16 7h6v6" />
    <path d="m22 7-8.5 8.5-5-5L2 17" />
  </Icon>
);

export const TrendingDownIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="M16 17h6v-6" />
    <path d="m22 17-8.5-8.5-5 5L2 7" />
  </Icon>
);

export const TicketIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z" />
    <path d="M13 5v2" />
    <path d="M13 17v2" />
    <path d="M13 11v2" />
  </Icon>
);

export const ExternalLinkIcon = (props: SVGProps<SVGSVGElement>) => (
  <Icon {...props}>
    <path d="M15 3h6v6" />
    <path d="M10 14 21 3" />
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
  </Icon>
);

const PACE: Record<LimitPace, { readonly label: string; readonly icon: typeof GaugeIcon }> = {
  ahead: { label: "超前：用得比时间过得快", icon: TrendingUpIcon },
  on: { label: "和时间进度持平", icon: GaugeIcon },
  under: { label: "落后：这个周期剩下的时间还有余量", icon: TrendingDownIcon },
};

export function barColor(driver: LimitDriver): string {
  return PROVIDER_PRESENTATION[DRIVER_PROVIDER[driver]]?.color ?? "var(--foreground)";
}

export function driverLabel(driver: LimitDriver): string {
  return PROVIDER_PRESENTATION[DRIVER_PROVIDER[driver]]?.label ?? String(driver);
}

export function PaceIcon({ pace }: { readonly pace: LimitPace }) {
  const PaceGlyph = PACE[pace].icon;
  return (
    <HoverTip label={PACE[pace].label} tip={PACE[pace].label}>
      <PaceGlyph className="size-3.5" />
    </HoverTip>
  );
}

// 刻度放在进度条上挖出的一道透明缝里，0% 和 100% 时也夹在条内。
// 用 clip-path 挖缝而不是 mask：mask 会重新合成图层，让圆角端点的抗锯齿变差。
function paceMarkStyles(timeLeft: number | null) {
  if (timeLeft === null) return null;
  const at = `clamp(3px, ${timeLeft}%, calc(100% - 3px))`;
  const [left, right] = [`calc(${at} - 3px)`, `calc(${at} + 3px)`];
  const [near, far] = ["-1px", "calc(100% + 1px)"];
  return {
    tick: { left: at },
    gap: {
      clipPath: `polygon(${near} ${near}, ${left} ${near}, ${left} ${far}, ${right} ${far}, ${right} ${near}, ${far} ${near}, ${far} ${far}, ${near} ${far})`,
    },
    // 给本身要画焦点框的元素用：裁剪会把焦点框也裁掉，所以改用渐变画出缝
    gappedTrack: {
      backgroundColor: "transparent",
      backgroundImage: `linear-gradient(to right, var(--color-muted) ${left}, transparent ${left}, transparent ${right}, var(--color-muted) ${right})`,
    },
  };
}

/** 返回给进度条用的 ref 和匀速刻度样式；条宽不到 6px 放不下缝和刻度，就都不画 */
export function usePaceMark(timeLeft: number | null) {
  const [bar, setBar] = useState<HTMLElement | null>(null);
  const [roomy, setRoomy] = useState(false);
  // 绘制前量一次 DOM 宽度，之后跟着 ResizeObserver 重新量
  useLayoutEffect(() => {
    if (!bar) return;
    const measure = () => setRoomy(bar.getBoundingClientRect().width >= 6);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [bar]);
  return [setBar, roomy ? paceMarkStyles(timeLeft) : null] as const;
}

const OUTCOME_TEXT: Record<ProviderConsumeResetCreditOutcome, string> = {
  reset: "已重置，当前周期的额度已清零。",
  nothingToReset: "现在没有需要重置的额度。",
  noCredit: "没有剩余的重置次数了。",
  alreadyRedeemed: "这次重置已经兑换过了。",
};

/** 把派生逻辑里的兑换目标换成契约类型；本机实例要在当前提供方里找得到 */
function toConsumeInput(
  input: LimitRedeemInput,
  providers: readonly LimitProvider[],
): ProviderConsumeResetCreditInput | null {
  if ("sourceId" in input) return input;
  const provider = providers.find((candidate) => candidate.instanceId === input.instanceId);
  return provider ? { instanceId: provider.instanceId } : null;
}

export function useResetCredit(input: LimitRedeemInput) {
  const { limits } = useUsageLimitsState();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const redeem = async () => {
    setConfirming(false);
    const target = toConsumeInput(input, limits?.providers ?? []);
    if (target === null) {
      setStatus("找不到这个账号，刷新后再试。");
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const result = await window.factorySwitch.consumeResetCredit(target);
      setStatus(result.ok ? (result.warning ?? OUTCOME_TEXT[result.outcome]) : result.message);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "使用重置次数失败。");
    } finally {
      setBusy(false);
    }
  };

  return { confirming, setConfirming, busy, status, redeem };
}

/** 兑换会真的消耗次数，必须二次确认 */
export function ResetCreditDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: () => void;
}) {
  if (!open) return null;
  return (
    <ConfirmDialog
      title="使用一次重置额度？"
      confirmLabel="使用重置"
      onConfirm={onConfirm}
      onClose={() => onOpenChange(false)}
    >
      <p>这会消耗账号上的一次重置次数，并清空当前周期的用量限制，无法撤销。</p>
    </ConfirmDialog>
  );
}

export function resetCreditsSummary(
  credits: ServerProviderResetCredits,
  now: number,
  compact = false,
): string {
  const expiresIn = credits.nextExpiresAt
    ? formatDuration(Date.parse(credits.nextExpiresAt) - now)
    : null;
  if (credits.availableCount === 0) return "没有可用的重置次数";
  if (compact) {
    return `剩 ${credits.availableCount} 次${expiresIn ? ` · ${expiresIn}后过期` : ""}`;
  }
  return `剩 ${credits.availableCount} 次重置${expiresIn ? ` · 最近一次 ${expiresIn}后过期` : ""}`;
}

const CURSOR_KEYCHAIN_COPY = "需要读取 macOS 钥匙串里的 Cursor 登录，系统可能会弹窗请求授权。";

/** 额度页里的 Cursor 授权提示，对应 T3 的 CursorEnableLimits */
export function CursorEnableLimits({ onEnable }: { readonly onEnable: () => Promise<void> }) {
  const [pending, setPending] = useState(false);
  return (
    <section className="flex flex-col gap-3">
      <h2 className="flex items-center gap-2 text-sm font-medium text-foreground">
        <span
          aria-hidden
          className="inline-flex size-5 items-center justify-center rounded-[2px] bg-muted text-[10px] font-semibold"
        >
          {PROVIDER_PRESENTATION.cursor.mark}
        </span>
        Cursor
      </h2>
      <div className="flex flex-col items-start gap-3 rounded-[2px] border border-border p-4">
        <p className="text-xs text-muted-foreground">{CURSOR_KEYCHAIN_COPY}</p>
        <button
          type="button"
          disabled={pending}
          aria-busy={pending}
          onClick={() => {
            setPending(true);
            void onEnable().finally(() => setPending(false));
          }}
          className="inline-flex h-6 items-center rounded-[2px] border border-border-strong px-3 text-xs hover:border-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending ? "开启中…" : "开启"}
        </button>
      </div>
    </section>
  );
}

/**
 * 额度页正文：按提供方筛选后交给额度池视图。
 * now 只在显式刷新时前进，避免时钟跳动引起整页重绘。
 */
export function UsageLimitsSection({
  hiddenProviders,
  now,
  cursorPrompt,
}: {
  readonly hiddenProviders: ReadonlySet<UsageProviderKind>;
  readonly now: number;
  readonly cursorPrompt?: ReactNode;
}) {
  const { limits, error } = useUsageLimitsState();
  if (limits === null) {
    return (
      <p className="text-sm text-muted-foreground">{error ?? "正在读取各家的额度…"}</p>
    );
  }
  const isVisible = (driver: LimitDriver) => !hiddenProviders.has(DRIVER_PROVIDER[driver]);
  const presentations: LimitPresentations = new Map([
    [
      LOCAL_ENVIRONMENT_ID,
      {
        entry: { target: { label: LOCAL_ENVIRONMENT_LABEL } },
        serverConfig: {
          providers: limits.providers.filter((provider) => isVisible(provider.driver)),
          usageLimitSources: limits.usageLimitSources.flatMap((source) => {
            const accounts = source.accounts.filter((account) => isVisible(account.driver));
            return accounts.length === 0 && source.accounts.length > 0
              ? []
              : [{ ...source, accounts }];
          }),
        },
      },
    ],
  ]);
  return (
    <>
      {error ? <p className="text-xs text-warning-foreground">{error}</p> : null}
      <UsageLimitsPooled presentations={presentations} now={now} cursorPrompt={cursorPrompt} />
    </>
  );
}
