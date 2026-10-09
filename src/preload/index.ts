import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { FactorySwitchApi } from "../shared/types";

const api: FactorySwitchApi = {
  getState: () => ipcRenderer.invoke("get-state"),
  backupCurrent: (label) => ipcRenderer.invoke("backup-current", label),
  deleteLocalCredentials: () => ipcRenderer.invoke("delete-local-credentials"),
  switchTo: (accountId) => ipcRenderer.invoke("switch-to", accountId),
  renameAccount: (accountId, label) =>
    ipcRenderer.invoke("rename-account", accountId, label),
  removeAccount: (accountId) => ipcRenderer.invoke("remove-account", accountId),
  onProgress: (listener) => {
    const handler = (_event: IpcRendererEvent, message: string) =>
      listener(message);
    ipcRenderer.on("progress", handler);
    return () => ipcRenderer.removeListener("progress", handler);
  },
};

contextBridge.exposeInMainWorld("factorySwitch", api);
