// Codex 额度：启动 `codex app-server`，用 JSON-RPC 读账号和额度、兑换重置次数。
// 流程移植自 T3 Code（MIT）apps/server/src/provider/CodexProvider.ts 和 Drivers/CodexDriver.ts，
// T3 用 effect-codex-app-server 客户端，这里换成按行读写 JSON 的最小实现。
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import readline from "node:readline";

import type {
  LimitProvider,
  ProviderConsumeResetCreditOutcome,
} from "../../shared/usage-limits";
import { findBinary, toolPath } from "./binaries";
import {
  codexRateLimitsToLimits,
  type CodexRateLimitSnapshot,
  type CodexResetCreditsSummary,
} from "./codex-limits";
import { makeUnavailableUsageLimits } from "./common";

const CLIENT_VERSION = "0.0.3";
const RATE_LIMITS_PROBE_TIMEOUT_MS = 3_000;
const CODEX_AUTH_PROBE_TIMEOUT_MS = 20_000;
const CONSUME_TIMEOUT_MS = 20_000;

export class CodexRequestError extends Error {
  constructor(
    readonly code: number | undefined,
    message: string,
  ) {
    super(message);
  }
}

interface CodexAppServer {
  request<T>(method: string, params: unknown, timeoutMs: number): Promise<T>;
  close(): void;
}

/** 启动 app-server 并完成 initialize 握手 */
async function startCodexAppServer(binary: string): Promise<{
  readonly server: CodexAppServer;
  readonly userAgent: string;
}> {
  const child = spawn(binary, ["app-server"], {
    cwd: process.cwd(),
    env: { ...process.env, PATH: await toolPath() },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let nextId = 1;
  let exited = false;
  const failAll = (error: Error) => {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  child.on("error", (error) => {
    exited = true;
    failAll(new CodexRequestError(undefined, `Codex 启动失败：${error.message}`));
  });
  child.on("exit", () => {
    exited = true;
    failAll(new CodexRequestError(undefined, "Codex 在返回结果前退出了。"));
  });
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    let message: { id?: unknown; result?: unknown; error?: { code?: number; message?: string } };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return;
    }
    if (typeof message.id !== "number") return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) {
      entry.reject(
        new CodexRequestError(message.error.code, message.error.message ?? "Codex 请求失败"),
      );
    } else {
      entry.resolve(message.result);
    }
  });
  const send = (payload: unknown) => {
    if (!exited) child.stdin.write(`${JSON.stringify(payload)}\n`);
  };
  const server: CodexAppServer = {
    request<T>(method: string, params: unknown, timeoutMs: number) {
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new CodexRequestError(undefined, "Codex 没有回应。"));
        }, timeoutMs);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value as T);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        send({ id, method, params });
      });
    },
    close() {
      if (!exited) child.kill("SIGTERM");
      // 不响应 SIGTERM 时 2 秒后强制结束
      setTimeout(() => {
        if (!exited) child.kill("SIGKILL");
      }, 2_000).unref();
    },
  };
  try {
    const initialize = await server.request<{ userAgent: string }>(
      "initialize",
      {
        clientInfo: { name: "factory-switch", title: "factory-switch", version: CLIENT_VERSION },
        capabilities: { experimentalApi: true },
      },
      CODEX_AUTH_PROBE_TIMEOUT_MS,
    );
    send({ method: "initialized" });
    return { server, userAgent: initialize.userAgent };
  } catch (error) {
    server.close();
    throw error;
  }
}

interface CodexAccount {
  readonly type?: string;
  readonly email?: string;
  readonly planType?: string | null;
}

interface CodexAccountResponse {
  readonly account: CodexAccount | null;
  readonly requiresOpenaiAuth?: boolean;
}

interface CodexRateLimitsResponse {
  readonly rateLimits: CodexRateLimitSnapshot;
  readonly rateLimitsByLimitId?: Record<string, CodexRateLimitSnapshot> | null;
  readonly rateLimitResetCredits?: CodexResetCreditsSummary | null;
  readonly accountId?: string | null;
}

export function codexPlanLabel(planType: string | null | undefined): string | undefined {
  switch (planType) {
    case "free":
      return "ChatGPT Free Subscription";
    case "go":
      return "ChatGPT Go Subscription";
    case "plus":
      return "ChatGPT Plus Subscription";
    case "pro":
      return "ChatGPT Pro 200 Subscription";
    case "prolite":
      return "ChatGPT Pro 100 Subscription";
    case "promax":
      return "ChatGPT Pro 500 Subscription";
    case "self_serve_business_prolite":
      return "ChatGPT Business Premium Subscription";
    case "team":
    case "self_serve_business_usage_based":
    case "business":
      return "ChatGPT Business Subscription";
    case "ent26":
    case "enterprise_cbp_automation":
    case "enterprise_cbp_usage_based":
    case "enterprise":
      return "ChatGPT Enterprise Subscription";
    case "edu":
    case "edu_plus":
    case "edu_pro":
      return "ChatGPT Edu Subscription";
    case "unknown":
      return "ChatGPT Subscription";
    default:
      return undefined;
  }
}

