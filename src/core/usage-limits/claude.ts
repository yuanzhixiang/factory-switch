// Claude 额度：用 Claude Agent SDK 启动本机 claude，只做本地初始化握手并读 get_usage，
// 提示词永远不发出，不会产生 API 请求。流程移植自 T3 Code（MIT）apps/server/src/provider/ClaudeProvider.ts。
import fs from "node:fs/promises";

import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import type { LimitProvider } from "../../shared/usage-limits";
import { findBinary, toolPath } from "./binaries";
import { claudeUsageResponseToLimits, type ClaudeUsageResponse } from "./claude-limits";
import { makeUnavailableUsageLimits } from "./common";

// Bedrock 初始化包含后端启动和 awsAuthRefresh，比官方登录慢
const CAPABILITIES_PROBE_TIMEOUT_MS = 25_000;
const USAGE_TIMEOUT_MS = 4_000;
const MANAGED_MCP_CONFIG_PATH = "/Library/Application Support/ClaudeCode/managed-mcp.json";

function toTitleCaseWords(value: string): string {
  const parts: string[] = [];
  for (const part of value.split(/[\s_-]+/g)) {
    if (part.length > 0) parts.push(part[0]!.toUpperCase() + part.slice(1).toLowerCase());
  }
  return parts.join(" ");
}

function claudeSubscriptionLabel(subscriptionType: string | undefined): string | undefined {
  const normalized = subscriptionType?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;
  switch (normalized) {
    case "claudemaxsubscription":
      return "Max";
    case "claudemax5xsubscription":
      return "Max 5x";
    case "claudemax20xsubscription":
      return "Max 20x";
    case "claudeenterprisesubscription":
      return "Enterprise";
    case "claudeteamsubscription":
      return "Team";
    case "claudeprosubscription":
      return "Pro";
    case "claudefreesubscription":
      return "Free";
    case "max":
    case "maxplan":
      return "Max";
    case "max5":
      return "Max 5x";
    case "max20":
      return "Max 20x";
    case "enterprise":
      return "Enterprise";
    case "team":
      return "Team";
    case "pro":
      return "Pro";
    case "free":
      return "Free";
    default:
      return toTitleCaseWords(subscriptionType!);
  }
}

function formatClaudeSubscriptionAuthLabel(subscriptionType: string): string {
  const subscriptionLabel =
    claudeSubscriptionLabel(subscriptionType) ?? toTitleCaseWords(subscriptionType);
  const normalized = subscriptionLabel.toLowerCase().replace(/[\s_-]+/g, "");
  if (normalized.startsWith("claude") && normalized.endsWith("subscription")) {
    return subscriptionLabel;
  }
  if (normalized.startsWith("claude")) return `${subscriptionLabel} Subscription`;
  if (normalized.endsWith("subscription")) return `Claude ${subscriptionLabel}`;
  return `Claude ${subscriptionLabel} Subscription`;
}

function isApiKeyAuth(authMethod: string | undefined): boolean {
  const normalized = authMethod?.toLowerCase().replace(/[\s_-]+/g, "");
  return (
    normalized === "apikey" || normalized === "anthropicapikey" || normalized === "anthropicauthtoken"
  );
}

interface ClaudeAccount {
  readonly email?: string;
  readonly subscriptionType?: string;
  readonly tokenSource?: string;
  readonly apiKeySource?: string;
  readonly apiProvider?: string;
}

/** 对应 T3 的 claudeAuthStatus */
function claudeAuthStatus(account: ClaudeAccount): "authenticated" | "unauthenticated" {
  if (account.apiProvider !== undefined && account.apiProvider !== "firstParty") {
    return "authenticated";
  }
  if (account.tokenSource !== undefined && account.tokenSource !== "none") return "authenticated";
  // API Key 可能 tokenSource 为 none，还要看 key 和账号字段
  const hasApiKey = Boolean(account.apiKeySource) && account.apiKeySource !== "none";
  return hasApiKey || account.email || account.subscriptionType
    ? "authenticated"
    : "unauthenticated";
}

