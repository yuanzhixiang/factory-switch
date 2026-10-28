// OpenCode Go 额度：用 OpenCode 保存的 Go / Console API Key 调 opencode.ai 的用量接口。
// 移植自 T3 Code（MIT）packages/provider-opencode/src/server/usageLimits.ts。
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { LimitProvider, ServerProviderUsageWindow } from "../../shared/usage-limits";
import { findBinary } from "./binaries";
import { clampPercent, makeUnavailableUsageLimits, makeUsageLimits } from "./common";

const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const REQUEST_TIMEOUT_MS = 5_000;

interface UsageWindow {
  readonly percent: number;
  readonly resetsAt: string;
}

function isUsageWindow(value: unknown): value is UsageWindow {
  if (typeof value !== "object" || value === null) return false;
  const window = value as Record<string, unknown>;
  return (
    typeof window["percent"] === "number" &&
    Number.isFinite(window["percent"]) &&
    typeof window["resetsAt"] === "string" &&
    !Number.isNaN(Date.parse(window["resetsAt"]))
  );
}

/**
 * 读 OpenCode 2 数据库里当前选中的 Console 连接的 Key。先按条件选出一行再解析，
 * 避免 OAuth 或自建服务的连接落到别的已存账号上；active 为 NULL 的行早于选中标记。
 */
function readConsoleApiKey(databasePath: string): string | undefined {
  try {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      database.exec("PRAGMA busy_timeout = 100");
      const row = database
        .prepare(
          `SELECT value FROM credential
           WHERE integration_id = 'opencode' AND active IS NOT 0
           ORDER BY active DESC, time_created DESC, id DESC LIMIT 1`,
        )
        .get() as { value?: unknown } | undefined;
      if (typeof row?.value !== "string") return undefined;
      const stored = JSON.parse(row.value) as {
        type?: unknown;
        key?: unknown;
        metadata?: { server?: unknown } | null;
      };
      if (stored.type !== "key" || typeof stored.key !== "string") return undefined;
      const server = stored.metadata?.server;
      if (typeof server === "string") {
        const url = new URL(server);
        if (`${url.origin}${url.pathname.replace(/\/+$/, "")}` !== "https://opencode.ai/console") {
          return undefined;
        }
      }
      return stored.key.trim();
    } finally {
      database.close();
    }
  } catch {
    return undefined;
  }
}

const BASE = {
  instanceId: "opencode",
  driver: "opencode",
  enabled: true,
} as const;

export async function probeOpenCode(input: {
  readonly environment?: NodeJS.ProcessEnv;
  readonly httpFetch?: typeof fetch;
  readonly now?: () => Date;
} = {}): Promise<LimitProvider> {
  const env = input.environment ?? process.env;
  const httpFetch = input.httpFetch ?? fetch;
  const checkedAt = (input.now ?? (() => new Date()))().toISOString();
  const installed = (await findBinary("opencode")) !== null;
  const provider = (usageLimits: NonNullable<LimitProvider["usageLimits"]>): LimitProvider => ({
    ...BASE,
    installed,
    status: "ready",
    auth: { status: usageLimits.unavailable ? "unknown" : "authenticated" },
    usageLimits,
    checkedAt,
  });
  const unsupported = provider(makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" }));

  try {
    const dataHome = env.XDG_DATA_HOME || path.join(env.HOME || os.homedir(), ".local", "share");
    const authPath = path.join(dataHome, "opencode", "auth.json");
    const contents =
      env.OPENCODE_AUTH_CONTENT ||
      (await fs.readFile(authPath, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "{}";
        throw error;
      }));
    const auth = JSON.parse(contents) as Record<string, unknown>;
    const goAuth = auth["opencode-go"] as { type?: unknown; key?: unknown } | undefined;
    // OpenCode 在环境变量凭证之上叠加保存的 API 凭证
    const goKey = (
      goAuth?.type === "api" && typeof goAuth.key === "string" ? goAuth.key : env.OPENCODE_API_KEY
    )?.trim();
    // OpenCode 2 由 Console 提供 Go 凭证；内联凭证会覆盖本地凭证，包括 Console 连接
    const databaseFile = env.OPENCODE_DB ?? "opencode.db";
    const consoleKey =
      env.OPENCODE_AUTH_CONTENT || databaseFile === ":memory:"
        ? undefined
        : readConsoleApiKey(path.resolve(dataHome, "opencode", databaseFile));
    let apiKey = consoleKey || goKey;
    if (!apiKey) return unsupported;

    const readUsage = (key: string) =>
      httpFetch(USAGE_URL, {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    let response = await readUsage(apiKey);
    if ((response.status === 401 || response.status === 403) && goKey && goKey !== apiKey) {
      apiKey = goKey;
      response = await readUsage(apiKey);
    }
    // 有效的 Zen Key 不一定订阅了 Go
    if (response.status === 403) return unsupported;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { usage?: Record<string, unknown> };
    const rolling = body.usage?.["rolling"];
    const weekly = body.usage?.["weekly"];
    const monthly = body.usage?.["monthly"];
    if (!isUsageWindow(rolling) || !isUsageWindow(weekly) || !isUsageWindow(monthly)) {
      throw new Error("用量格式不对");
    }
    const iso = (value: string) => new Date(value).toISOString();
    const windows: ServerProviderUsageWindow[] = [
      {
        id: "go_rolling",
        kind: "session",
        label: "Go · Session",
        windowDurationMins: 5 * 60,
        usedPercent: clampPercent(rolling.percent),
        resetsAt: iso(rolling.resetsAt),
      },
      {
        id: "go_weekly",
        kind: "weekly",
        label: "Go · Weekly",
        windowDurationMins: 7 * 24 * 60,
        usedPercent: clampPercent(weekly.percent),
        resetsAt: iso(weekly.resetsAt),
      },
      {
        id: "go_monthly",
        kind: "monthly",
        label: "Go · Monthly",
        usedPercent: clampPercent(monthly.percent),
        resetsAt: iso(monthly.resetsAt),
      },
    ];
    // 不加盐的哈希能在不同环境间对上同一个账号；Go Key 是随机的，无法离线猜出
    const credentialFingerprint = createHash("sha256")
      .update(`opencode-go\0${apiKey}`)
      .digest("hex");
    return provider({ ...makeUsageLimits({ checkedAt, windows }), credentialFingerprint });
  } catch {
    return provider(
      makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "OpenCode Go 读取额度失败。",
      }),
    );
  }
}
