// Cursor 的 token 统计：本机没有日志，用 Cursor CLI 的登录向 cursor.com 拉账号的计费明细，
// 按账号缓存到磁盘，之后只增量拉取。1 分钟内不重复拉，拉取在后台进行时先返回缓存。
// 移植自 T3 Code（MIT）packages/provider-cursor/src/server/CursorUsageAccounts.ts。
import fs from "node:fs/promises";
import path from "node:path";

import { writeFileAtomic } from "../../../fs-utils";
import { readKeychainToken } from "../../../usage-limits/cursor";
import type { ProviderUsageReader, ProviderUsageScan, UsageReaderEnv } from "../../types";
import {
  CURSOR_ACCOUNT_CACHE_FILE_NAME,
  CURSOR_ACCOUNT_TTL_MS,
  cursorFetchRange,
  decodeCursorAccountCaches,
  encodeCursorAccountCaches,
  isCursorCacheFresh,
  mergeCursorFetch,
  type CursorAccountCache,
  type CursorCredentialSource,
} from "./account-cache";
import { readCursorAccountUsage } from "./account-usage";

const CURSOR_ACCOUNT_READ_ERROR = "Cursor 账号用量读取失败。";

export function createCursorUsageReader(now: () => number = () => Date.now()) {
  const caches = new Map<string, CursorAccountCache>();
  let loadedFrom: string | null = null;
  let cacheDirty = false;
  /** 失败也按缓存时长节流，避免反复请求；error 为 null 表示没登录 */
  const failures = new Map<string, { readonly atMs: number; readonly error: string | null }>();
  const refreshes = new Map<string, Promise<void>>();
  let persistTail: Promise<unknown> = Promise.resolve();
  const pendingPersists = new Set<Promise<unknown>>();

  const ensureLoaded = async (stateDir: string) => {
    if (loadedFrom === stateDir) return;
    loadedFrom = stateDir;
    try {
      const document: unknown = JSON.parse(
        await fs.readFile(path.join(stateDir, CURSOR_ACCOUNT_CACHE_FILE_NAME), "utf8"),
      );
      for (const [key, cache] of decodeCursorAccountCaches(document)) caches.set(key, cache);
    } catch {
      // 没有缓存或已损坏就从头拉
    }
  };

  // 写缓存串行；编码前清掉 dirty，失败时恢复以便下次重试
  const schedulePersist = (stateDir: string) => {
    const run = persistTail.then(async () => {
      if (!cacheDirty) return;
      cacheDirty = false;
      try {
        await writeFileAtomic(
          path.join(stateDir, CURSOR_ACCOUNT_CACHE_FILE_NAME),
          encodeCursorAccountCaches(caches),
        );
      } catch {
        cacheDirty = true;
      }
    });
    persistTail = run.catch(() => undefined);
    pendingPersists.add(run);
    void run.finally(() => pendingPersists.delete(run));
  };

  const refreshAccount = async (
    env: UsageReaderEnv,
    stateDir: string,
    credential: CursorCredentialSource,
    credentialKey: string,
    retentionStartMs: number,
  ) => {
    const nowMs = now();
    const read = (sinceMs: number, untilMs: number) =>
      readCursorAccountUsage(credential, sinceMs, untilMs, {
        httpFetch: env.httpFetch ?? fetch,
        keychainToken: env.readCursorKeychain ?? readKeychainToken,
      });
    const fetchMissing = async (cache: CursorAccountCache | undefined) => {
      const range = cursorFetchRange(cache, retentionStartMs, nowMs);
      return { range, result: await read(range.sinceMs, range.untilMs) };
    };
    let base = caches.get(credentialKey);
    let fetched = await fetchMissing(base);
    // 换了账号就丢掉旧账号的缓存，从头拉
    if (
      base !== undefined &&
      fetched.result.accountKey !== null &&
      fetched.result.accountKey !== base.accountKey
    ) {
      caches.delete(credentialKey);
      cacheDirty = true;
      base = undefined;
      fetched = await fetchMissing(base);
    }
    const { range, result } = fetched;
    if (result.missing || result.error !== null || result.accountKey === null) {
      failures.set(credentialKey, {
        atMs: nowMs,
        error: result.missing || result.error !== null ? result.error : CURSOR_ACCOUNT_READ_ERROR,
      });
      schedulePersist(stateDir);
      return;
    }
    const merged = mergeCursorFetch(
      base,
      result.accountKey,
      range,
      result.records,
      nowMs,
      retentionStartMs,
    );
    caches.set(credentialKey, merged.cache);
    failures.delete(credentialKey);
    if (merged.changed) cacheDirty = true;
    schedulePersist(stateDir);
  };

  /** 同一凭证同时只拉一次；拉取在后台进行，调用方离开也不取消 */
  const startRefresh = (
    env: UsageReaderEnv,
    stateDir: string,
    credential: CursorCredentialSource,
    credentialKey: string,
    retentionStartMs: number,
  ) => {
    const current = refreshes.get(credentialKey);
    if (current !== undefined) return current;
    const done = refreshAccount(env, stateDir, credential, credentialKey, retentionStartMs)
      .catch(() => {
        failures.set(credentialKey, { atMs: now(), error: CURSOR_ACCOUNT_READ_ERROR });
      })
      .finally(() => refreshes.delete(credentialKey));
    refreshes.set(credentialKey, done);
    return done;
  };

  const accountSource = async (
    env: UsageReaderEnv,
    stateDir: string,
    credential: CursorCredentialSource,
    authPath: string,
    windowStartMs: number,
    retentionStartMs: number,
    awaitRefresh: boolean,
  ): Promise<ProviderUsageScan | null> => {
    if (
      typeof credential === "string" &&
      !(await fs.stat(credential).then(
        () => true,
        (error: NodeJS.ErrnoException) => error.code !== "ENOENT",
      ))
    ) {
      return null;
    }
    await ensureLoaded(stateDir);
    const credentialKey = typeof credential === "string" ? credential : "keychain";
    const nowMs = now();
    const recentFailure = failures.get(credentialKey);
    let refreshing = false;
    if (
      (recentFailure === undefined || nowMs - recentFailure.atMs >= CURSOR_ACCOUNT_TTL_MS) &&
      !isCursorCacheFresh(caches.get(credentialKey), nowMs)
    ) {
      const refresh = startRefresh(env, stateDir, credential, credentialKey, retentionStartMs);
      if (awaitRefresh) await refresh;
      else refreshing = true;
    }

    const cache = caches.get(credentialKey);
    const failure = refreshing ? undefined : failures.get(credentialKey);
    const failureMessage = failure === undefined ? undefined : failure.error;
    if (failureMessage === null) return null;
    if (cache === undefined) {
      return {
        dir: authPath,
        // 不能把本机兜底数据和账号级历史混在一起
        ...(refreshing
          ? { files: [], refreshing: true }
          : { files: null, message: failureMessage ?? CURSOR_ACCOUNT_READ_ERROR }),
      };
    }
    // 账号历史跨机器；固定的指纹避免重复计算
    const source = `cursor-account:${cache.accountKey}`;
    return {
      dir: source,
      hostId: "cursor.com",
      volumeId: cache.accountKey,
      files: [
        {
          path: source,
          records: cache.records.filter((record) => record.timestampMs >= windowStartMs),
        },
      ],
      ...(failureMessage === undefined
        ? { status: "ok" as const }
        : { status: "partial" as const, message: failureMessage }),
      ...(refreshing ? { refreshing: true as const } : {}),
    };
  };

  const reader: ProviderUsageReader = {
    kind: "scan",
    provider: "cursor",
    scan: async (env, { windowStartMs, retentionCutoffMs, awaitRefresh }) => {
      const environment = env.environment;
      const userHome = environment["HOME"] || env.homeDir;
      const authPath = path.join(userHome, ".cursor", "auth.json");
      const credentialStore = environment["AGENT_CLI_CREDENTIAL_STORE"];
      const loginUnavailable =
        Boolean(environment["CURSOR_AUTH_TOKEN"]?.trim()) ||
        Boolean(environment["CURSOR_API_KEY"]?.trim()) ||
        credentialStore === "memory";
      const useKeychain = credentialStore !== "file";
      const keychainEnabled = (await env.cursorKeychainUsageEnabled?.()) ?? false;
      if (useKeychain && !loginUnavailable && !keychainEnabled) {
        return [
          {
            dir: authPath,
            volumeId: "",
            files: null,
            message: "还没开启 Cursor 账号用量。",
            action: "enableCursorKeychain",
          },
        ];
      }
      if (loginUnavailable) {
        return [
          {
            dir: authPath,
            files: null,
            message: "统计 Cursor 账号历史需要本机的 Cursor CLI 登录。",
          },
        ];
      }
      if (env.stateDir === undefined) return [];
      const source = await accountSource(
        env,
        env.stateDir,
        useKeychain ? { kind: "keychain" } : authPath,
        authPath,
        windowStartMs,
        retentionCutoffMs,
        awaitRefresh,
      );
      return source === null ? [] : [source];
    },
  };

  return {
    reader,
    /** 等后台写缓存完成，测试用 */
    awaitPersisted: async () => {
      await Promise.all([...refreshes.values()]);
      await Promise.all([...pendingPersists]);
    },
  };
}

export const cursorUsage = createCursorUsageReader();
export const cursorUsageReader = cursorUsage.reader;
