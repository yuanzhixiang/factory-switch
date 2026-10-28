// Muse 的用量：读 Muse 主目录 sessions 下各会话的 session.jsonl。
// 移植自 T3 Code（MIT）packages/provider-muse/src/server/usage.ts，Effect Schema 解码改成手写校验
import path from "node:path";
import {
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "../types";
import { expandHomePath } from "./paths";

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

type MuseUsageKey =
  | "input_tokens"
  | "output_tokens"
  | "cached_tokens"
  | "cached_input_tokens"
  | "cache_read_tokens"
  | "cache_write_tokens"
  | "reasoning_tokens";

interface MuseEntry {
  readonly id: string;
  readonly recordedAt: number;
  readonly streamId: string;
  readonly sourceRunRecordId: string | undefined;
  readonly model: string;
  readonly usage: Partial<Record<MuseUsageKey, unknown>>;
}

/** 对应 T3 的 Entry 结构：schema_version 1 的 runtime.session 事件，模型完成或自动评审完成 */
function decodeEntry(parsed: unknown): MuseEntry | null {
  if (!isObject(parsed)) return null;
  if (
    parsed["schema_version"] !== 1 ||
    parsed["record_type"] !== "event" ||
    parsed["payload_type"] !== "runtime.session" ||
    // 原生自动评审完成事件用的是第 3 版 payload
    (parsed["payload_schema_version"] !== 1 && parsed["payload_schema_version"] !== 3) ||
    !isNonEmptyString(parsed["id"]) ||
    typeof parsed["recorded_at"] !== "number"
  ) {
    return null;
  }
  const stream = parsed["stream"];
  if (!isObject(stream) || stream["kind"] !== "session" || !isNonEmptyString(stream["id"])) {
    return null;
  }
  const payload = parsed["payload"];
  if (!isObject(payload)) return null;
  const sourceRunRecordId = payload["source_run_record_id"];
  if (sourceRunRecordId !== undefined && !isNonEmptyString(sourceRunRecordId)) return null;
  const event = payload["event"];
  if (!isObject(event)) return null;
  if (event["kind"] !== "model_completed" && event["kind"] !== "automated_review_completed") {
    return null;
  }
  const rawModel = event["model"];
  const model = isNonEmptyString(rawModel)
    ? rawModel
    : isObject(rawModel) && isNonEmptyString(rawModel["model_id"])
      ? rawModel["model_id"]
      : null;
  if (model === null) return null;
  const usage = event["usage"];
  if (!isObject(usage)) return null;
  return {
    id: parsed["id"],
    recordedAt: parsed["recorded_at"],
    streamId: stream["id"],
    sourceRunRecordId,
    model,
    usage,
  };
}

function parseRecord(parsed: unknown): readonly UsageRecord[] {
  const entry = decodeEntry(parsed);
  if (entry === null) return [];
  if (!Number.isSafeInteger(entry.recordedAt) || entry.recordedAt < 0) return [];
  const { usage } = entry;
  const input = tokenCount(usage.input_tokens);
  const cachedInputTokens = Math.min(
    input,
    tokenCount(usage.cache_read_tokens ?? usage.cached_input_tokens ?? usage.cached_tokens),
  );
  const cacheCreationTokens = Math.min(
    input - cachedInputTokens,
    tokenCount(usage.cache_write_tokens),
  );
  const outputTokens = tokenCount(usage.output_tokens);
  const totals = {
    // Muse 的缓存计数是输入的子集，推理是输出的子集
    uncachedInputTokens: input - cachedInputTokens - cacheCreationTokens,
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens: Math.min(outputTokens, tokenCount(usage.reasoning_tokens)),
  };
  if (totalTokens(totals) === 0) return [];
  return [
    {
      provider: "muse",
      timestampMs: Math.trunc(entry.recordedAt / 1_000),
      model: entry.model,
      sessionId: entry.streamId,
      totals,
      reportedCostUsd: null,
      speed: "standard",
      // 运行时事件可能被复制进另一个会话；外层 ID 变了，source_run_record_id 仍能识别同一次推理
      dedupeKey: JSON.stringify(["muse", entry.sourceRunRecordId ?? entry.id]),
    },
  ];
}

export const museUsageFormat: TranscriptUsageFormat<unknown> = {
  selectFields: {
    schema_version: true,
    record_type: true,
    payload_type: true,
    payload_schema_version: true,
    id: true,
    recorded_at: true,
    stream: { kind: true, id: true },
    payload: { source_run_record_id: true, event: { kind: true, model: true, usage: true } },
  },
  usageMarkers: ['"model_completed"', '"automated_review_completed"'],
  parseLine: (line) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return [];
    }
    return parseRecord(parsed);
  },
  parseProjected: parseRecord,
};

export const museUsageReader: ProviderUsageReader = {
  kind: "transcripts",
  provider: "muse",
  format: museUsageFormat,
  // T3 通过启动 muse 程序握手拿到主目录；本程序不启动它，只认环境变量 MUSE_HOME，没设置就不读
  directories: async ({ homeDir, environment }) => {
    const museHome = environment.MUSE_HOME?.trim();
    return museHome
      ? [{ dir: path.join(expandHomePath(museHome, homeDir), "sessions"), fileName: "session.jsonl" }]
      : [];
  },
};
