import { useState } from "react";
import type {
  UsageMap,
  UsageSnapshot,
  UsageWindow,
} from "../../../shared/types";
import type { AccountView } from "../../lib/accounts";
import { formatClock } from "../../lib/format";
import {
  effectivePercent,
  formatDollars,
  formatReset,
  summarizeMonthly,
  usageLevel,
} from "../../lib/usage";
import { useNow } from "../../lib/useNow";
import { Section } from "../shared/Section";
import {
  LEVEL_TEXT,
  PoolToggle,
  ProgressTrack,
  ResetHint,
  UsageBar,
  type Pool,
} from "./UsageParts";

const GRID = "grid grid-cols-[minmax(0,1fr)_repeat(3,112px)] items-center gap-4";

/** 汇总页：所有账号月度用量相加，下面列出各账号三个周期的明细 */
export function UsageOverview({
  accounts,
  usage,
  onSelect,
}: {
  accounts: AccountView[];
  usage: UsageMap;
  onSelect: (id: string) => void;
}) {
  const [pool, setPool] = useState<Pool>("standard");
  const now = useNow();
  const snapshots = accounts
    .map((account) => usage[account.id]?.snapshot)
    .filter((snapshot): snapshot is UsageSnapshot => Boolean(snapshot));
  const monthly = summarizeMonthly(snapshots, pool, now);
  const lastFetched =
    snapshots.length > 0
      ? Math.max(...snapshots.map((snapshot) => snapshot.fetchedAt))
      : null;
  const extraCents = snapshots.reduce(
    (total, snapshot) => total + snapshot.extraUsageCents,
    0,
  );

  return (
    <>
      <header className="flex flex-col gap-2">
        <h1 className="text-lg">全部账号汇总</h1>
        <p className="text-secondary-foreground">
          {accounts.length} 个账号 · {snapshots.length} 个有用量数据
          {lastFetched !== null && ` · ${formatClock(lastFetched)} 更新`}
        </p>
      </header>

      <Section
        title="Usage Limits"
        action={monthly && <PoolToggle value={pool} onChange={setPool} />}
      >
        {monthly ? (
          <>
            <UsageBar
              label="Monthly usage"
              percent={monthly.percent}
              detail={
                <>
                  已用 {monthly.usedAccounts.toFixed(1)} / {monthly.accounts}{" "}
                  个账号 · <ResetHint text={`最近 ${formatReset(monthly.nextReset, now)}`} />
                </>
              }
            />
            <p className="text-[11px] text-muted-foreground">
              {monthly.accounts} 个账号的月度用量直接相加 · Extra Usage 合计{" "}
              {formatDollars(extraCents)} remaining · 每 30 秒刷新
            </p>
          </>
        ) : (
          <p className="text-muted-foreground">
            还没有任何账号查到用量，给账号设置 API Key 后显示。
          </p>
        )}
      </Section>

      <Section title="各账号明细">
        <div className="flex flex-col">
          <div
            className={`${GRID} border-b border-border px-2 pb-2 text-[11px] text-muted-foreground`}
          >
            <span>账号</span>
            <span>5-hour</span>
            <span>Weekly</span>
            <span>Monthly</span>
          </div>
          {accounts.map((account) => {
            const snapshot = usage[account.id]?.snapshot ?? null;
            const windows = snapshot?.[pool];
            return (
              <button
                key={account.id}
                type="button"
                onClick={() => onSelect(account.id)}
                className={`${GRID} h-9 rounded-[2px] px-2 text-left text-[13px] transition-colors hover:bg-muted`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    className={`size-1.5 shrink-0 rounded-full ${account.isCurrent ? "bg-primary" : "bg-transparent"}`}
                    aria-label={account.isCurrent ? "当前登录" : undefined}
                  />
                  <span className="truncate">
                    {account.isSaved ? account.label : "未备份的账号"}
                  </span>
                </span>
                <MiniUsage window={windows?.fiveHour} now={now} />
                <MiniUsage window={windows?.weekly} now={now} />
                <MiniUsage window={windows?.monthly} now={now} />
              </button>
            );
          })}
        </div>
      </Section>
    </>
  );
}

/** 明细表里的一格：短进度条 + 百分比，没数据显示 — */
function MiniUsage({
  window,
  now,
}: {
  window: UsageWindow | undefined;
  now: number;
}) {
  if (!window) {
    return <span className="text-[11px] text-muted-foreground">—</span>;
  }
  const percent = effectivePercent(window, now);
  return (
    <span className="flex items-center gap-2">
      <ProgressTrack label="用量" percent={percent} className="h-1 w-14" />
      <span
        className={`text-[11px] tabular-nums ${LEVEL_TEXT[usageLevel(percent)]}`}
      >
        {percent}%
      </span>
    </span>
  );
}
