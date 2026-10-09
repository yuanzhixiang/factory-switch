import path from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import { createDefaultEnv } from "../core/env";
import {
  backupCurrent,
  deleteLocalCredentials,
  getState,
  SwitchError,
  switchTo,
} from "../core/operations";
import { removeAccount, renameAccount } from "../core/vault";
import type { OperationResult } from "../shared/types";

let mainWindow: BrowserWindow | null = null;

// 所有进度消息都推给当前窗口
const env = createDefaultEnv((message) => {
  mainWindow?.webContents.send("progress", message);
});

// 同一时间只允许一个会改文件的操作，避免连点两次切换互相覆盖
let busy = false;

/** 串行执行一个操作，统一转成界面能展示的结果 */
async function runOperation(
  action: () => Promise<string>,
): Promise<OperationResult> {
  if (busy) {
    return {
      ok: false,
      message: "上一个操作还没完成",
      state: await getState(env),
    };
  }
  busy = true;
  try {
    const message = await action();
    return { ok: true, message, state: await getState(env) };
  } catch (error) {
    // 预期内的错误直接给用户看，其他错误带上前缀方便排查
    const message =
      error instanceof SwitchError
        ? error.message
        : `出错了：${(error as Error).message}`;
    console.error("[factory-switch]", error);
    return { ok: false, message, state: await getState(env) };
  } finally {
    busy = false;
  }
}

/** 注册页面可以调用的全部操作 */
function registerIpc(): void {
  ipcMain.handle("get-state", () => getState(env));
  ipcMain.handle("backup-current", (_event, label: string | null) =>
    runOperation(() => backupCurrent(env, label)),
  );
  ipcMain.handle("delete-local-credentials", () =>
    runOperation(() => deleteLocalCredentials(env)),
  );
  ipcMain.handle("switch-to", (_event, accountId: string) =>
    runOperation(() => switchTo(env, accountId)),
  );
  ipcMain.handle("rename-account", (_event, accountId: string, label: string) =>
    runOperation(async () => {
      await renameAccount(env, accountId, label);
      return "已改名";
    }),
  );
  ipcMain.handle("remove-account", (_event, accountId: string) =>
    runOperation(async () => {
      await removeAccount(env, accountId);
      return "已删除这个备份（文件已移到 ~/.factory-switch/backups）";
    }),
  );
}

/** 创建主窗口；开发时加载 Vite dev server，打包后加载构建产物 */
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 860,
    height: 640,
    minWidth: 720,
    minHeight: 520,
    title: "Factory 账号切换",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

void app.whenReady().then(() => {
  registerIpc();
  createWindow();
  // macOS 点 Dock 图标时窗口已关就重新开一个
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// 只有一个窗口的小工具，关窗口就退出
app.on("window-all-closed", () => {
  app.quit();
});
