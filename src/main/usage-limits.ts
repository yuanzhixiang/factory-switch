import path from "node:path";
import type { IpcMain } from "electron";
import { probeClaude } from "../core/usage-limits/claude";
import { consumeCodexResetCredit, probeCodex } from "../core/usage-limits/codex";
import { probeCursor } from "../core/usage-limits/cursor";
import { probeOpenCode } from "../core/usage-limits/opencode";
import { createUsageLimitsService } from "../core/usage-limits/service";
import { createUsageLimitsSettingsStore } from "../core/usage-limits/settings";
import type {
  ProviderConsumeResetCreditInput,
  UsageLimitsSettingsPatch,
  UsageLimitsState,
} from "../shared/usage-limits";

/** 各家订阅额度：服务常驻主进程，定时刷新并推给页面 */
export function createUsageLimits(vaultDir: string, onChange: (state: UsageLimitsState) => void) {
  const httpFetch: typeof fetch = (input, init) => fetch(input, init);
  const service = createUsageLimitsService({
    settings: createUsageLimitsSettingsStore(path.join(vaultDir, "usage-limits")),
    probes: {
      claudeAgent: () => probeClaude(),
      codex: () => probeCodex(),
      cursor: (allowKeychain) => probeCursor({ allowKeychain, httpFetch }),
      opencode: () => probeOpenCode({ httpFetch }),
    },
    consumeCodexResetCredit,
    httpFetch,
    onChange,
  });

  return {
    start: () => service.start(),
    register(ipcMain: IpcMain) {
      ipcMain.handle("get-usage-limits", () => service.get());
      ipcMain.handle("refresh-usage-limits", () => service.refresh());
      ipcMain.handle("get-usage-limits-settings", () => service.readSettings());
      ipcMain.handle("update-usage-limits-settings", (_event, patch: UsageLimitsSettingsPatch) =>
        service.updateSettings(patch),
      );
      ipcMain.handle("consume-reset-credit", (_event, input: ProviderConsumeResetCreditInput) =>
        service.consumeResetCredit(input),
      );
    },
  };
}
