// Codex 的用量：读 ~/.codex/sessions 下的 rollout JSONL。
// 移植自 T3 Code（MIT）apps/server/src/provider/Drivers/codexUsage.ts
import path from "node:path";
import type { UsageTokenTotals } from "../../../shared/token-usage";
import {
  parseTimestampMs,
  totalTokens,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
  type UsageSpeed,
} from "../types";

interface CodexTokenUsage {
  readonly input_tokens: number;
  readonly cached_input_tokens: number;
  readonly cache_write_input_tokens: number;
  readonly output_tokens: number;
  readonly reasoning_output_tokens: number;
  readonly total_tokens: number;
}

const CODEX_USAGE_FIELDS: readonly (keyof CodexTokenUsage)[] = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
];

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** 各字段都是非负整数，且缓存不超过输入、推理不超过输出、总数不少于输入加输出 */
function isCodexTokenUsage(value: unknown): value is CodexTokenUsage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const usage = value as Record<string, unknown>;
  if (!CODEX_USAGE_FIELDS.every((key) => isTokenCount(usage[key]))) return false;
  const checked = value as CodexTokenUsage;
  return (
    checked.cached_input_tokens + checked.cache_write_input_tokens <= checked.input_tokens &&
    checked.reasoning_output_tokens <= checked.output_tokens &&
    checked.total_tokens >= checked.input_tokens + checked.output_tokens
  );
}

function readCodexTokenUsage(value: unknown): CodexTokenUsage | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const input = raw["input_tokens"];
  const output = raw["output_tokens"];
  if (typeof input !== "number" || typeof output !== "number") return null;
  const usage = {
    input_tokens: input,
    cached_input_tokens: raw["cached_input_tokens"] === undefined ? 0 : raw["cached_input_tokens"],
    cache_write_input_tokens:
      raw["cache_write_input_tokens"] === undefined ? 0 : raw["cache_write_input_tokens"],
    output_tokens: output,
    reasoning_output_tokens:
      raw["reasoning_output_tokens"] === undefined ? 0 : raw["reasoning_output_tokens"],
    total_tokens: raw["total_tokens"] === undefined ? input + output : raw["total_tokens"],
  };
  return isCodexTokenUsage(usage) ? usage : null;
}

function advanceCodexUsage(previous: CodexTokenUsage | null, last: CodexTokenUsage) {
  return readCodexTokenUsage(
    Object.fromEntries(CODEX_USAGE_FIELDS.map((key) => [key, (previous?.[key] ?? 0) + last[key]])),
  );
}

/**
 * Codex 的 `token_count` 事件不带模型和服务档位，要从前面的行带过来：
 * 模型取最近的 `turn_context`，档位取最近的 `thread_settings_applied`。
 */
export interface CodexScanState {
  model: string;
  speed: UsageSpeed;
  sessionId: string;
  lastUsageSignature: string | null;
  lastCumulativeUsage: CodexTokenUsage | null;
  malformedRecords: number;
  sawSessionMeta: boolean;
  modelProvider: string;
  turnId: string;
  sawThreadSettings: boolean;
  suppressingForkCopies: boolean;
  forkCopyAnchorMs: number;
}

const SPEEDS: readonly unknown[] = ["standard", "fast", "ultrafast"];

/** 校验缓存里读回来的解析状态 */
export function isCodexScanState(value: unknown): value is CodexScanState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return (
    typeof state["model"] === "string" &&
    SPEEDS.includes(state["speed"]) &&
    typeof state["sessionId"] === "string" &&
    (state["lastUsageSignature"] === null || typeof state["lastUsageSignature"] === "string") &&
    (state["lastCumulativeUsage"] === null || isCodexTokenUsage(state["lastCumulativeUsage"])) &&
    isTokenCount(state["malformedRecords"]) &&
    typeof state["sawSessionMeta"] === "boolean" &&
    typeof state["modelProvider"] === "string" &&
    typeof state["turnId"] === "string" &&
    typeof state["sawThreadSettings"] === "boolean" &&
    typeof state["suppressingForkCopies"] === "boolean" &&
    typeof state["forkCopyAnchorMs"] === "number" &&
    Number.isFinite(state["forkCopyAnchorMs"])
  );
}

export function initialCodexScanState(): CodexScanState {
  return {
    model: "",
    speed: "standard",
    sessionId: "",
    lastUsageSignature: null,
    lastCumulativeUsage: null,
    malformedRecords: 0,
    sawSessionMeta: false,
    modelProvider: "",
    turnId: "",
    sawThreadSettings: false,
    suppressingForkCopies: false,
    forkCopyAnchorMs: 0,
  };
}

/** 分叉会集中复制并重打父会话历史的时间戳（间隔 0-40ms）；子会话真实用量要等一轮模型调用（观测到 5 秒以上） */
const FORK_COPY_MAX_GAP_MS = 1000;

