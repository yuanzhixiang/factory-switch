import { useCallback, useEffect, useRef, useState } from "react";
import type { AppState, OperationResult, UsageMap } from "../shared/types";
import { ActivityLog } from "./components/activity/ActivityLog";
import { ApiKeySection } from "./components/apikey/ApiKeySection";
import { AccountActions } from "./components/detail/AccountActions";
import { AccountHeader } from "./components/detail/AccountHeader";
import { SignedOutNotice } from "./components/detail/SignedOutNotice";
import {
  AccountSidebar,
  OVERVIEW_ID,
} from "./components/sidebar/AccountSidebar";
import { UsageLimits } from "./components/usage/UsageLimits";
import { UsageOverview } from "./components/usage/UsageOverview";
import { buildAccountViews } from "./lib/accounts";
import type { LogLine } from "./lib/log";

/** 页面：左侧账号导航，右侧是全部账号汇总，或选中账号的身份、用量、API Key 和操作 */
export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [usage, setUsage] = useState<UsageMap>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<LogLine[]>([]);
  const nextId = useRef(0);

  const log = useCallback((text: string, tone: LogLine["tone"] = "info") => {
    setLines((previous) => [...previous, { id: nextId.current++, text, tone }]);
  }, []);

  // 订阅主进程推送：操作进度、30 秒一次的用量、点击通知要选中的账号
  useEffect(() => {
    const api = window.factorySwitch;
    const unsubscribes = [
      api.onProgress((message) => log(message)),
      api.onUsage(setUsage),
      api.onSelectAccount(setSelectedId),
    ];
    void api.getUsage().then(setUsage);
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
  }, [log]);

  // 首次打开和每次窗口回到前台都刷新：用户可能刚在 Factory 里登录了新账号
  useEffect(() => {
    const refresh = () => {
      void window.factorySwitch.getState().then(setState);
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  /** 执行一个会改动数据的操作，期间锁住所有按钮；返回操作结果供弹窗决定是否关闭 */
  const run = useCallback(
    (
      operation: () => Promise<OperationResult>,
    ): Promise<OperationResult | null> => {
      setBusy(true);
      return operation()
        .then((result) => {
          setState(result.state);
          log(result.message, result.ok ? "success" : "error");
          return result;
        })
        .catch((error: unknown) => {
          log(`出错了：${String(error)}`, "error");
          return null;
        })
        .finally(() => setBusy(false));
    },
    [log],
  );

  if (!state) {
    return <p className="p-10 text-muted-foreground">正在读取…</p>;
  }

  const accounts = buildAccountViews(state);
  const showOverview = selectedId === OVERVIEW_ID && accounts.length > 0;
  // 选中的账号不存在（被删了或还没选）时，默认看当前登录的账号
  const selected = showOverview
    ? null
    : (accounts.find((account) => account.id === selectedId) ??
      accounts.find((account) => account.isCurrent) ??
      accounts[0] ??
      null);

  return (
    <div className="flex h-screen">
      <AccountSidebar
        accounts={accounts}
        usage={usage}
        selectedId={showOverview ? OVERVIEW_ID : (selected?.id ?? null)}
        factoryRunning={state.factoryRunning}
        onSelect={setSelectedId}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <main className="flex min-h-0 flex-1 flex-col gap-12 overflow-auto px-10 py-8">
          {state.current.kind !== "signed-in" && (
            <SignedOutNotice current={state.current} busy={busy} run={run} />
          )}
          {showOverview ? (
            <UsageOverview
              accounts={accounts}
              usage={usage}
              onSelect={setSelectedId}
            />
          ) : selected ? (
            <>
              <AccountHeader
                key={`header-${selected.id}`}
                account={selected}
                busy={busy}
                run={run}
              />
              <UsageLimits
                key={`usage-${selected.id}`}
                entry={usage[selected.id]}
                emptyState={
                  <p className="text-muted-foreground">
                    {selected.isCurrent
                      ? "本地凭证暂时查不到用量。"
                      : "还没有设置 API Key，无法查询这个账号的用量。在下面设置后显示。"}
                  </p>
                }
              />
              <ApiKeySection
                key={`key-${selected.id}`}
                account={selected}
                busy={busy}
                run={run}
              />
              <AccountActions
                key={`actions-${selected.id}`}
                account={selected}
                busy={busy}
                run={run}
              />
            </>
          ) : (
            <p className="text-muted-foreground">
              还没有任何账号。在 Factory 里登录后回到这里备份。
            </p>
          )}
        </main>
        <ActivityLog lines={lines} busy={busy} />
      </div>
    </div>
  );
}