function codexAccountAuthLabel(account: CodexAccount | null): string | undefined {
  if (!account) return undefined;
  if (account.type === "apiKey") return "OpenAI API Key";
  if (account.type === "amazonBedrock") return "Amazon Bedrock";
  if (account.type !== "chatgpt") return undefined;
  return codexPlanLabel(account.planType);
}

/** 对应 T3 的 codexRateLimitsFailureMessage */
export function rateLimitsFailureMessage(error: unknown): string {
  if (error instanceof CodexRequestError && error.code !== undefined) {
    return `Codex 读取额度失败（JSON-RPC ${error.code}）。`;
  }
  return "Codex 没有回应额度请求。";
}

const BASE = {
  instanceId: "codex",
  driver: "codex",
  enabled: true,
} as const;

/** 探测一次 Codex 账号和额度 */
export async function probeCodex(now: () => Date = () => new Date()): Promise<LimitProvider> {
  const checkedAt = now().toISOString();
  const binary = await findBinary("codex");
  if (!binary) {
    return {
      ...BASE,
      installed: false,
      status: "warning",
      message: "没有找到 codex 命令。",
      auth: { status: "unknown" },
      checkedAt,
    };
  }
  let started: Awaited<ReturnType<typeof startCodexAppServer>>;
  try {
    started = await startCodexAppServer(binary);
  } catch (error) {
    return {
      ...BASE,
      installed: true,
      status: "error",
      message: (error as Error).message,
      auth: { status: "unknown" },
      usageLimits: makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed" }),
      checkedAt,
    };
  }
  const { server, userAgent } = started;
  try {
    const version = /\/([^\s]+)/.exec(userAgent)?.[1];
    const account = await server.request<CodexAccountResponse>(
      "account/read",
      {},
      CODEX_AUTH_PROBE_TIMEOUT_MS,
    );
    if (!account.account && account.requiresOpenaiAuth) {
      return {
        ...BASE,
        installed: true,
        ...(version ? { version } : {}),
        status: "error",
        message: "Codex CLI 还没登录，运行 `codex login` 后重试。",
        auth: { status: "unauthenticated" },
        checkedAt,
      };
    }
    // 额度只是附加信息：失败或太慢就当这次没有额度数据，不影响账号结果
    const rateLimits = await server
      .request<CodexRateLimitsResponse | null>(
        "account/rateLimits/read",
        null,
        RATE_LIMITS_PROBE_TIMEOUT_MS,
      )
      .then(
        (response): { response: CodexRateLimitsResponse } | { failure: string } =>
          response ? { response } : { failure: "Codex 没有回应额度请求。" },
        (error: unknown) => ({ failure: rateLimitsFailureMessage(error) }),
      );
    const authLabel = codexAccountAuthLabel(account.account);
    const email = account.account?.type === "chatgpt" ? account.account.email : undefined;
    const workspaceId =
      "response" in rateLimits ? rateLimits.response.accountId?.trim() : undefined;
    const usageLimits =
      account.account?.type === "apiKey"
        ? makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" })
        : "failure" in rateLimits
          ? makeUnavailableUsageLimits({
              checkedAt,
              reason: "probeFailed",
              message: rateLimits.failure,
            })
          : codexRateLimitsToLimits({
              snapshot: rateLimits.response.rateLimits,
              rateLimitsByLimitId: rateLimits.response.rateLimitsByLimitId,
              resetCredits: rateLimits.response.rateLimitResetCredits,
              checkedAt,
            });
    return {
      ...BASE,
      installed: true,
      ...(version ? { version } : {}),
      status: "ready",
      auth: {
        status: account.account ? "authenticated" : "unknown",
        ...(authLabel ? { label: authLabel } : {}),
        ...(email ? { email } : {}),
        ...(workspaceId ? { workspaceId } : {}),
      },
      usageLimits,
      checkedAt,
    };
  } catch (error) {
    return {
      ...BASE,
      installed: true,
      status: "error",
      message: (error as Error).message,
      auth: { status: "unknown" },
      usageLimits: makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed" }),
      checkedAt,
    };
  } finally {
    server.close();
  }
}

/**
 * 兑换重置次数。同一账号串行；超时等没拿到结果的情况保留幂等键，重试时用同一个，
 * 避免重复消耗（对应 T3 的 resetCreditCoordinator）。
 */
let pendingIdempotencyKey: string | null = null;
let consumeTail: Promise<unknown> = Promise.resolve();

export function consumeCodexResetCredit(): Promise<ProviderConsumeResetCreditOutcome> {
  const run = consumeTail.then(async () => {
    const binary = await findBinary("codex");
    if (!binary) throw new Error("没有找到 codex 命令。");
    const idempotencyKey = pendingIdempotencyKey ?? randomUUID();
    pendingIdempotencyKey = idempotencyKey;
    const { server } = await startCodexAppServer(binary);
    try {
      const response = await server.request<{ outcome: ProviderConsumeResetCreditOutcome }>(
        "account/rateLimitResetCredit/consume",
        { idempotencyKey },
        CONSUME_TIMEOUT_MS,
      );
      pendingIdempotencyKey = null;
      return response.outcome;
    } finally {
      server.close();
    }
  });
  consumeTail = run.catch(() => undefined);
  return run;
}
