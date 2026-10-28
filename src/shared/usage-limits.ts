// 各家订阅额度（Limits 页签）的数据契约，移植自 T3 Code（MIT）
// packages/contracts/src/providerUsageLimits.ts 与 ServerProvider 中额度相关的字段。

/** 同一提供方内稳定的窗口 id，局部更新按 id 合并 */
export interface ServerProviderUsageWindow {
  readonly id: string;
  readonly kind: "session" | "weekly" | "monthly" | "other";
  readonly label: string;
  /** 0-100 */
  readonly usedPercent: number;
  readonly resetsAt?: string;
  readonly windowDurationMins?: number;
}

export interface ServerProviderResetCredits {
  readonly availableCount: number;
  readonly nextExpiresAt?: string;
  /** 兑换时指定要用的那张，重试也是同一张 */
  readonly nextCreditId?: string;
}

/** 账号不可用时清空进度条；探测失败时保留上一次的数据 */
export interface ServerProviderUsageLimits {
  readonly checkedAt: string;
  readonly windows: readonly ServerProviderUsageWindow[];
  readonly credentialFingerprint?: string;
  readonly resetCredits?: ServerProviderResetCredits;
  readonly externalUsage?: { readonly label: string; readonly url: string };
  readonly unavailable?: {
    readonly reason: "unsupported" | "probeFailed";
    readonly message?: string;
  };
}

/** T3 的 driver 名，页面按它选颜色和图标 */
export type LimitDriver = "claudeAgent" | "codex" | "cursor" | "opencode" | "antigravity";

/**
 * 本机一个提供方的状态，对应 T3 ServerProvider 里额度页用到的字段。
 * 本程序每家只有一个实例，instanceId 就是 driver 名。
 */
export interface LimitProvider {
  readonly instanceId: LimitDriver;
  readonly driver: LimitDriver;
  /** 用户给实例起的名字；本程序不设置，页面显示邮箱 */
  readonly displayName?: string;
  readonly accentColor?: string;
  readonly enabled: boolean;
  /** 本机找不到这个 CLI / 应用 */
  readonly installed: boolean;
  readonly availability?: "available" | "unavailable";
  readonly status: "ready" | "warning" | "error" | "disabled";
  readonly message?: string;
  readonly version?: string;
  readonly auth: {
    readonly status: "authenticated" | "unauthenticated" | "unknown";
    readonly email?: string;
    readonly workspaceId?: string;
    /** 套餐名，如「Claude Max」「ChatGPT Pro」 */
    readonly label?: string;
  };
  readonly usageLimits?: ServerProviderUsageLimits;
  readonly checkedAt: string;
}

export interface UsageLimitSourceAccount {
  readonly id: string;
  readonly driver: LimitDriver;
  readonly email?: string;
  readonly plan?: string;
  readonly workspaceId?: string;
  readonly usageLimits: ServerProviderUsageLimits;
}

/** 一个 CLIProxyAPI 来源下所有账号的额度 */
export interface UsageLimitSourceSnapshot {
  readonly id: string;
  readonly kind: "cliproxy";
  readonly label: string;
  readonly checkedAt: string;
  readonly accounts: readonly UsageLimitSourceAccount[];
  readonly error?: string;
}

/** 设置里的一个 CLIProxyAPI 来源；managementKey 只存在主进程，页面只拿到是否已设置 */
export interface UsageLimitSourceConfig {
  readonly kind: "cliproxy";
  readonly label?: string;
  readonly url: string;
  readonly managementKey: string;
  readonly enabled: boolean;
}

/** 给页面看的来源配置，不含密钥 */
export interface UsageLimitSourceView {
  readonly id: string;
  readonly kind: "cliproxy";
  readonly label?: string;
  readonly url: string;
  readonly hasManagementKey: boolean;
  readonly enabled: boolean;
}

export interface UsageLimitsSettingsView {
  readonly usageLimitSources: readonly UsageLimitSourceView[];
  /** 允许读 macOS 钥匙串里的 Cursor 登录来查 Cursor 额度（会弹系统授权） */
  readonly cursorKeychainUsageEnabled: boolean;
}

/** 按条目合并，null 删除；managementKey 不传表示沿用原来的 */
export interface UsageLimitsSettingsPatch {
  readonly usageLimitSources?: Readonly<
    Record<
      string,
      | (Omit<UsageLimitSourceConfig, "managementKey"> & { readonly managementKey?: string })
      | null
    >
  >;
  readonly cursorKeychainUsageEnabled?: boolean;
}

export interface UsageLimitsState {
  readonly providers: readonly LimitProvider[];
  readonly usageLimitSources: readonly UsageLimitSourceSnapshot[];
  /** 正在刷新 */
  readonly refreshing: boolean;
}

export type ProviderConsumeResetCreditInput =
  | { readonly instanceId: LimitDriver }
  | { readonly sourceId: string; readonly accountId: string; readonly creditId: string };

export type ProviderConsumeResetCreditOutcome =
  | "reset"
  | "nothingToReset"
  | "noCredit"
  | "alreadyRedeemed";

export type ProviderConsumeResetCreditResult =
  | { readonly ok: true; readonly outcome: ProviderConsumeResetCreditOutcome; readonly warning?: string }
  | { readonly ok: false; readonly message: string };
