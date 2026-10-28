// CLIProxyAPI 额度来源：通过管理接口列出账号，再用它的 api-call 代我们带上账号 token
// 去调 Claude / Codex 的用量接口；也能代为兑换 Codex 重置次数。
// 移植自 T3 Code（MIT）apps/server/src/usage/cliproxyApi.ts。
import { createHash } from "node:crypto";

import type {
  ProviderConsumeResetCreditOutcome,
  ServerProviderResetCredits,
  UsageLimitSourceAccount,
  UsageLimitSourceConfig,
} from "../../shared/usage-limits";
import { claudeUsageResponseToLimits } from "./claude-limits";
import { codexPlanLabel } from "./codex";
import { codexRateLimitsToLimits } from "./codex-limits";
import { makeUnavailableUsageLimits } from "./common";

const MANAGEMENT_TIMEOUT_MS = 15_000;
const CODEX_BASE = "https://chatgpt.com/backend-api/wham";
const CREDIT_URL = `${CODEX_BASE}/rate-limit-reset-credits`;

const CREDIT_REDEEM_NAMESPACE = new Uint8Array([
  0x6f, 0x1c, 0x2a, 0x9e, 0x2d, 0x4b, 0x4c, 0x1e, 0x9a, 0x7f, 0x3b, 0x8d, 0x5e, 0x0c, 0x1a, 0x42,
]);

// 补充 CA 能解决证书链不受信任；过期、主机名不符只报错误码
const UNTRUSTED_CERTIFICATE_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

export class UsageLimitSourceError extends Error {}

interface AuthFile {
  readonly id: string;
  readonly auth_index: string;
  readonly provider: string;
  readonly email?: string;
  readonly disabled?: boolean;
  readonly id_token?: {
    readonly chatgpt_account_id?: string;
    readonly chatgpt_plan_type?: string;
    readonly plan_type?: string;
  };
}

function isAuthFile(value: unknown): value is AuthFile {
  if (typeof value !== "object" || value === null) return false;
  const file = value as Record<string, unknown>;
  return (
    typeof file["id"] === "string" &&
    typeof file["auth_index"] === "string" &&
    typeof file["provider"] === "string"
  );
}

// fetch 把 Node 的错误码包在通用 TypeError 里
function nodeErrorCode(cause: unknown): string | undefined {
  for (let error = cause, depth = 0; error instanceof Error && depth < 3; depth += 1) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code)) return code;
    error = error.cause;
  }
  return undefined;
}

// 中转返回的内容可能带凭证；只透露失败类型、HTTP 状态或 Node 错误码
function describeManagementFailure(error: unknown): string {
  if (error instanceof Error && error.name === "TimeoutError") return "中转服务 15 秒内没有响应。";
  if (error instanceof ManagementStatusError) return `中转服务返回 HTTP ${error.status}。`;
  const code = nodeErrorCode(error);
  if (code !== undefined && UNTRUSTED_CERTIFICATE_CODES.has(code)) {
    return `中转服务的 TLS 证书不受信任（${code}）。如果是私有 CA，把它加到 NODE_EXTRA_CA_CERTS。`;
  }
  if (code !== undefined) return `中转服务请求失败（${code}）。`;
  return "中转服务管理接口请求失败。";
}

class ManagementStatusError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

