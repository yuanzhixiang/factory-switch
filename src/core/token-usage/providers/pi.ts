// Pi coding agent 的用量：读 ~/.pi/agent/sessions 下的 JSONL。
// 移植自 T3 Code（MIT）packages/provider-pi/src/server/usage.ts，Effect Schema 解码改成手写校验
import path from "node:path";
import {
  parseTimestampMs,
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "../types";
import { expandHomePath } from "./paths";

interface PiScanState {
  sessionId: string;
}

interface PiUsage {
  readonly input?: unknown;
  readonly output?: unknown;
  readonly cacheRead?: unknown;
  readonly cacheWrite?: unknown;
  readonly reasoning?: unknown;
  readonly cost?: { readonly total: unknown };
}

/** 一条有用量的记录：带模型的是 assistant 消息或 usage 行，不带的是工具结果、压缩和分支摘要 */
interface PiUsageEntry {
  readonly id: string;
  readonly timestamp: string;
  readonly usage: PiUsage;
  readonly provider?: string;
  readonly model?: string;
  readonly responseModel?: string;
}

type PiEntry = { readonly type: "session"; readonly id: string } | ({ readonly type: "usage" } & PiUsageEntry);

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function readUsage(value: unknown): PiUsage | null {
  if (!isObject(value)) return null;
  const cost = value["cost"];
  if (cost !== undefined && !(isObject(cost) && "total" in cost)) return null;
  return value as PiUsage;
}

function readModel(value: Json): { provider: string; model: string } | null {
  return isNonEmptyString(value["provider"]) && isNonEmptyString(value["model"])
    ? { provider: value["provider"], model: value["model"] }
    : null;
}

/** 对应 T3 的 Entry 联合类型：session / message(assistant|toolResult) / usage / compaction|branch_summary */
function decodeEntry(parsed: unknown): PiEntry | null {
  if (!isObject(parsed)) return null;
  const type = parsed["type"];
  if (type === "session") {
    return isNonEmptyString(parsed["id"]) ? { type: "session", id: parsed["id"] } : null;
  }
  if (!isNonEmptyString(parsed["id"]) || typeof parsed["timestamp"] !== "string") return null;
  const identity = { id: parsed["id"], timestamp: parsed["timestamp"] };
  if (type === "message") {
    const message = parsed["message"];
    if (!isObject(message)) return null;
    const usage = readUsage(message["usage"]);
    if (usage === null) return null;
    if (message["role"] === "assistant") {
      const model = readModel(message);
      if (model === null) return null;
      const responseModel = message["responseModel"];
      if (responseModel !== undefined && !isNonEmptyString(responseModel)) return null;
      return {
        type: "usage",
        ...identity,
        ...model,
        ...(responseModel === undefined ? {} : { responseModel }),
        usage,
      };
    }
    if (message["role"] === "toolResult") return { type: "usage", ...identity, usage };
    return null;
  }
  if (type === "usage") {
    const model = readModel(parsed);
    const usage = readUsage(parsed["usage"]);
    return model === null || usage === null ? null : { type: "usage", ...identity, ...model, usage };
  }
  if (type === "compaction" || type === "branch_summary") {
    const usage = readUsage(parsed["usage"]);
    return usage === null ? null : { type: "usage", ...identity, usage };
  }
  return null;
}

function parseRecord(parsed: unknown, state: PiScanState): readonly UsageRecord[] {
  const entry = decodeEntry(parsed);
  if (entry === null) return [];
  if (entry.type === "session") {
    state.sessionId = entry.id;
    return [];
  }
  const timestampMs = parseTimestampMs(entry.timestamp);
  if (timestampMs === null) return [];
  const usage = entry.usage;
  // 工具结果和摘要没有模型归属，和 Pi 自己的统计口径一致
  const rateModel = entry.model === undefined ? undefined : (entry.responseModel ?? entry.model);
  const model = entry.provider !== undefined ? `${entry.provider}/${rateModel}` : "Tools/summaries";
  const outputTokens = tokenCount(usage.output);
  const totals = {
    // Pi 的输入和缓存计数互不包含
    uncachedInputTokens: tokenCount(usage.input),
    cachedInputTokens: tokenCount(usage.cacheRead),
    cacheCreationTokens: tokenCount(usage.cacheWrite),
    outputTokens,
    reasoningTokens: Math.min(outputTokens, tokenCount(usage.reasoning)),
  };
  const cost = usage.cost?.total;
  // Pi 没配价格时记 0；没有正数费用就用共用价格表估算
  const reportedCostUsd =
    typeof cost === "number" && Number.isFinite(cost) && cost > 0 ? cost : null;
  if (totalTokens(totals) === 0 && reportedCostUsd === null) return [];
  return [
    {
      provider: "pi",
      timestampMs,
      model,
      ...(rateModel === undefined ? {} : { rateModel }),
      sessionId: state.sessionId,
      totals,
      reportedCostUsd,
      speed: "standard",
      // 分叉会保留 ID 和时间戳；ID 短且随机，要加上时间戳和模型避免跨会话撞车
      dedupeKey: JSON.stringify(["pi", entry.id, entry.timestamp, model]),
    },
  ];
}

function isPiScanState(value: unknown): value is PiScanState {
  return isObject(value) && typeof value["sessionId"] === "string";
}

export const piUsageFormat: TranscriptUsageFormat<PiScanState> = {
  selectFields: {
    type: true,
    id: true,
    timestamp: true,
    provider: true,
    model: true,
    usage: true,
    message: { role: true, provider: true, model: true, responseModel: true, usage: true },
  },
  usageMarkers: ['"usage"', '"session"'],
  parseLine: (line, state) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return [];
    }
    return parseRecord(parsed, state);
  },
  parseProjected: parseRecord,
  state: { initial: () => ({ sessionId: "" }), isState: isPiScanState },
};

export const piUsageReader: ProviderUsageReader = {
  kind: "transcripts",
  provider: "pi",
  format: piUsageFormat as TranscriptUsageFormat<unknown>,
  directories: async ({ homeDir, environment }) => {
    const sessionDir = environment.PI_CODING_AGENT_SESSION_DIR?.trim();
    if (sessionDir) return [{ dir: path.resolve(expandHomePath(sessionDir, homeDir)) }];
    const agentDir = environment.PI_CODING_AGENT_DIR?.trim();
    return [
      {
        dir: path.resolve(
          agentDir ? expandHomePath(agentDir, homeDir) : path.join(homeDir, ".pi", "agent"),
          "sessions",
        ),
      },
    ];
  },
};
