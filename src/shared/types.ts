/** 从凭证里读出的账号身份，只含展示和比对用的信息，不含任何 token */
export interface AccountIdentity {
  userId: string;
  orgId: string;
  email: string | null;
  name: string | null;
}

/** 已备份的账号 */
export interface SavedAccount extends AccountIdentity {
  id: string;
  label: string;
  savedAt: number;
  lastUsedAt: number | null;
}

/** 本机当前登录状态 */
export type CurrentStatus =
  | {
      kind: "signed-in";
      identity: AccountIdentity;
      savedAccountId: string | null;
    }
  | { kind: "signed-out" }
  | { kind: "unreadable"; message: string };

export interface AppState {
  current: CurrentStatus;
  accounts: SavedAccount[];
  factoryRunning: boolean;
}

export interface OperationResult {
  ok: boolean;
  message: string;
  state: AppState;
}

/** preload 暴露给页面的接口 */
export interface FactorySwitchApi {
  getState(): Promise<AppState>;
  backupCurrent(label: string | null): Promise<OperationResult>;
  deleteLocalCredentials(): Promise<OperationResult>;
  switchTo(accountId: string): Promise<OperationResult>;
  renameAccount(accountId: string, label: string): Promise<OperationResult>;
  removeAccount(accountId: string): Promise<OperationResult>;
  onProgress(listener: (message: string) => void): () => void;
}