function isForkedSessionMeta(payload: Record<string, unknown>): boolean {
  if (typeof payload["forked_from_id"] === "string") return true;
  const source = payload["source"];
  if (typeof source !== "object" || source === null) return false;
  const subagent = (source as Record<string, unknown>)["subagent"];
  if (typeof subagent !== "object" || subagent === null) return false;
  const spawn = (subagent as Record<string, unknown>)["thread_spawn"];
  if (typeof spawn !== "object" || spawn === null) return false;
  return typeof (spawn as Record<string, unknown>)["parent_thread_id"] === "string";
}

/**
 * 用累计计数器校验每次请求的增量；没有累计计数器的旧事件按相邻请求去重。
 */
export function parseCodexLine(line: string, state: CodexScanState): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  return parseCodexRecord(parsed, state);
}

function parseCodexRecord(parsed: unknown, state: CodexScanState): UsageRecord | null {
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  const payload = record["payload"];
  if (typeof payload !== "object" || payload === null) return null;
  const payloadRecord = payload as Record<string, unknown>;
  const payloadType = payloadRecord["type"];

  if (record["type"] === "session_meta") {
    // 只有第一个 meta 代表本会话；复制过来的祖先 meta 会把后面的记录算错会话
    if (state.sawSessionMeta) return null;
    state.sawSessionMeta = true;
    const id = payloadRecord["id"] ?? payloadRecord["session_id"];
    if (typeof id === "string") state.sessionId = id;
    if (typeof payloadRecord["model_provider"] === "string") {
      state.modelProvider = payloadRecord["model_provider"];
    }
    const metaTimestampMs = parseTimestampMs(record["timestamp"]);
    if (metaTimestampMs !== null && isForkedSessionMeta(payloadRecord)) {
      state.suppressingForkCopies = true;
      state.forkCopyAnchorMs = metaTimestampMs;
    }
    return null;
  }

  if (record["type"] === "turn_context") {
    if (typeof payloadRecord["model"] === "string") state.model = payloadRecord["model"];
    // 模型可以沿用，但查历史档位需要这个 turn 自己的 ID
    state.turnId =
      typeof payloadRecord["turn_id"] === "string" &&
      typeof payloadRecord["model"] === "string" &&
      payloadRecord["model"].length > 0
        ? payloadRecord["turn_id"]
        : "";
    return null;
  }

  if (payloadType === "thread_settings_applied") {
    state.sawThreadSettings = true;
    const settings = payloadRecord["thread_settings"];
    if (typeof settings === "object" && settings !== null) {
      state.speed = codexSpeed((settings as Record<string, unknown>)["service_tier"]);
    }
    return null;
  }

  if (payloadType !== "token_count") return null;

  const info = payloadRecord["info"];
  if (typeof info !== "object" || info === null) return null;
  const infoRecord = info as Record<string, unknown>;

  // 模型或时间戳就绪后 Codex 可能重发这些计数
  const timestampMs = parseTimestampMs(record["timestamp"]);
  if (timestampMs === null || state.model.length === 0) return null;

  const last = readCodexTokenUsage(infoRecord["last_token_usage"]);
  const rawCumulative = infoRecord["total_token_usage"];
  const hasCumulative = rawCumulative !== undefined && rawCumulative !== null;
  const cumulative = hasCumulative ? readCodexTokenUsage(rawCumulative) : null;

  if (state.suppressingForkCopies) {
    if (timestampMs - state.forkCopyAnchorMs < FORK_COPY_MAX_GAP_MS) {
      state.forkCopyAnchorMs = timestampMs;
      // 复制来的历史已在父会话计过，只用来建立子会话的基线
      const signature = last === null ? null : JSON.stringify(last);
      if (cumulative !== null) state.lastCumulativeUsage = cumulative;
      else if (!hasCumulative && last !== null && signature !== state.lastUsageSignature) {
        state.lastCumulativeUsage = advanceCodexUsage(state.lastCumulativeUsage, last);
      }
      state.lastUsageSignature = signature;
      return null;
    }
    state.suppressingForkCopies = false;
    state.lastUsageSignature = null;
  }

  const previous = state.lastCumulativeUsage;
  // 即使配对的请求格式有误，有效的累计快照仍作为下一次的基线
  if (cumulative !== null) state.lastCumulativeUsage = cumulative;
  if (last === null || (hasCumulative && cumulative === null)) {
    state.malformedRecords += 1;
    return null;
  }

  // 输入输出都为 0 的计数表示上下文大小而不是请求：fill_to_context_window，
  // 或压缩后的标记（total 是新的上下文大小，累计值可能归零）
  if (last.input_tokens + last.output_tokens === 0) {
    state.lastUsageSignature = null;
    return null;
  }

  if (
    cumulative !== null &&
    previous !== null &&
    CODEX_USAGE_FIELDS.every((key) => cumulative[key] === previous[key])
  ) {
    return null;
  }

  if (last.total_tokens !== last.input_tokens + last.output_tokens) {
    state.malformedRecords += 1;
    return null;
  }

  const signature = JSON.stringify(last);
  if (cumulative !== null) {
    // 在新 Codex 进程里恢复的会话，累计计数从这次请求重新开始
    const restarted = CODEX_USAGE_FIELDS.every((key) => cumulative[key] === last[key]);
    // 分叉和分页续接可能继承累计值却没有复制计数快照。
    // 只计最新这次请求，并要求看不到的前缀也是合法用量
    const reconciled =
      previous === null
        ? readCodexTokenUsage(
            Object.fromEntries(CODEX_USAGE_FIELDS.map((key) => [key, cumulative[key] - last[key]])),
          ) !== null
        : CODEX_USAGE_FIELDS.every((key) => cumulative[key] - previous[key] === last[key]);
    if (!restarted && !reconciled) {
      state.malformedRecords += 1;
      return null;
    }
  } else {
    if (signature === state.lastUsageSignature) return null;
    // 旧格式请求计费后推进期望累计值，之后重发的累计快照就会被视为过期
    const advanced = advanceCodexUsage(previous, last);
    if (advanced === null) {
      state.malformedRecords += 1;
      return null;
    }
    state.lastCumulativeUsage = advanced;
  }
  state.lastUsageSignature = signature;

  const inputTokens = last.input_tokens;
  const cachedInputTokens = last.cached_input_tokens;
  const cacheCreationTokens = last.cache_write_input_tokens;
  const outputTokens = last.output_tokens;

  const totals: UsageTokenTotals = {
    // Codex 的 `input_tokens` 包含缓存部分
    uncachedInputTokens: inputTokens - cachedInputTokens - cacheCreationTokens,
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    // 包含在 output_tokens 里，单独列出用于类型占比
    reasoningTokens: last.reasoning_output_tokens,
  };

  if (totalTokens(totals) === 0) return null;

  return {
    provider: "codex",
    timestampMs,
    model: state.model,
    sessionId: state.sessionId,
    totals,
    reportedCostUsd: null,
    speed: state.speed,
    ...(!state.sawThreadSettings &&
    state.modelProvider === "openai" &&
    state.sessionId.length > 0 &&
    state.turnId.length > 0
      ? { unresolvedServiceTierTurnId: state.turnId }
      : {}),
    dedupeKey: null,
  };
}

