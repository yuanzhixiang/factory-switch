// 额度页的共享状态：主进程推送的各家额度、额度来源设置。
// 对应 T3 Code（MIT）里 serverConfig.providers / usageLimitSources 的订阅和 refreshUsageLimits。
import { useSyncExternalStore } from "react";
import type { UsageProviderKind } from "../../../shared/token-usage";
import type {
  LimitDriver,
  UsageLimitsSettingsPatch,
  UsageLimitsSettingsView,
  UsageLimitsState,
} from "../../../shared/usage-limits";

/** 额度用的 driver 和 token 统计的提供方一一对应，用来共用提供方筛选 */
export const DRIVER_PROVIDER: Record<LimitDriver, UsageProviderKind> = {
  claudeAgent: "claude",
  codex: "codex",
  cursor: "cursor",
  opencode: "opencode",
  antigravity: "antigravity",
};

interface LimitsStoreState {
  readonly limits: UsageLimitsState | null;
  readonly settings: UsageLimitsSettingsView | null;
  readonly error: string | null;
}

let state: LimitsStoreState = { limits: null, settings: null, error: null };
const listeners = new Set<() => void>();
let started = false;

function setState(patch: Partial<LimitsStoreState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

/** 第一次有组件订阅时开始监听主进程推送，并取一次当前状态和设置 */
function start() {
  if (started) return;
  started = true;
  const api = window.factorySwitch;
  api.onUsageLimits((limits) => setState({ limits, error: null }));
  void api
    .getUsageLimits()
    .then((limits) => setState({ limits, error: null }))
    .catch((error: unknown) => setState({ error: `读取额度失败：${String(error)}` }));
  void loadUsageLimitsSettings();
}

function subscribe(listener: () => void) {
  start();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useUsageLimitsState(): LimitsStoreState {
  return useSyncExternalStore(subscribe, () => state);
}

/** 自动刷新的最短间隔，对应 T3 refreshUsageLimits 的 automatic 节流 */
const AUTOMATIC_REFRESH_INTERVAL_MS = 60_000;
let lastRefreshAt = 0;

/** 立即重新查一遍额度 */
export async function refreshUsageLimits(): Promise<void> {
  lastRefreshAt = Date.now();
  try {
    const limits = await window.factorySwitch.refreshUsageLimits();
    setState({ limits, error: null });
  } catch (error) {
    setState({ error: `刷新额度失败：${String(error)}` });
  }
}

/** 进入额度视图时用：一分钟内刷新过就不再刷新 */
export async function refreshUsageLimitsIfStale(): Promise<void> {
  if (Date.now() - lastRefreshAt < AUTOMATIC_REFRESH_INTERVAL_MS) return;
  await refreshUsageLimits();
}

export async function loadUsageLimitsSettings(): Promise<UsageLimitsSettingsView | null> {
  try {
    const settings = await window.factorySwitch.getUsageLimitsSettings();
    setState({ settings });
    return settings;
  } catch (error) {
    console.error("读取额度设置失败", error);
    return null;
  }
}

/** 保存设置后重新查额度，新来源或 Cursor 开关立即生效 */
export async function saveUsageLimitsSettings(
  patch: UsageLimitsSettingsPatch,
): Promise<UsageLimitsSettingsView> {
  const settings = await window.factorySwitch.updateUsageLimitsSettings(patch);
  setState({ settings });
  void refreshUsageLimits();
  return settings;
}
