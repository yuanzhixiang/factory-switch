// 各家日志解析器共用的类型，移植自 T3 Code（MIT）packages/provider-core/src/server/usage.ts
import type {
  UsageProviderKind,
  UsageSource,
  UsageTokenTotals,
} from "../../shared/token-usage";

export type UsageSpeed = "standard" | "fast" | "ultrafast";

/** 一次模型请求的用量 */
export interface UsageRecord {
  readonly provider: UsageProviderKind;
  readonly timestampMs: number;
  readonly model: string;
  /** 计价用的模型名，和展示用的 model 不同时才有 */
  readonly rateModel?: string;
  readonly sessionId: string;
  readonly totals: UsageTokenTotals;
  readonly reportedCostUsd: number | null;
  readonly speed: UsageSpeed;
  /** 日志里没写服务档位、需要再查的 Codex turn */
  readonly unresolvedServiceTierTurnId?: string;
  readonly dedupeKey: string | null;
}

export const EMPTY_TOTALS: UsageTokenTotals = {
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
};

export function totalTokens(totals: UsageTokenTotals): number {
  // reasoningTokens 是 outputTokens 的一部分，不能再加
  return (
    totals.uncachedInputTokens +
    totals.cachedInputTokens +
    totals.cacheCreationTokens +
    totals.outputTokens
  );
}

export function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

export function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export type SelectedFields = { readonly [key: string]: true | SelectedFields };

export interface TranscriptUsageFormat<State> {
  /** 超大行走流式解析时只保留这些字段 */
  readonly selectFields: SelectedFields;
  /** ASCII 标记，必须能命中所有相关行，包括只更新状态的行 */
  readonly usageMarkers: readonly [string, ...string[]];
  parseLine(line: string, state: State): readonly UsageRecord[];
  parseProjected(projected: unknown, state: State): readonly UsageRecord[];
  /** 累计的格式错误或不一致的记录数 */
  readMalformedRecords?(state: State): number;
  /**
   * 记录依赖前面行的格式才有。续读位置上的状态会存进扫描缓存，
   * 文件变长时带着它接着读；没有表示每行独立。
   * T3 用 Effect Schema 编解码，这里状态本身就是纯 JSON，只需要校验。
   */
  readonly state?: {
    readonly initial: () => State;
    readonly isState: (value: unknown) => value is State;
  };
  /** 同一会话的记录可能出现在多个文件里时开启跨文件去重 */
  readonly sharedSessionsAcrossFiles?: true;
}

/** 不按 JSONL 文件读、而是自己扫描数据源的提供方返回的结果 */
export interface ProviderUsageScan {
  readonly dir: string;
  readonly volumeId?: string;
  readonly hostId?: string;
  readonly status?: UsageSource["status"];
  readonly message?: string;
  readonly action?: UsageSource["action"];
  readonly files:
    | readonly { readonly path: string; readonly records: readonly UsageRecord[] }[]
    | null;
  readonly refreshing?: true;
}

export interface ProviderUsageScanInput {
  readonly windowStartMs: number;
  readonly retentionCutoffMs: number;
  readonly awaitRefresh: boolean;
}

/** 运行环境：测试时替换成临时目录 */
export interface UsageReaderEnv {
  readonly homeDir: string;
  readonly environment: NodeJS.ProcessEnv;
  /** 读取器自己的缓存目录（Cursor 账号历史） */
  readonly stateDir?: string;
  /** 是否允许读 macOS 钥匙串里的 Cursor 登录，和额度页的开关共用 */
  readonly cursorKeychainUsageEnabled?: () => Promise<boolean>;
  readonly httpFetch?: typeof fetch;
  /** 测试时替换钥匙串读取 */
  readonly readCursorKeychain?: () => Promise<string | null>;
}

export type ProviderUsageReader =
  | {
      readonly kind: "transcripts";
      readonly provider: UsageProviderKind;
      readonly format: TranscriptUsageFormat<unknown>;
      readonly resolveServiceTiers?: (
        records: readonly UsageRecord[],
      ) => Promise<ReadonlyMap<UsageRecord, UsageSpeed>>;
      readonly directories: (
        env: UsageReaderEnv,
      ) => Promise<ReadonlyArray<{ readonly dir: string; readonly fileName?: string }>>;
    }
  | {
      readonly kind: "scan";
      readonly provider: UsageProviderKind;
      /** 整体无法继续时才抛错；单个数据源读不了用 status 表示 */
      readonly scan: (
        env: UsageReaderEnv,
        input: ProviderUsageScanInput,
      ) => Promise<ReadonlyArray<ProviderUsageScan>>;
    };
