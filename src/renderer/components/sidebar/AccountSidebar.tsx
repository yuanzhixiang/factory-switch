import type { UsageMap } from "../../../shared/types";
import type { AccountView } from "../../lib/accounts";
import { highestPercent, usageLevel } from "../../lib/usage";
import { useNow } from "../../lib/useNow";

const LEVEL_TEXT = {
  normal: "text-muted-foreground",
  high: "text-warning-foreground",
  full: "text-destructive-foreground",
} as const;

/** 左侧账号导航：列出所有账号和各自最高的使用率，点击切换右侧详情 */
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
          ACCOUNTS
        </p>
        {accounts.length === 0 && (
          <p className="px-2 text-muted-foreground">还没有账号</p>
        )}
        {accounts.map((account) => {
          const snapshot = usage[account.id]?.snapshot ?? null;
          const percent = snapshot
            ? highestPercent(snapshot.standard, now)
            : null;
          const selected = account.id === selectedId;
          return (
            <button
              key={account.id}
              type="button"
              onClick={() => onSelect(account.id)}
              aria-current={selected ? "page" : undefined}
              className={`flex h-8 items-center gap-2 rounded-[2px] px-2 text-left text-[13px] transition-colors ${selected ? "bg-muted" : "hover:bg-muted"}`}
            >
              <span
                className={`size-1.5 shrink-0 rounded-full ${account.isCurrent ? "bg-primary" : "bg-transparent"}`}
                aria-label={account.isCurrent ? "当前登录" : undefined}
              />
              <span className="min-w-0 flex-1 truncate">
                {account.isSaved ? account.label : "未备份的账号"}
              </span>
              <span
                className={`text-[11px] tabular-nums ${percent === null ? "text-muted-foreground" : LEVEL_TEXT[usageLevel(percent)]}`}
              >
                {percent === null ? "—" : `${percent}%`}
              </span>
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
