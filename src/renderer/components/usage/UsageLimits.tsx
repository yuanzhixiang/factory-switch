import { useState, type ReactNode } from "react";
import type { UsageEntry, UsageWindow } from "../../../shared/types";
import { formatClock } from "../../lib/format";
import {
  effectivePercent,
  formatDollars,
  formatReset,
  usageLevel,
} from "../../lib/usage";
import { useNow } from "../../lib/useNow";
import { Section } from "../shared/Section";

type Pool = "standard" | "core";

const BAR_FILL = {
  normal: "bg-usage-normal",
  high: "bg-usage-high",
  full: "bg-usage-full",
} as const;

const OVERAGE_LABEL: Record<string, string> = {
  droidCore: "Droid Core",
  extraUsage: "Extra Usage",
};

/** 用量区块：复刻 Factory 设置页的 Usage Limits，含 Standard / Droid Core 切换 */
export function UsageLimits({
  entry,
  emptyState,
}: {
  entry: UsageEntry | undefined;
  /** 没有任何数据时展示的内容，由调用方按账号情况决定 */
  emptyState: ReactNode;
}) {
  const [pool, setPool] = useState<Pool>("standard");
  const now = useNow();
  const snapshot = entry?.snapshot ?? null;

  return (
    <Section
      title="Usage Limits"
      action={snapshot && <PoolToggle value={pool} onChange={setPool} />}
    >
      {!entry && <p className="text-muted-foreground">正在查询…</p>}
      {entry && !snapshot && !entry.error && emptyState}
      {snapshot && (
        <div className="flex flex-col gap-4">
          <UsageBar
            label="5-hour usage"
            window={snapshot[pool].fiveHour}
            now={now}
          />
          <UsageBar
            label="Weekly usage"
            window={snapshot[pool].weekly}
            now={now}
          />
          <UsageBar
            label="Monthly usage"
            window={snapshot[pool].monthly}
            now={now}
          />
        </div>
      )}
      {snapshot && (
        <p className="text-[11px] text-muted-foreground">
          Extra Usage {formatDollars(snapshot)} remaining · 超额后切到{" "}
          {OVERAGE_LABEL[snapshot.overagePreference ?? ""] ?? "—"} ·{" "}
          {formatClock(snapshot.fetchedAt)} 更新 ·{" "}
          {entry?.source === "api-key"
            ? "通过 API Key 查询"
            : "通过本地凭证查询"}
          ，每 30 秒刷新
        </p>
      )}
      {entry?.error && (
        <p className="text-[11px] text-destructive-foreground">
          {entry.error}
          {snapshot ? "，上面显示的是上一次查到的数据" : ""}
        </p>
      )}
    </Section>
  );
}

/** Standard / Droid Core 分段按钮，选中项黑底白字 */
function PoolToggle({
  value,
  onChange,
}: {
  value: Pool;
  onChange: (pool: Pool) => void;
}) {
  const option = (pool: Pool, label: string, edge: string) => (
    <button
      type="button"
      aria-pressed={value === pool}
      onClick={() => onChange(pool)}
      className={`h-6 border px-3 text-xs ${edge} ${value === pool ? "border-inverse bg-inverse text-inverse-foreground" : "border-border bg-sidebar text-secondary-foreground hover:text-foreground"}`}
    >
      {label}
    </button>
  );
  return (
    <div className="flex">
      {option("standard", "Standard", "rounded-l-[2px]")}
      {option("core", "Droid Core", "rounded-r-[2px]")}
    </div>
  );
}

/** 一行用量：标题 + 百分比 + 重置倒计时 + 8px 进度条 */
function UsageBar({
  label,
  window,
  now,
}: {
  label: string;
  window: UsageWindow;
  now: number;
}) {
  const percent = effectivePercent(window, now);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <p className="flex items-baseline gap-2">
          <span>{label}</span>
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {percent}%
          </span>
        </p>
        <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <span aria-hidden>⟳</span>
          {formatReset(window.windowEnd, now)}
        </p>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-2 overflow-hidden rounded-[2px] bg-track"
      >
        <div
          className={`h-full ${BAR_FILL[usageLevel(percent)]}`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
