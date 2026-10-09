import type {
  SavedAccount,
  UsageEntry,
  UsageMap,
  UsagePool,
  UsageSnapshot,
  UsageWindow,
} from "../shared/types";
import { HIGH_USAGE_PERCENT } from "../shared/usage";
import type { Env } from "./env";
import { readCurrentAccessToken, SwitchError } from "./operations";
import { listAccounts, readApiKey, writeApiKey } from "./vault";

// Factory 客户端自己用来显示 5 小时/每周/每月用量的接口，不在公开文档里
const LIMITS_URL = "https://api.factory.ai/api/billing/limits";

// 单次查询超时，30 秒轮询一次，不能让一次卡住拖到下一轮
const FETCH_TIMEOUT_MS = 10_000;

/** 查询失败，message 可以直接给用户看 */
export class UsageError extends Error {}

/** 把接口里的一个周期转成内部格式，字段缺失时按 0% 处理 */
function toWindow(raw: unknown): UsageWindow {
  const value = (raw ?? {}) as { usedPercent?: unknown; windowEnd?: unknown };
  const end =
    typeof value.windowEnd === "string" ? Date.parse(value.windowEnd) : NaN;
  return {
    usedPercent:
      typeof value.usedPercent === "number" &&
      Number.isFinite(value.usedPercent)
        ? value.usedPercent
        : 0,
    windowEnd: Number.isNaN(end) ? null : end,
  };
}

function toPool(raw: unknown): UsagePool {
  const value = (raw ?? {}) as Record<string, unknown>;
  return {
    fiveHour: toWindow(value.fiveHour),
    weekly: toWindow(value.weekly),
    monthly: toWindow(value.monthly),
  };
}

/** 把 /api/billing/limits 的响应转成用量快照 */
export function parseLimits(body: unknown, fetchedAt: number): UsageSnapshot {
  const value = (body ?? {}) as {
    limits?: { standard?: unknown; core?: unknown };
    extraUsageBalanceCents?: unknown;
    overagePreference?: unknown;
  };
  // 没有 standard 说明接口格式变了，和 Factory 客户端一样当作查询失败
  if (!value.limits?.standard) {
    throw new UsageError("用量接口的返回格式变了，缺少 limits.standard");
  }
  return {
    standard: toPool(value.limits.standard),
    core: toPool(value.limits.core),
    extraUsageCents:
      typeof value.extraUsageBalanceCents === "number"
        ? value.extraUsageBalanceCents
        : 0,
    overagePreference:
      typeof value.overagePreference === "string"
        ? value.overagePreference
        : null,
    fetchedAt,
  };
}