/** 没写、default、standard 都按标准档计费；fast 等同 priority */
function codexSpeed(serviceTier: unknown): UsageSpeed {
  if (serviceTier === "priority" || serviceTier === "fast") return "fast";
  if (serviceTier === "ultrafast") return "ultrafast";
  return "standard";
}

const orEmpty = (record: UsageRecord | null): readonly UsageRecord[] =>
  record === null ? [] : [record];

export const codexUsageFormat: TranscriptUsageFormat<CodexScanState> = {
  selectFields: {
    type: true,
    timestamp: true,
    payload: {
      type: true,
      id: true,
      session_id: true,
      model_provider: true,
      turn_id: true,
      model: true,
      thread_settings: { service_tier: true },
      forked_from_id: true,
      source: { subagent: { thread_spawn: { parent_thread_id: true } } },
      info: { last_token_usage: true, total_token_usage: true },
    },
  },
  // 元数据行没有用量，但带着模型、档位和会话
  usageMarkers: ['"token_count"', '"turn_context"', '"thread_settings_applied"', '"session_meta"'],
  parseLine: (line, state) => orEmpty(parseCodexLine(line, state)),
  parseProjected: (projected, state) => orEmpty(parseCodexRecord(projected, state)),
  state: { initial: initialCodexScanState, isState: isCodexScanState },
  readMalformedRecords: (state) => state.malformedRecords,
  // 日志读过之后被移动，两个位置都会有一份
  sharedSessionsAcrossFiles: true,
};

export const codexUsageReader: ProviderUsageReader = {
  kind: "transcripts",
  provider: "codex",
  format: codexUsageFormat as TranscriptUsageFormat<unknown>,
  // T3 会去自己的数据库查它发起的 turn 用的服务档位（resolveServiceTiers）；
  // 本程序不发起 Codex 会话，没有这份记录，日志里没写档位的请求按标准档计价
  directories: async ({ homeDir, environment }) => {
    const home = environment.CODEX_HOME?.trim() || path.join(homeDir, ".codex");
    return [{ dir: path.resolve(home, "sessions") }];
  },
};
