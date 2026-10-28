// 读 Cursor 账号的计费用量明细（cursor.com 后台的 get-filtered-usage-events），
// 移植自 T3 Code（MIT）packages/provider-cursor/src/server/accountUsage.ts，Effect 改成普通 async。
import { createHash } from "node:crypto";
import fs from "node:fs/promises";

import type { UsageRecord } from "../../types";
import { cursorRateModel } from "../cursor-rate-model";
import type { CursorCredentialSource } from "./account-cache";

export interface CursorAccountUsageReadResult {
  readonly accountKey: string | null;
  readonly records: readonly UsageRecord[];
  readonly missing: boolean;
  readonly error: string | null;
}

class CursorAccountUsageInvalidError extends Error {}

function invalid(reason: string): never {
  throw new CursorAccountUsageInvalidError(reason);
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function tokens(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

const pageRequestBody = (page: number, pageSize: number, sinceMs: number, endDate: number) =>
  JSON.stringify({ page, pageSize, startDate: String(sinceMs), endDate: String(endDate) });

const billedEventIdentity = (...fields: readonly unknown[]) => JSON.stringify(fields);

const accountHash = (value: string) => createHash("sha256").update(value).digest("hex");

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** 上一页末尾和这一页开头重复的条数（KMP 前缀函数） */
export function boundaryOverlap(previous: readonly string[], current: readonly string[]): number {
  const sequence = [...current, "", ...previous];
  const lengths = Array.from({ length: sequence.length }, () => 0);
  for (let index = 1; index < sequence.length; index++) {
    let length = lengths[index - 1]!;
    while (length > 0 && sequence[index] !== sequence[length]) length = lengths[length - 1]!;
    if (sequence[index] === sequence[length]) length++;
    lengths[index] = length;
  }
  return lengths.at(-1) ?? 0;
}

const DASHBOARD_USAGE_URL = "https://cursor.com/api/dashboard/get-filtered-usage-events";
const PAGE_TIMEOUT_MS = 10_000;
const READ_TIMEOUT_MS = 60_000;

/** 超时后让读取失败 */
function withTimeout<T>(promise: Promise<T>, ms: number, reason: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new CursorAccountUsageInvalidError(reason)), ms);
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

export async function readCursorAccountUsage(
  credentialSource: CursorCredentialSource,
  sinceMs: number,
  endDate: number,
  options: {
    readonly httpFetch: typeof fetch;
    readonly keychainToken: () => Promise<string | null>;
  },
): Promise<CursorAccountUsageReadResult> {
  let accessToken: unknown;
  try {
    accessToken =
      typeof credentialSource === "string"
        ? object(JSON.parse(await fs.readFile(credentialSource, "utf8")))["accessToken"]
        : await options.keychainToken();
  } catch (cause) {
    const missing =
      typeof credentialSource === "string" &&
      (cause as NodeJS.ErrnoException).code === "ENOENT";
    return {
      accountKey: null,
      records: [],
      missing,
      error: missing
        ? null
        : typeof credentialSource === "string"
          ? "读不了 Cursor 登录凭证。"
          : "读不了钥匙串里的 Cursor 登录，允许钥匙串访问后刷新。",
    };
  }
  if (typeof accessToken !== "string" || !accessToken) {
    return {
      accountKey: null,
      records: [],
      missing: true,
      error:
        typeof credentialSource === "string" ? null : "统计 Cursor 账号历史需要先在本机登录 Cursor CLI。",
    };
  }
  let accountKey: string | null = null;
  // 读取结束（成功、失败或整体超时）时中断所有还在进行的预取请求
  const controller = new AbortController();
  const read = async (): Promise<CursorAccountUsageReadResult> => {
    let subject: unknown;
    try {
      const payload = Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString("utf8");
      subject = object(JSON.parse(payload))["sub"];
    } catch {
      invalid("Invalid authentication");
    }
    if (typeof subject !== "string" || !subject) invalid("Invalid authentication");
    const userId = subject.split("|").at(-1);
    if (!userId) invalid("Invalid authentication");
    accountKey = accountHash(subject);
    if (!Number.isFinite(sinceMs) || !Number.isFinite(endDate) || sinceMs < 0 || sinceMs > endDate)
      invalid("Invalid date window");
    const records: UsageRecord[] = [];
    const occurrences = new Map<string, number>();
    const pages: unknown[][] = [];
    const pageSize = 1000;
    let total: number | undefined;
    const readPage = async (page: number): Promise<unknown[] | null> => {
      // 总数可能包含分页边界的重叠，留出余量协调，不对账号大小设固定上限
      if (page > (total === undefined ? 1000 : Math.ceil(total / pageSize) * 2 + 1)) {
        invalid("Account usage page limit exceeded");
      }
      let response: Response;
      try {
        response = await withTimeout(
          options.httpFetch(DASHBOARD_USAGE_URL, {
            method: "POST",
            // 每页独立的信号：单页 10 秒超时，读取结束时一起中断
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(PAGE_TIMEOUT_MS)]),
            // 会话 cookie 绝不能跟着重定向离开 cursor.com
            redirect: "error",
            headers: {
              Origin: "https://cursor.com",
              Cookie: `WorkosCursorSessionToken=${encodeURIComponent(`${userId}::${accessToken}`)}`,
              "content-type": "application/json",
            },
            body: pageRequestBody(page, pageSize, sinceMs, endDate),
          }),
          PAGE_TIMEOUT_MS,
          "Account usage request timed out",
        );
      } catch {
        invalid("Account usage request failed");
      }
      // 登录失效时返回 null，由调用方报告需要重新登录
      if (response.status === 401 || response.status === 403) return null;
      if (response.status < 200 || response.status >= 300) invalid("Account usage request failed");
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        invalid("Invalid account usage page");
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        invalid("Invalid account usage page");
      }
      const body = object(parsed);
      const keys = Object.keys(body);
      if ("error" in body || "message" in body || "code" in body)
        invalid("Account usage error response");
      const count = keys.length === 0 ? 0 : body["totalUsageEventsCount"];
      const events =
        keys.length === 0 || (keys.length === 1 && keys[0] === "totalUsageEventsCount")
          ? []
          : body["usageEventsDisplay"];
      if (
        (count !== undefined &&
          (typeof count !== "number" ||
            !Number.isSafeInteger(count) ||
            count < 0 ||
            (total !== undefined && count !== total))) ||
        !Array.isArray(events) ||
        events.length > pageSize ||
        (count === undefined && !Array.isArray(body["usageEventsDisplay"]))
      ) {
        invalid("Inconsistent account usage page");
      }
      if (typeof count === "number") total = count;
      return events as unknown[];
    };
    // Cursor 每页最多 1000 条、约一秒返回一页；按第一页的总数提前最多 6 页并发请求，按页序消费
    const ahead: Promise<unknown[] | null>[] = [];
    for (let page = 1; ; page++) {
      while (ahead.length < Math.min(6, Math.ceil((total ?? 0) / pageSize) - page + 1)) {
        const pending = readPage(page + ahead.length);
        // 先挂上处理，避免排队中的失败变成未处理的拒绝
        pending.catch(() => undefined);
        ahead.push(pending);
      }
      const next = ahead.shift();
      const events = await (next ?? readPage(page));
      if (events === null) {
        return {
          accountKey,
          records: [],
          missing: false,
          error: "Cursor 登录已失效，重新登录后才能读账号用量。",
        };
      }
      pages.push(events);
      // 不满一页说明到底了；页数超限由 readPage 报错
      if (events.length < pageSize) break;
    }
    const rawCount = pages.reduce((sum, page) => sum + page.length, 0);
    if (total !== undefined && rawCount < total) invalid("Incomplete account usage pages");
    let removalsRemaining = total === undefined ? 0 : rawCount - total;
    let previousKeys: string[] = [];
    for (const events of pages) {
      const eventKeys =
        removalsRemaining > 0 ? events.map((event) => accountHash(canonicalJson(event))) : [];
      const removalCount = Math.min(removalsRemaining, boundaryOverlap(previousKeys, eventKeys));
      removalsRemaining -= removalCount;
      previousKeys = eventKeys;
      for (const raw of events.slice(removalCount)) {
        const event = object(raw);
        const usage = object(event["tokenUsage"]);
        if (event["tokenUsage"] === undefined || event["tokenUsage"] === null) continue;
        for (const key of [
          "inputTokens",
          "outputTokens",
          "cacheReadTokens",
          "cacheWriteTokens",
          "totalCents",
        ]) {
          const value = usage[key];
          if (
            value !== undefined &&
            (typeof value !== "number" || !Number.isFinite(value) || value < 0)
          ) {
            invalid("Invalid account usage totals");
          }
        }
        const rawTimestamp = event["timestamp"];
        const timestampMs =
          typeof rawTimestamp === "string" && rawTimestamp.trim() !== ""
            ? Number(rawTimestamp)
            : rawTimestamp;
        const model = event["model"];
        if (
          typeof timestampMs !== "number" ||
          !Number.isFinite(timestampMs) ||
          typeof model !== "string" ||
          !model
        )
          invalid("Invalid account usage event");
        if (timestampMs < sinceMs || timestampMs > endDate) continue;
        const totals = {
          uncachedInputTokens: tokens(usage["inputTokens"]),
          cachedInputTokens: tokens(usage["cacheReadTokens"]),
          cacheCreationTokens: tokens(usage["cacheWriteTokens"]),
          outputTokens: tokens(usage["outputTokens"]),
          reasoningTokens: 0,
        };
        const totalCents = usage["totalCents"];
        const reportedCostUsd = typeof totalCents === "number" ? totalCents / 100 : null;
        const sessionId =
          typeof event["conversationId"] === "string" ? event["conversationId"] : "";
        // 事件没有 ID；完全相同的计费行用出现序号区分，都保留
        const key = accountHash(
          billedEventIdentity(timestampMs, model, sessionId, totals, reportedCostUsd),
        );
        const occurrence = occurrences.get(key) ?? 0;
        occurrences.set(key, occurrence + 1);
        records.push({
          provider: "cursor",
          timestampMs,
          model,
          rateModel: cursorRateModel(model),
          sessionId,
          totals,
          reportedCostUsd,
          speed: "standard",
          dedupeKey: `cursor-account:${accountKey}:${key}:${occurrence}`,
        });
      }
    }
    if (removalsRemaining !== 0) invalid("Inconsistent account usage boundaries");
    return { accountKey, records, missing: false, error: null };
  };
  try {
    return await withTimeout(read(), READ_TIMEOUT_MS, "Account usage read timed out").finally(() =>
      controller.abort(),
    );
  } catch {
    return {
      accountKey,
      records: [],
      missing: false,
      error: "Cursor 账号用量读取失败。",
    };
  }
}
