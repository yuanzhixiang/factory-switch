import type { ReactNode } from "react";
import { usageLevel } from "../../lib/usage";

export type Pool = "standard" | "core";

export const BAR_FILL = {
  normal: "bg-usage-normal",
  high: "bg-usage-high",
  full: "bg-usage-full",
} as const;

export const LEVEL_TEXT = {
  normal: "text-muted-foreground",
  high: "text-warning-foreground",
  full: "text-destructive-foreground",
} as const;

/** Standard / Droid Core 分段按钮，选中项黑底白字 */
export function PoolToggle({
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

/** 一行用量：标题 + 百分比 + 右侧说明 + 8px 进度条 */
export function UsageBar({
  label,
  percent,
  detail,
}: {
  label: string;
  percent: number;
  detail: ReactNode;
}) {
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
          {detail}
        </p>
      </div>
      <ProgressTrack label={label} percent={percent} className="h-2" />
    </div>
  );
}

/** 进度条本体，颜色按用量等级 */
export function ProgressTrack({
  label,
  percent,
  className,
}: {
  label: string;
  percent: number;
  className: string;
}) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
      className={`overflow-hidden rounded-[2px] bg-track ${className}`}
    >
      <div
        className={`h-full ${BAR_FILL[usageLevel(percent)]}`}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

/** 重置倒计时，前面带 ⟳ */
export function ResetHint({ text }: { text: string }) {
  return (
    <>
      <span aria-hidden>⟳</span>
      {text}
    </>
  );
}
