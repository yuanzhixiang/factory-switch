import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { FactorySwitchApi } from "../shared/types";

/** 订阅主进程推送的某个频道，返回取消订阅函数 */
function subscribe<T>(channel: string, listener: (payload: T) => void) {
  const handler = (_event: IpcRendererEvent, payload: T) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const api: FactorySwitchApi = {
  getState: () => ipcRenderer.invoke("get-state"),
  backupCurrent: (label) => ipcRenderer.invoke("backup-current", label),
  deleteLocalCredentials: () => ipcRenderer.invoke("delete-local-credentials"),
  switchTo: (accountId) => ipcRenderer.invoke("switch-to", accountId),
  renameAccount: (accountId, label) =>
    ipcRenderer.invoke("rename-account", accountId, label),
  removeAccount: (accountId) => ipcRenderer.invoke("remove-account", accountId),
  setApiKey: (accountId, apiKey) =>
    ipcRenderer.invoke("set-api-key", accountId, apiKey),
  clearApiKey: (accountId) => ipcRenderer.invoke("clear-api-key", accountId),
  getUsage: () => ipcRenderer.invoke("get-usage"),
  refreshUsage: () => ipcRenderer.invoke("refresh-usage"),
  onProgress: (listener) => subscribe("progress", listener),
  onUsage: (listener) => subscribe("usage", listener),
  onSelectAccount: (listener) => subscribe("select-account", listener),
};

contextBridge.exposeInMainWorld("factorySwitch", api);
