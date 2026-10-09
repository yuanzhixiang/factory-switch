import type { UsageMap, UsageSnapshot } from "../../../shared/types";
import type { AccountView } from "../../lib/accounts";
import { effectivePercent, summarizeMonthly, usageLevel } from "../../lib/usage";
import { useNow } from "../../lib/useNow";
import { LEVEL_TEXT } from "../usage/UsageParts";

/** 侧边栏里代表「全部账号汇总」的选中值 */
export const OVERVIEW_ID = "overview";

const ROW =
  "flex h-8 items-center gap-2 rounded-[2px] px-2 text-left text-[13px] transition-colors";

/** 左侧导航：顶部是全部账号汇总（月度），下面列出各账号的 5 小时使用率，点击切换右侧详情 */
export function AccountSidebar({
  accounts,
  usage,
  selectedId,
  factoryRunning,
  onSelect,
}: {
  accounts: AccountView[];
  usage: UsageMap;
  selectedId: string | null;
  factoryRunning: boolean;
  onSelect: (id: string) => void;
}) {
  const now = useNow();
  const snapshots = accounts
    .map((account) => usage[account.id]?.snapshot)
    .filter((snapshot): snapshot is UsageSnapshot => Boolean(snapshot));
  const monthly = summarizeMonthly(snapshots, "standard", now);
  const overviewSelected = selectedId === OVERVIEW_ID;

  return (
    <aside className="flex w-[240px] shrink-0 flex-col gap-6 border-r border-border bg-sidebar px-3 py-5">
      <div className="flex items-center gap-2 px-2 text-sm font-medium tracking-[0.08em]">
        <span className="text-primary" aria-hidden>
          ✻
        </span>
        FACTORY SWITCH
      </div>

      <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto">
        <p className="px-2 pb-1 font-mono text-[11px] tracking-[0.04em] text-muted-foreground">
          OVERVIEW
        </p>
        <button
          type="button"
          onClick={() => onSelect(OVERVIEW_ID)}
          aria-current={overviewSelected ? "page" : undefined}
          className={`${ROW} ${overviewSelected ? "bg-muted" : "hover:bg-muted"}`}
        >
          <span className="w-1.5 shrink-0 text-center text-[11px] text-muted-foreground" aria-hidden>
            ∑
          </span>
          <span className="min-w-0 flex-1 truncate">全部账号</span>
          <UsagePercent percent={monthly?.percent ?? null} />
        </button>

        <p className="px-2 pt-5 pb-1 font-mono text-[11px] tracking-[0.04em] text-muted-foreground">
          ACCOUNTS
        </p>
        {accounts.length === 0 && (
          <p className="px-2 text-muted-foreground">还没有账号</p>
        )}
        {accounts.map((account) => {
          const snapshot = usage[account.id]?.snapshot ?? null;
          const percent = snapshot
            ? effectivePercent(snapshot.standard.fiveHour, now)
            : null;
          const selected = account.id === selectedId;
          return (
            <button
              key={account.id}
              type="button"
              onClick={() => onSelect(account.id)}
              aria-current={selected ? "page" : undefined}
              className={`${ROW} ${selected ? "bg-muted" : "hover:bg-muted"}`}
            >
              <span
                className={`size-1.5 shrink-0 rounded-full ${account.isCurrent ? "bg-primary" : "bg-transparent"}`}
                aria-label={account.isCurrent ? "当前登录" : undefined}
              />
              <span className="min-w-0 flex-1 truncate">
                {account.isSaved ? account.label : "未备份的账号"}
              </span>
              <UsagePercent percent={percent} />
            </button>
          );
        })}
      </nav>

      <p className="px-2 text-[11px] text-muted-foreground">
        Factory {factoryRunning ? "运行中" : "未运行"}
      </p>
    </aside>
  );
}

function UsagePercent({ percent }: { percent: number | null }) {
  return (
    <span
      className={`text-[11px] tabular-nums ${percent === null ? "text-muted-foreground" : LEVEL_TEXT[usageLevel(percent)]}`}
    >
      {percent === null ? "—" : `${percent}%`}
    </span>
  );
}
