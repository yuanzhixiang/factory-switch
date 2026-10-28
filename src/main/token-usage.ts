import os from "node:os";
import path from "node:path";
import type { IpcMain } from "electron";
import {
  claudeTokens,
  nextDailyAlert,
  readAlertState,
  todayWindow,
  writeAlertState,
} from "../core/token-usage/alerts";
import { createUsageService, UsageReadError } from "../core/token-usage/service";
import { createTokenUsageSettingsStore } from "../core/token-usage/settings";
import type {
  TokenUsageResult,
  TokenUsageSettingsPatch,
  UsageSummaryInput,
} from "../shared/token-usage";

/** Claude Code 当天用量检查间隔 */
const ALERT_INTERVAL_MS = 5 * 60 * 1000;

/** token 统计：服务实例常驻主进程，内存里的扫描缓存跨请求复用 */
export function createTokenUsage(vaultDir: string) {
  const stateDir = path.join(vaultDir, "token-usage");
  const settings = createTokenUsageSettingsStore(stateDir);
  const service = createUsageService({
    stateDir,
    readerEnv: { homeDir: os.homedir(), environment: process.env },
    readSettings: settings.read,
    httpFetch: (input, init) => fetch(input, init),
  });

  const readSummary = async (input: UsageSummaryInput): Promise<TokenUsageResult> => {
    try {
      return { ok: true, summary: await service.readSummary(input) };
    } catch (error) {
      console.error("[factory-switch] token usage", error);
      return error instanceof UsageReadError
        ? { ok: false, reason: error.reason, message: error.message }
        : { ok: false, reason: "scanFailed", message: `读取用量失败：${(error as Error).message}` };
    }
  };

  const alertFile = path.join(stateDir, "claude-daily-alert.json");
  /** 查一次今天 Claude Code 的用量，跨过 1B / 2B 时回调；查询失败等下一轮 */
  const checkAlerts = async (onAlert: (title: string, body: string) => void) => {
    const now = new Date();
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const window = todayWindow(now, timeZone);
    try {
      const tokens = claudeTokens(await service.readSummary(window));
      const { threshold, state } = nextDailyAlert(
        await readAlertState(alertFile),
        window.sinceDay,
        tokens,
      );
      await writeAlertState(alertFile, state);
      if (threshold !== null) {
        onAlert(
          `Claude Code 今天已超过 ${threshold / 1e9}B token`,
          `今天已用 ${(tokens / 1e9).toFixed(2)}B token`,
        );
      }
    } catch (error) {
      console.error("[factory-switch] claude daily alert", error);
    }
  };

  return {
    /** 启动后马上查一次，之后每 5 分钟查一次 */
    startAlerts(onAlert: (title: string, body: string) => void) {
      void checkAlerts(onAlert);
      setInterval(() => void checkAlerts(onAlert), ALERT_INTERVAL_MS);
    },
    register(ipcMain: IpcMain) {
      ipcMain.handle("get-token-usage", (_event, input: UsageSummaryInput) => readSummary(input));
      ipcMain.handle("refresh-token-usage-rates", () => service.refreshRates());
      ipcMain.handle("get-token-usage-settings", () => settings.read());
      ipcMain.handle("update-token-usage-settings", (_event, patch: TokenUsageSettingsPatch) =>
        settings.update(patch),
      );
    },
  };
}