/** 用 access token 或 API Key 查一次用量 */
export async function fetchUsage(
  env: Env,
  bearer: string,
): Promise<UsageSnapshot> {
  let response: Response;
  try {
    response = await env.httpFetch(LIMITS_URL, {
      headers: { Authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new UsageError("网络错误，查询用量失败");
  }
  if (response.status === 401 || response.status === 403) {
    throw new UsageError(`凭证无效或已过期（${response.status}）`);
  }
  if (!response.ok) {
    throw new UsageError(`查询用量失败（HTTP ${response.status}）`);
  }
  return parseLimits(await response.json(), env.now());
}

/** 查一个账号的用量：当前账号先用本地凭证，失败或不是当前账号时用 API Key */
async function collectOne(
  env: Env,
  account: { id: string },
  localToken: string | null,
  previous: UsageEntry | undefined,
): Promise<UsageEntry> {
  const keep = previous?.snapshot ?? null;
  const apiKey = await readApiKey(env, account.id);
  let error: string | null = null;

  // 1. 当前登录账号用本地 access token，不需要 API Key
  if (localToken) {
    try {
      const snapshot = await fetchUsage(env, localToken);
      return { source: "local-credentials", snapshot, error: null };
    } catch (cause) {
      error = `本地凭证：${(cause as Error).message}`;
    }
  }

  // 2. 其他账号（或本地凭证查失败）用 API Key
  if (apiKey) {
    try {
      const snapshot = await fetchUsage(env, apiKey);
      return { source: "api-key", snapshot, error: null };
    } catch (cause) {
      error = `API Key：${(cause as Error).message}`;
    }
  }

  // 3. 都查不了时保留上一次的数据，界面标出更新时间
  return {
    source: localToken ? "local-credentials" : apiKey ? "api-key" : "none",
    snapshot: keep,
    error,
  };
}

/** 查询当前账号和所有已备份账号的用量 */
export async function collectUsage(
  env: Env,
  previous: UsageMap,
): Promise<UsageMap> {
  const accounts: { id: string }[] = await listAccounts(env);
  // 本地凭证读不出（例如刚删掉）时，当前账号就当作没有
  const local = await readCurrentAccessToken(env).catch(() => null);
  if (local && !accounts.some((account) => account.id === local.accountId)) {
    accounts.unshift({ id: local.accountId });
  }
  const entries = await Promise.all(
    accounts.map(
      async (account) =>
        [
          account.id,
          await collectOne(
            env,
            account,
            local?.accountId === account.id ? local.accessToken : null,
            previous[account.id],
          ),
        ] as const,
    ),
  );
  return Object.fromEntries(entries);
}

/** 校验并保存某个账号的 API Key：必须能查到用量才保存 */
export async function setApiKey(
  env: Env,
  accountId: string,
  apiKey: string,
): Promise<string> {
  const key = apiKey.trim();
  if (!key.startsWith("fk-")) {
    throw new SwitchError("API Key 应该以 fk- 开头");
  }
  try {
    await fetchUsage(env, key);
  } catch (cause) {
    throw new SwitchError(`这个 Key 查不到用量：${(cause as Error).message}`);
  }
  await writeApiKey(env, accountId, key);
  return "API Key 已保存";
}

/** 一条要弹的系统通知 */
export interface UsageAlert {
  accountId: string;
  title: string;
  body: string;
}

/** 取 5 小时周期的使用率；周期已过期按 0% 算 */
export function fiveHourPercent(snapshot: UsageSnapshot, now: number): number {
  const window = snapshot.standard.fiveHour;
  if (window.windowEnd !== null && window.windowEnd <= now) {
    return 0;
  }
  return window.usedPercent;
}

/**
 * 对比前后两次用量，找出需要通知的变化：
 * 当前账号 5 小时用量涨过 70% 提醒换号；其他账号回落到 70% 以下提醒可以切过去。
 * 第一次看到某个账号（没有上一次数据）时不通知，避免一打开程序就弹一堆。
 */
export function detectUsageAlerts(
  previous: UsageMap,
  next: UsageMap,
  currentAccountId: string | null,
  accounts: SavedAccount[],
  now: number,
): UsageAlert[] {
  const alerts: UsageAlert[] = [];
  const labelOf = (id: string) =>
    accounts.find((account) => account.id === id)?.label ?? "当前账号";

  for (const [accountId, entry] of Object.entries(next)) {
    const before = previous[accountId]?.snapshot;
    const after = entry.snapshot;
    // 这一轮没查到新数据（沿用旧快照）就不算变化
    if (!before || !after || entry.error || after === before) {
      continue;
    }
    const was = fiveHourPercent(before, before.fetchedAt);
    const is = fiveHourPercent(after, now);
    const label = labelOf(accountId);

    if (
      accountId === currentAccountId &&
      was < HIGH_USAGE_PERCENT &&
      is >= HIGH_USAGE_PERCENT
    ) {
      alerts.push({
        accountId,
        title: `「${label}」5 小时用量已到 ${Math.ceil(is)}%`,
        body: "可以考虑切换到其他账号",
      });
    }
    if (
      accountId !== currentAccountId &&
      was >= HIGH_USAGE_PERCENT &&
      is < HIGH_USAGE_PERCENT
    ) {
      alerts.push({
        accountId,
        title: `「${label}」5 小时用量回落到 ${Math.ceil(is)}%`,
        body: "这个账号又可以用了，点击查看",
      });
    }
  }
  return alerts;
}
