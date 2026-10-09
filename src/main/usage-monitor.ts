import type { Env } from "../core/env";
import { getState } from "../core/operations";
import {
  collectUsage,
  detectUsageAlerts,
  type UsageAlert,
} from "../core/usage";
import type { UsageMap } from "../shared/types";

// 用户要求每 30 秒查一次
const POLL_INTERVAL_MS = 30_000;

/** 定时查询所有账号的用量，有变化推给页面，跨过 70% 时发通知 */
export function createUsageMonitor(options: {
  env: Env;
  /** 切换/删除凭证进行中时跳过，避免读到换了一半的凭证 */
  isBusy: () => boolean;
  onUsage: (usage: UsageMap) => void;
  onAlert: (alert: UsageAlert) => void;
}) {
  let usage: UsageMap = {};
  let running: Promise<UsageMap> | null = null;
  let timer: NodeJS.Timeout | null = null;

  /** 查一轮；上一轮还没结束就复用它，不并发请求 */
  async function refresh(): Promise<UsageMap> {
    if (running) {
      return running;
    }
    if (options.isBusy()) {
      return usage;
    }
    running = (async () => {
      const previous = usage;
      const next = await collectUsage(options.env, previous);
      // 通知按查询那一刻的当前账号判断，换号后提醒方向跟着变
      const state = await getState(options.env);
      const currentId =
        state.current.kind === "signed-in" ? state.current.accountId : null;
      for (const alert of detectUsageAlerts(
        previous,
        next,
        currentId,
        state.accounts,
        options.env.now(),
      )) {
        options.onAlert(alert);
      }
      usage = next;
      options.onUsage(next);
      return next;
    })().finally(() => {
      running = null;
    });
    return running.catch((error: unknown) => {
      console.error("[factory-switch] usage", error);
      return usage;
    });
  }

  return {
    refresh,
    get: () => usage,
    start() {
      void refresh();
      timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
      }
    },
  };
}