/** 按账号和重置次数生成 UUIDv5，重试时同一次兑换用同一个请求 ID */
export function creditRedeemRequestId(accountId: string, creditId: string): string {
  const name = new TextEncoder().encode(`${accountId}:${creditId}`);
  const input = new Uint8Array(CREDIT_REDEEM_NAMESPACE.length + name.length);
  input.set(CREDIT_REDEEM_NAMESPACE);
  input.set(name, CREDIT_REDEEM_NAMESPACE.length);
  const bytes = createHash("sha1").update(input).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function makeCliproxyApi(httpFetch: typeof fetch, now: () => Date = () => new Date()) {
  const management = async (config: UsageLimitSourceConfig, route: string, body?: unknown) => {
    let url: string;
    try {
      url = new URL(
        `v0/management/${route}`,
        config.url.endsWith("/") ? config.url : `${config.url}/`,
      ).toString();
    } catch {
      throw new UsageLimitSourceError("中转服务地址无效。");
    }
    try {
      const response = await httpFetch(url, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${config.managementKey}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(MANAGEMENT_TIMEOUT_MS),
      });
      if (!response.ok) throw new ManagementStatusError(response.status);
      return (await response.json()) as unknown;
    } catch (error) {
      throw new UsageLimitSourceError(describeManagementFailure(error));
    }
  };

  const authFiles = async (config: UsageLimitSourceConfig): Promise<readonly AuthFile[]> => {
    const response = (await management(config, "auth-files")) as { files?: unknown };
    if (!Array.isArray(response.files)) throw new UsageLimitSourceError("中转服务没能列出账号。");
    return response.files.filter(isAuthFile);
  };

  const apiCall = async (
    config: UsageLimitSourceConfig,
    account: AuthFile,
    url: string,
    data?: unknown,
  ): Promise<string> => {
    const header =
      account.provider === "codex"
        ? {
            Authorization: "Bearer $TOKEN$",
            "Content-Type": "application/json",
            "OpenAI-Beta": "codex-1",
            Originator: "Codex Desktop",
            ...(account.id_token?.chatgpt_account_id
              ? { "Chatgpt-Account-Id": account.id_token.chatgpt_account_id }
              : {}),
          }
        : {
            Authorization: "Bearer $TOKEN$",
            "anthropic-beta": "oauth-2025-04-20",
            // 没有 Claude Code 的 User-Agent 时 OAuth 用量接口可能返回 429
            "User-Agent": "claude-code/2.1.273",
          };
    const raw = (await management(config, "api-call", {
      auth_index: account.auth_index,
      method: data === undefined ? "GET" : "POST",
      url,
      header,
      ...(data === undefined ? {} : { data: JSON.stringify(data) }),
    })) as { status_code?: unknown; body?: unknown };
    if (typeof raw.status_code !== "number" || typeof raw.body !== "string") {
      throw new UsageLimitSourceError("中转服务返回了无法识别的响应。");
    }
    if (raw.status_code < 200 || raw.status_code >= 300) {
      throw new UsageLimitSourceError(`提供方拒绝了中转请求（HTTP ${raw.status_code}）。`);
    }
    return raw.body;
  };

  /** 可用的 Codex 重置次数，按到期时间排序 */
  const credits = async (config: UsageLimitSourceConfig, account: AuthFile) => {
    const body = JSON.parse(await apiCall(config, account, CREDIT_URL)) as {
      credits?: Array<{ id?: unknown; status?: unknown; reset_type?: unknown; expires_at?: unknown }>;
    };
    if (!Array.isArray(body.credits)) throw new UsageLimitSourceError("重置次数格式不对。");
    const nowMs = now().getTime();
    return body.credits
      .filter(
        (credit): credit is { id: string; status: string; reset_type: string; expires_at: string } =>
          typeof credit.id === "string" &&
          typeof credit.status === "string" &&
          typeof credit.reset_type === "string" &&
          typeof credit.expires_at === "string",
      )
      .filter(
        (credit) =>
          credit.reset_type === "codex_rate_limits" &&
          credit.status === "available" &&
          Date.parse(credit.expires_at) > nowMs,
      )
      .toSorted((a, b) => Date.parse(a.expires_at) - Date.parse(b.expires_at));
  };

  const readAccount = async (
    config: UsageLimitSourceConfig,
    account: AuthFile,
  ): Promise<UsageLimitSourceAccount> => {
    const checkedAt = now().toISOString();
    const workspaceId = account.id_token?.chatgpt_account_id?.trim();
    const base = {
      id: account.id,
      driver: account.provider === "codex" ? ("codex" as const) : ("claudeAgent" as const),
      ...(account.email ? { email: account.email } : {}),
      ...(workspaceId ? { workspaceId } : {}),
    };
    try {
      if (account.provider === "claude") {
        const usage = JSON.parse(
          await apiCall(config, account, "https://api.anthropic.com/api/oauth/usage"),
        ) as {
          five_hour?: { utilization: number; resets_at: string | null } | null;
          seven_day?: { utilization: number; resets_at: string | null } | null;
          limits?: Array<{
            kind?: string;
            percent?: number | null;
            resets_at?: string | null;
            scope?: { model?: { display_name?: string } | null } | null;
          }>;
        };
        const model_scoped = (usage.limits ?? []).flatMap((limit) =>
          limit.kind === "weekly_scoped" &&
          typeof limit.scope?.model?.display_name === "string" &&
          typeof limit.percent === "number"
            ? [
                {
                  display_name: limit.scope.model.display_name,
                  utilization: limit.percent,
                  resets_at: limit.resets_at ?? null,
                },
              ]
            : [],
        );
        return {
          ...base,
          plan: "Claude Subscription",
          usageLimits: claudeUsageResponseToLimits({
            checkedAt,
            response: {
              rate_limits_available: true,
              rate_limits: {
                five_hour: usage.five_hour ?? null,
                seven_day: usage.seven_day ?? null,
                model_scoped,
              },
            },
          }).limits,
        };
      }
      const usage = JSON.parse(await apiCall(config, account, `${CODEX_BASE}/usage`)) as {
        plan_type?: string;
        rate_limit?: {
          primary_window?: CodexWindow | null;
          secondary_window?: CodexWindow | null;
        } | null;
      };
      const available = await credits(config, account).catch(() => undefined);
      const next = available?.[0];
      const planType =
        usage.plan_type ?? account.id_token?.plan_type ?? account.id_token?.chatgpt_plan_type;
      const plan = codexPlanLabel(planType);
      const resetCredits: ServerProviderResetCredits | undefined = available
        ? {
            availableCount: available.length,
            ...(next
              ? { nextCreditId: next.id, nextExpiresAt: new Date(next.expires_at).toISOString() }
              : {}),
          }
        : undefined;
      return {
        ...base,
        ...(plan ? { plan } : {}),
        usageLimits: {
          ...codexRateLimitsToLimits({
            checkedAt,
            snapshot: {
              planType: planType ?? null,
              primary: toCodexWindow(usage.rate_limit?.primary_window),
              secondary: toCodexWindow(usage.rate_limit?.secondary_window),
            },
          }),
          ...(resetCredits ? { resetCredits } : {}),
        },
      };
    } catch {
      return {
        ...base,
        usageLimits: makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message: "中转服务读不到这个账号的用量。",
        }),
      };
    }
  };

  const readAccounts = async (
    config: UsageLimitSourceConfig,
  ): Promise<readonly UsageLimitSourceAccount[]> => {
    let accounts: readonly AuthFile[];
    try {
      accounts = await authFiles(config);
    } catch (error) {
      throw error instanceof UsageLimitSourceError
        ? error
        : new UsageLimitSourceError("中转服务没能列出账号。");
    }
    const usable = accounts.filter(
      (account) =>
        !account.disabled && (account.provider === "codex" || account.provider === "claude"),
    );
    // 最多 4 个并发
    const results: UsageLimitSourceAccount[] = new Array(usable.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, usable.length) }, async () => {
        while (next < usable.length) {
          const index = next++;
          results[index] = await readAccount(config, usable[index]!);
        }
      }),
    );
    return results;
  };

  const consume = async (
    config: UsageLimitSourceConfig,
    accountId: string,
    creditId: string,
  ): Promise<{ outcome: ProviderConsumeResetCreditOutcome; warning?: string }> => {
    try {
      const account = (await authFiles(config)).find((entry) => entry.id === accountId);
      if (!account || account.disabled || account.provider !== "codex") {
        throw new UsageLimitSourceError("中转服务上的 Codex 账号不存在或已停用。");
      }
      const body = JSON.parse(
        await apiCall(config, account, `${CREDIT_URL}/consume`, {
          redeem_request_id: creditRedeemRequestId(
            account.id_token?.chatgpt_account_id ?? account.id,
            creditId,
          ),
          credit_id: creditId,
        }),
      ) as { code?: unknown };
      const outcomes = {
        reset: "reset",
        nothing_to_reset: "nothingToReset",
        no_credit: "noCredit",
        already_redeemed: "alreadyRedeemed",
      } as const;
      const outcome =
        typeof body.code === "string" && body.code in outcomes
          ? outcomes[body.code as keyof typeof outcomes]
          : undefined;
      if (outcome === undefined) throw new Error("unexpected");
      if (outcome !== "reset" && outcome !== "alreadyRedeemed") return { outcome };
      const cleared = await management(config, "reset-quota", {
        auth_index: account.auth_index,
      }).then(
        () => true,
        () => false,
      );
      return cleared
        ? { outcome }
        : {
            outcome,
            warning: "已兑换，但中转服务的冷却没能清除，冷却结束后才会恢复路由。",
          };
    } catch (error) {
      throw error instanceof UsageLimitSourceError
        ? error
        : new UsageLimitSourceError("中转服务返回了无法识别的兑换结果。");
    }
  };

  return { readAccounts, consume };
}

interface CodexWindow {
  readonly used_percent: number;
  readonly reset_at?: number | null;
  readonly limit_window_seconds?: number;
}

function toCodexWindow(window: CodexWindow | null | undefined) {
  return window && typeof window.used_percent === "number"
    ? {
        usedPercent: window.used_percent,
        resetsAt: window.reset_at ?? null,
        ...(window.limit_window_seconds === undefined
          ? {}
          : { windowDurationMins: window.limit_window_seconds / 60 }),
      }
    : null;
}