function claudeAuthLabel(account: ClaudeAccount, customEndpoint: boolean): string | undefined {
  if (isApiKeyAuth(account.tokenSource)) return "Claude API Key";
  if (account.subscriptionType) return formatClaudeSubscriptionAuthLabel(account.subscriptionType);
  if (account.apiProvider === "bedrock") return "Amazon Bedrock";
  return customEndpoint ? "Custom API endpoint" : undefined;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

const BASE = {
  instanceId: "claudeAgent",
  driver: "claudeAgent",
  enabled: true,
} as const;

/** 探测一次 Claude 账号和额度 */
export async function probeClaude(now: () => Date = () => new Date()): Promise<LimitProvider> {
  const checkedAt = now().toISOString();
  const executable = await findBinary("claude");
  if (!executable) {
    return {
      ...BASE,
      installed: false,
      status: "warning",
      message: "没有找到 claude 命令。",
      auth: { status: "unknown" },
      checkedAt,
    };
  }
  const managedMcpConfig = await fs.access(MANAGED_MCP_CONFIG_PATH).then(
    () => true,
    () => false,
  );
  const abort = new AbortController();
  try {
    const q = query({
      // 提示词生成器永远不产出消息，只做本地初始化通信，不会向 Anthropic 发请求
      // eslint-disable-next-line require-yield
      prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
        await new Promise<void>((resolve) => {
          if (abort.signal.aborted) resolve();
          else abort.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      })(),
      options: {
        persistSession: false,
        pathToClaudeCodeExecutable: executable,
        abortController: abort,
        settingSources: ["user", "project", "local"],
        // 禁用 hooks，避免每次探测都触发 SessionStart
        settings: { disableAllHooks: true },
        allowedTools: [],
        // 不加载文件系统里的 MCP；有 managed-mcp.json 时不能传严格模式
        mcpServers: {},
        ...(managedMcpConfig ? {} : { strictMcpConfig: true }),
        env: {
          ...process.env,
          PATH: await toolPath(),
          ENABLE_CLAUDEAI_MCP_SERVERS: "false",
          FORCE_CODE_TERMINAL: undefined,
          CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
          CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
        },
        stderr: () => {},
      },
    });
    const init = await withTimeout(
      q.initializationResult(),
      CAPABILITIES_PROBE_TIMEOUT_MS,
      `检查 Claude 账号状态超时（${CAPABILITIES_PROBE_TIMEOUT_MS / 1000} 秒）。`,
    );
    // 额度单独计时，慢了不影响账号结果；只读额度，跳过扫描本地日志的 behaviors
    const usageCheckedAt = now().toISOString();
    const usage = await withTimeout(
      q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
      USAGE_TIMEOUT_MS,
      "Claude 读取额度超时。",
    ).then(
      (result): ClaudeUsageResponse => ({
        rate_limits_available: result.rate_limits_available,
        rate_limits: result.rate_limits as ClaudeUsageResponse["rate_limits"],
      }),
      () => undefined,
    );
    const account = (init.account ?? {}) as ClaudeAccount;
    const endpoint = URL.parse(process.env.ANTHROPIC_BASE_URL?.trim() ?? "");
    const customEndpoint =
      endpoint !== null &&
      (endpoint.protocol === "http:" || endpoint.protocol === "https:") &&
      endpoint.hostname !== "" &&
      endpoint.hostname !== "api.anthropic.com";
    if (!customEndpoint && claudeAuthStatus(account) === "unauthenticated") {
      return {
        ...BASE,
        installed: true,
        status: "error",
        message: "Claude Code 还没登录，运行 `claude auth login` 后重试。",
        auth: { status: "unauthenticated" },
        checkedAt,
      };
    }
    const label = claudeAuthLabel(account, customEndpoint);
    return {
      ...BASE,
      installed: true,
      status: "ready",
      auth: {
        status: "authenticated",
        ...(account.email ? { email: account.email } : {}),
        ...(label ? { label } : {}),
      },
      usageLimits: usage
        ? claudeUsageResponseToLimits({ response: usage, checkedAt: usageCheckedAt }).limits
        : makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed" }),
      checkedAt,
    };
  } catch (error) {
    return {
      ...BASE,
      installed: true,
      status: "warning",
      message: (error as Error).message || "Claude CLI 检查账号状态失败。",
      auth: { status: "unknown" },
      usageLimits: makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed" }),
      checkedAt,
    };
  } finally {
    if (!abort.signal.aborted) abort.abort();
  }
}
