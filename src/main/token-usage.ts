import os from "node:os";
import path from "node:path";
import type { IpcMain } from "electron";
import { createUsageService, UsageReadError } from "../core/token-usage/service";
import { createTokenUsageSettingsStore } from "../core/token-usage/settings";
import type {
  TokenUsageResult,
  TokenUsageSettingsPatch,
  UsageSummaryInput,
} from "../shared/token-usage";

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

  return {
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
