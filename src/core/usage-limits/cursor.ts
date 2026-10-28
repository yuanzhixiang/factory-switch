// Cursor 额度：用 Cursor CLI 的登录调 Dashboard 接口读本计费周期的用量百分比。
// 移植自 T3 Code（MIT）packages/provider-cursor/src/server/usageLimits.ts 和 CursorKeychain.ts。
// macOS 上 CLI 登录存在钥匙串里，读取会弹系统授权，所以默认不读，需在页面里打开开关。
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { LimitProvider, ServerProviderUsageWindow } from "../../shared/usage-limits";
import { findBinary } from "./binaries";
import { clampPercent, makeUnavailableUsageLimits, makeUsageLimits } from "./common";

const DEFAULT_CURSOR_API_ENDPOINT = "https://api2.cursor.sh";
const KEYCHAIN_CACHE_MS = 5 * 60_000;
const KEYCHAIN_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;

/** 对应 T3 shared/usageLimits.ts 里的 CURSOR_USAGE_WINDOWS */
export const CURSOR_USAGE_WINDOWS = [
  { id: "totalPercentUsed", label: "Overall" },
  { id: "autoPercentUsed", label: "Cursor Models" },
  { id: "apiPercentUsed", label: "Other Models" },
] as const;

export interface CursorUsageResponse {
  readonly billingCycleEnd?: string | number;
  readonly planUsage?: {
    readonly totalPercentUsed?: number;
    readonly autoPercentUsed?: number;
    readonly apiPercentUsed?: number;
  };
}

/** Cursor 后台的百分比包含赠送用量；用「已花 / 上限」算会对不上 */
export function cursorUsageResponseToLimits(response: CursorUsageResponse, checkedAt: string) {
  const resetMs = Number(response.billingCycleEnd);
  const resetsAt =
    resetMs > 0 && !Number.isNaN(new Date(resetMs).getTime())
      ? new Date(resetMs).toISOString()
      : undefined;
  const windows: ServerProviderUsageWindow[] = [];
  if (response.planUsage) {
    for (const { id, label } of CURSOR_USAGE_WINDOWS) {
      const usedPercent = response.planUsage[id];
      if (usedPercent === undefined || !Number.isFinite(usedPercent)) continue;
      windows.push({
        id,
        kind: "monthly",
        label,
        usedPercent: clampPercent(usedPercent),
        ...(resetsAt ? { resetsAt } : {}),
      });
    }
  }
  return windows.length > 0
    ? makeUsageLimits({ checkedAt, windows })
    : makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
}

let keychainCache: { readonly token: string; readonly untilMs: number } | null = null;
let keychainPending: Promise<string | null> | null = null;

/** security 命令找不到条目时的退出码 */
const KEYCHAIN_ITEM_NOT_FOUND = 44;

/**
 * 读钥匙串里 Cursor CLI 的 access token；结果缓存 5 分钟，并发读取共用一次。
 * 没有条目返回 null，其他失败（拒绝授权、超时）抛错。
 */
export function readKeychainToken(): Promise<string | null> {
  if (keychainCache && keychainCache.untilMs > Date.now()) {
    return Promise.resolve(keychainCache.token);
  }
  keychainPending ??= new Promise<string | null>((resolve, reject) => {
    execFile(
      "/usr/bin/security",
      ["find-generic-password", "-s", "cursor-access-token", "-a", "cursor-user", "-w"],
      { timeout: KEYCHAIN_TIMEOUT_MS },
      (error, stdout) => {
        if (error && error.code !== KEYCHAIN_ITEM_NOT_FOUND) {
          reject(new Error("读取 Cursor 钥匙串登录失败"));
          return;
        }
        const token = error ? null : stdout.trim() || null;
        keychainCache = token ? { token, untilMs: Date.now() + KEYCHAIN_CACHE_MS } : null;
        resolve(token);
      },
    );
  }).finally(() => {
    keychainPending = null;
  });
  return keychainPending;
}

const BASE = {
  instanceId: "cursor",
  driver: "cursor",
  enabled: true,
} as const;

export async function probeCursor(input: {
  readonly allowKeychain: boolean;
  readonly environment?: NodeJS.ProcessEnv;
  readonly httpFetch?: typeof fetch;
  readonly now?: () => Date;
  /** 测试时替换钥匙串读取 */
  readonly readKeychain?: () => Promise<string | null>;
}): Promise<LimitProvider> {
  const environment = input.environment ?? process.env;
  const httpFetch = input.httpFetch ?? fetch;
  const checkedAt = (input.now ?? (() => new Date()))().toISOString();
  const installed = (await findBinary("cursor-agent")) !== null || (await findBinary("agent")) !== null;
  const provider = (usageLimits: LimitProvider["usageLimits"], auth: LimitProvider["auth"]) =>
    ({
      ...BASE,
      installed,
      status: "ready",
      auth,
      ...(usageLimits ? { usageLimits } : {}),
      checkedAt,
    }) satisfies LimitProvider;
  const unsupported = (message?: string) =>
    provider(
      makeUnavailableUsageLimits({ checkedAt, reason: "unsupported", ...(message ? { message } : {}) }),
      { status: "unknown" },
    );

  try {
    const endpoint = (environment.CURSOR_API_ENDPOINT?.trim() || DEFAULT_CURSOR_API_ENDPOINT).replace(
      /\/$/,
      "",
    );
    let token = environment.CURSOR_AUTH_TOKEN?.trim();
    // 显式的 API Key 可能对应另一个账号，不能拿 CLI 登录去查
    if (!token && environment.CURSOR_API_KEY?.trim()) return unsupported();
    const credentialStore = environment.AGENT_CLI_CREDENTIAL_STORE;
    if (!token && credentialStore === "memory") {
      return unsupported("查 Cursor 额度需要 CLI 登录或 CURSOR_AUTH_TOKEN。");
    }
    if (!token && credentialStore !== "file") {
      if (!input.allowKeychain) {
        return unsupported("在额度来源设置里允许读取 Cursor 钥匙串登录后才能查看。");
      }
      if (endpoint !== DEFAULT_CURSOR_API_ENDPOINT) {
        return unsupported("用钥匙串登录查 Cursor 额度只支持默认接口地址。");
      }
      token = (await (input.readKeychain ?? readKeychainToken)())?.trim();
    } else if (!token) {
      const file = path.join(environment.HOME || os.homedir(), ".cursor", "auth.json");
      const raw = await fs.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "{}";
        throw error;
      });
      const accessToken = (JSON.parse(raw) as { accessToken?: unknown }).accessToken;
      token = typeof accessToken === "string" ? accessToken.trim() : undefined;
    }
    if (!token) return unsupported();
    const response = await httpFetch(
      `${endpoint}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "connect-protocol-version": "1",
          "x-cursor-client-type": "cli",
        },
        body: "{}",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as CursorUsageResponse;
    return provider(cursorUsageResponseToLimits(body, checkedAt), { status: "authenticated" });
  } catch {
    return provider(
      makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Cursor 读取额度失败。",
      }),
      { status: "unknown" },
    );
  }
}
