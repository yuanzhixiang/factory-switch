import { useState } from "react";
import type {
  UsageMap,
  UsageSnapshot,
  UsageWindow,
} from "../../../shared/types";
import type { AccountView } from "../../lib/accounts";
import { formatClock } from "../../lib/format";
import type { Run } from "../../lib/run";
import {
  effectivePercent,
  formatDollars,
  formatReset,
  summarizePeriod,
  usageLevel,
  type WindowSummary,
} from "../../lib/usage";
import { useNow } from "../../lib/useNow";
import { SwitchConfirmDialog } from "../detail/SwitchConfirmDialog";
import { Button } from "../shared/Button";
import { Section } from "../shared/Section";
import {
  LEVEL_TEXT,
  PoolToggle,
  ProgressTrack,
  ResetHint,
  UsageBar,
  type Pool,
} from "./UsageParts";

const GRID =
  "grid grid-cols-[minmax(0,1fr)_repeat(3,112px)_72px] items-center gap-4";

/** 汇总页：当前账号三个周期、所有账号周度和月度用量相加，下面列出各账号明细并可直接切换 */
export function UsageOverview({
  accounts,
  usage,
  busy,
  run,
  onSelect,
}: {
  accounts: AccountView[];
  usage: UsageMap;
  busy: boolean;
  run: Run;
  onSelect: (id: string) => void;
}) {
  const [pool, setPool] = useState<Pool>("standard");
  const [switching, setSwitching] = useState<AccountView | null>(null);
  const now = useNow();
  const snapshots = accounts
    .map((account) => usage[account.id]?.snapshot)
    .filter((snapshot): snapshot is UsageSnapshot => Boolean(snapshot));
  const weekly = summarizePeriod(snapshots, pool, "weekly", now);
  const monthly = summarizePeriod(snapshots, pool, "monthly", now);
  const lastFetched =
    snapshots.length > 0
      ? Math.max(...snapshots.map((snapshot) => snapshot.fetchedAt))
      : null;
  const extraCents = snapshots.reduce(
    (total, snapshot) => total + snapshot.extraUsageCents,
    0,
  );
  const current = accounts.find((account) => account.isCurrent) ?? null;
  const currentEntry = current ? usage[current.id] : undefined;
  const currentWindows = currentEntry?.snapshot?.[pool];
  // 整页共用一个池切换，放在最上面那个区块的标题右侧
  const toggle = snapshots.length > 0 && (
    <PoolToggle value={pool} onChange={setPool} />
  );

  const windowBar = (label: string, window: UsageWindow) => (
    <UsageBar
      label={label}
      percent={effectivePercent(window, now)}
      detail={<ResetHint text={formatReset(window.windowEnd, now)} />}
    />
  );

  const summaryBar = (label: string, summary: WindowSummary) => (
    <UsageBar
      label={label}
      percent={summary.percent}
      detail={
        <>
          已用 {summary.usedAccounts.toFixed(1)} / {summary.accounts} 个账号 ·{" "}
          <ResetHint text={`最近 ${formatReset(summary.nextReset, now)}`} />
        </>
      }
    />
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

      {current && (
        <Section
          title={
            <>
              当前账号{" "}
              <span className="text-muted-foreground">
                · {current.isSaved ? current.label : "未备份的账号"}
              </span>
            </>
          }
          action={toggle}
        >
          {currentWindows ? (
            <div className="flex flex-col gap-4">
              {windowBar("5-hour usage", currentWindows.fiveHour)}
              {windowBar("Weekly usage", currentWindows.weekly)}
              {windowBar("Monthly usage", currentWindows.monthly)}
            </div>
          ) : (
            <p className="text-muted-foreground">
              {currentEntry ? "当前账号暂时查不到用量。" : "正在查询…"}
            </p>
          )}
        </Section>
      )}

      <Section title="全部账号合计" action={!current && toggle}>
        {weekly && monthly ? (
          <>
            <div className="flex flex-col gap-4">
              {summaryBar("Weekly usage", weekly)}
              {summaryBar("Monthly usage", monthly)}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {monthly.accounts} 个账号的周度、月度用量各自直接相加 · Extra
              Usage 合计 {formatDollars(extraCents)} remaining · 每 30 秒刷新
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
            <span />
          </div>
          {accounts.map((account) => {
            const windows = usage[account.id]?.snapshot?.[pool];
            return (
              <div
                key={account.id}
                className={`${GRID} h-9 rounded-[2px] px-2 text-[13px] transition-colors hover:bg-muted`}
              >
                <button
                  type="button"
                  onClick={() => onSelect(account.id)}
                  className="col-span-4 grid h-full grid-cols-subgrid items-center text-left"
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
                <span className="flex justify-end">
                  {account.isCurrent ? (
                    <span className="flex h-6 items-center rounded-[2px] bg-accent px-2 text-xs text-primary-hover">
                      当前登录
                    </span>
                  ) : (
                    account.isSaved && (
                      <Button
                        variant="outline-primary"
                        disabled={busy}
                        onClick={() => setSwitching(account)}
                      >
                        切换
                      </Button>
                    )
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </Section>

      {switching && (
        <SwitchConfirmDialog
          account={switching}
          run={run}
          onClose={() => setSwitching(null)}
        />
      )}
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
