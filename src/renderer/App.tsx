import { useCallback, useEffect, useRef, useState } from "react";
import type { AppState, OperationResult } from "../shared/types";
import { AccountList } from "./components/accounts/AccountList";
import { ActivityLog } from "./components/activity/ActivityLog";
import { CurrentAccountCard } from "./components/current/CurrentAccountCard";
import type { LogLine } from "./lib/log";

/** 页面：编排当前账号卡片、账号列表和状态区 */
export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<LogLine[]>([]);
  const nextId = useRef(0);

  const log = useCallback((text: string, tone: LogLine["tone"] = "info") => {
    setLines((previous) => [...previous, { id: nextId.current++, text, tone }]);
  }, []);

  // 主进程推来的进度逐行显示
  useEffect(
    () => window.factorySwitch.onProgress((message) => log(message)),
    [log],
  );

  // 首次打开和每次窗口回到前台都刷新：用户可能刚在 Factory 里登录了新账号
  useEffect(() => {
    const refresh = () => {
      void window.factorySwitch.getState().then(setState);
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  /** 执行一个会改动数据的操作，期间锁住所有按钮 */
  const run = useCallback(
    (operation: () => Promise<OperationResult>) => {
      setBusy(true);
      void operation()
        .then((result) => {
          setState(result.state);
          log(result.message, result.ok ? "success" : "error");
        })
        .catch((error: unknown) => log(`出错了：${String(error)}`, "error"))
        .finally(() => setBusy(false));
    },
    [log],
  );

  if (!state) {
    return <p className="p-8 text-muted-foreground">正在读取…</p>;
  }

  const currentAccountId =
    state.current.kind === "signed-in" ? state.current.savedAccountId : null;

  return (
    <main className="flex h-screen flex-col gap-6 p-6">
      <header className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold">Factory 账号切换</h1>
        <span className="text-xs text-muted-foreground">
          Factory {state.factoryRunning ? "运行中" : "未运行"}
        </span>
      </header>
      <CurrentAccountCard
        current={state.current}
        accounts={state.accounts}
        busy={busy}
        run={run}
      />
      <AccountList
        accounts={state.accounts}
        currentAccountId={currentAccountId}
        busy={busy}
        run={run}
      />
      <ActivityLog lines={lines} busy={busy} />
    </main>
  );
}
