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
      /** 当前账号在备份区里的 ID；没备份过也按同样规则算出，方便和用量对上 */
      accountId: string;
      savedAccountId: string | null;
    }
  | { kind: "signed-out" }
  | { kind: "unreadable"; message: string };

export interface AppState {
  current: CurrentStatus;
  accounts: SavedAccount[];
  /** 已设置 API Key 的账号，值是 Key 的末四位，页面拿不到完整 Key */
  apiKeyHints: Record<string, string>;
  factoryRunning: boolean;
}

/** 一个用量周期（5 小时 / 每周 / 每月） */
export interface UsageWindow {
  usedPercent: number;
  /** 周期结束时间（毫秒时间戳）；周期还没开始计时为 null */
  windowEnd: number | null;
}

/** 一个计费池的三个周期 */
export interface UsagePool {
  fiveHour: UsageWindow;
  weekly: UsageWindow;
  monthly: UsageWindow;
}

/** 某个账号某一时刻的用量 */
export interface UsageSnapshot {
  standard: UsagePool;
  core: UsagePool;
  extraUsageCents: number;
  /** Standard 用完后的去向：droidCore / extraUsage */
  overagePreference: string | null;
  fetchedAt: number;
}

/** 某个账号的用量查询结果 */
export interface UsageEntry {
  /** 本次用什么凭证查的；none 表示没有可用凭证 */
  source: "local-credentials" | "api-key" | "none";
  /** 最近一次成功查到的用量；查询失败时保留上一次的 */
  snapshot: UsageSnapshot | null;
  error: string | null;
}

export type UsageMap = Record<string, UsageEntry>;

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
  setApiKey(accountId: string, apiKey: string): Promise<OperationResult>;
  clearApiKey(accountId: string): Promise<OperationResult>;
  getUsage(): Promise<UsageMap>;
  refreshUsage(): Promise<UsageMap>;
  onProgress(listener: (message: string) => void): () => void;
  onUsage(listener: (usage: UsageMap) => void): () => void;
  /** 点击系统通知时，主进程要求页面选中某个账号 */
  onSelectAccount(listener: (accountId: string) => void): () => void;
}
