import { useState, type ReactNode } from "react";
import type { UsageEntry, UsageWindow } from "../../../shared/types";
import { formatClock } from "../../lib/format";
import { effectivePercent, formatDollars, formatReset } from "../../lib/usage";
import { useNow } from "../../lib/useNow";
import { Section } from "../shared/Section";
import { PoolToggle, ResetHint, UsageBar, type Pool } from "./UsageParts";

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

  const bar = (label: string, window: UsageWindow) => (
    <UsageBar
      label={label}
      percent={effectivePercent(window, now)}
      detail={<ResetHint text={formatReset(window.windowEnd, now)} />}
    />
  );

  return (
    <Section
      title="Usage Limits"
      action={snapshot && <PoolToggle value={pool} onChange={setPool} />}
    >
      {!entry && <p className="text-muted-foreground">正在查询…</p>}
      {entry && !snapshot && !entry.error && emptyState}
      {snapshot && (
        <div className="flex flex-col gap-4">
          {bar("5-hour usage", snapshot[pool].fiveHour)}
          {bar("Weekly usage", snapshot[pool].weekly)}
          {bar("Monthly usage", snapshot[pool].monthly)}
        </div>
      )}
      {snapshot && (
        <p className="text-[11px] text-muted-foreground">
          Extra Usage {formatDollars(snapshot.extraUsageCents)} remaining ·{" "}
          超额后切到 {OVERAGE_LABEL[snapshot.overagePreference ?? ""] ?? "—"} ·{" "}
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
