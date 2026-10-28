// Claude Code 的用量：读 ~/.claude/projects 下的 JSONL 会话日志。
// 移植自 T3 Code（MIT）apps/server/src/provider/Drivers/claudeUsage.ts
import path from "node:path";
import {
  parseTimestampMs,
  tokenCount,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "../types";

// Claude Code 用这个模型名标记没有真正发到 API 的本地占位消息
export const CLAUDE_SYNTHETIC_MODEL = "<synthetic>";

/**
 * 每个 assistant 内容块各写一行，每行都重复整条消息完整的 `usage`。
 * 直接相加实际会多算约 2.4 倍，所以调用方必须按 `dedupeKey` 去重、保留第一条。
 */
export function parseClaudeLine(line: string): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  return parseClaudeRecord(parsed);
}

function parseClaudeRecord(parsed: unknown): UsageRecord | null {
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  if (record["type"] !== "assistant") return null;

  const message = record["message"];
  if (typeof message !== "object" || message === null) return null;
  const messageRecord = message as Record<string, unknown>;

  const usage = messageRecord["usage"];
  if (typeof usage !== "object" || usage === null) return null;
  const usageRecord = usage as Record<string, unknown>;

  const timestampMs = parseTimestampMs(record["timestamp"]);
  if (timestampMs === null) return null;

  const model = typeof messageRecord["model"] === "string" ? messageRecord["model"] : "";
  if (model.length === 0 || model === CLAUDE_SYNTHETIC_MODEL) return null;

  const messageId = typeof messageRecord["id"] === "string" ? messageRecord["id"] : null;
  const requestId = typeof record["requestId"] === "string" ? record["requestId"] : null;
  const dedupeKey =
    messageId === null && requestId === null ? null : `${messageId ?? ""}:${requestId ?? ""}`;

  const cost = record["costUSD"];

  return {
    provider: "claude",
    timestampMs,
    model,
    sessionId: typeof record["sessionId"] === "string" ? record["sessionId"] : "",
    totals: {
      uncachedInputTokens: tokenCount(usageRecord["input_tokens"]),
      cachedInputTokens: tokenCount(usageRecord["cache_read_input_tokens"]),
      cacheCreationTokens: tokenCount(usageRecord["cache_creation_input_tokens"]),
      outputTokens: tokenCount(usageRecord["output_tokens"]),
      // Anthropic 把思考 token 算进 output，不单独列出
      reasoningTokens: 0,
    },
    reportedCostUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
    speed: usageRecord["speed"] === "fast" ? "fast" : "standard",
    dedupeKey,
  };
}

const orEmpty = (record: UsageRecord | null): readonly UsageRecord[] =>
  record === null ? [] : [record];

export const claudeUsageFormat: TranscriptUsageFormat<void> = {
  selectFields: {
    type: true,
    timestamp: true,
    requestId: true,
    sessionId: true,
    costUSD: true,
    message: { id: true, model: true, usage: true },
  },
  usageMarkers: ['"usage"'],
  parseLine: (line) => orEmpty(parseClaudeLine(line)),
  parseProjected: (projected) => orEmpty(parseClaudeRecord(projected)),
};

export const claudeUsageReader: ProviderUsageReader = {
  kind: "transcripts",
  provider: "claude",
  format: claudeUsageFormat as TranscriptUsageFormat<unknown>,
  // T3 还支持在设置里指定主目录，这里只认环境变量 CLAUDE_CONFIG_DIR 和默认目录
  directories: async ({ homeDir, environment }) => {
    const home = environment.CLAUDE_CONFIG_DIR?.trim() || path.join(homeDir, ".claude");
    return [{ dir: path.resolve(home, "projects") }];
  },
};
