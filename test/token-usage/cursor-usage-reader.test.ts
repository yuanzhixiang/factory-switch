// 对应 T3 Code（MIT）packages/provider-cursor/src/server/CursorUsageAccounts.ts 的行为：
// T3 在 UsageService.test.ts 里覆盖，这里直接测 createCursorUsageReader 的 scan。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createCursorUsageReader } from "../../src/core/token-usage/providers/cursor";
import type { ProviderUsageScanInput, UsageReaderEnv } from "../../src/core/token-usage/types";

const NOW = 1781000000000;
const dirs: string[] = [];
const persisted: Array<() => Promise<void>> = [];

// 先等后台写缓存完成再删临时目录
afterEach(async () => {
  await Promise.all(persisted.splice(0).map((wait) => wait()));
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const token = (sub: string) =>
  `header.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.signature`;

const input = (awaitRefresh: boolean): ProviderUsageScanInput => ({
  windowStartMs: NOW - 7 * 24 * 60 * 60 * 1000,
  retentionCutoffMs: NOW - 92 * 24 * 60 * 60 * 1000,
  awaitRefresh,
});

async function setup(options: { enabled: boolean; environment?: NodeJS.ProcessEnv }) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-usage-reader-test-"));
  dirs.push(home);
  let now = NOW;
  let keychainToken = token("auth|user-a");
  const requests: string[] = [];
  const httpFetch: typeof fetch = async (_input, init) => {
    const cookie = new Headers(init?.headers).get("cookie") ?? "";
    const user = decodeURIComponent(cookie.split("=")[1] ?? "").split("::")[0] ?? "";
    requests.push(user);
    return Response.json({
      totalUsageEventsCount: 1,
      usageEventsDisplay: [
        {
          timestamp: String(NOW - 60 * 60 * 1000),
          model: "claude-sonnet-4-5",
          conversationId: `conversation-${user}`,
          tokenUsage: { inputTokens: 10, outputTokens: 5 },
        },
      ],
    });
  };
  const usage = createCursorUsageReader(() => now);
  persisted.push(usage.awaitPersisted);
  const env: UsageReaderEnv = {
    homeDir: home,
    environment: { HOME: home, ...options.environment },
    stateDir: path.join(home, "state"),
    httpFetch,
    readCursorKeychain: async () => keychainToken,
    cursorKeychainUsageEnabled: async () => options.enabled,
  };
  const reader = usage.reader;
  if (reader.kind !== "scan") throw new Error("Expected a Cursor scan reader");
  return {
    home,
    requests,
    scan: (awaitRefresh: boolean) => reader.scan(env, input(awaitRefresh)),
    awaitPersisted: usage.awaitPersisted,
    advance: (ms: number) => {
      now += ms;
    },
    switchAccount: (sub: string) => {
      keychainToken = token(sub);
    },
  };
}

describe("Cursor 账号用量读取器", () => {
  it("没开启钥匙串读取时提示开启，不读钥匙串也不发请求", async () => {
    const test = await setup({ enabled: false });
    expect(await test.scan(true)).toEqual([
      {
        dir: path.join(test.home, ".cursor", "auth.json"),
        volumeId: "",
        files: null,
        message: "还没开启 Cursor 账号用量。",
        action: "enableCursorKeychain",
      },
    ]);
    expect(test.requests).toEqual([]);
  });

  it("有 CURSOR_API_KEY 时提示需要 CLI 登录", async () => {
    const test = await setup({ enabled: true, environment: { CURSOR_API_KEY: "key" } });
    const [source] = await test.scan(true);
    expect(source?.files).toBeNull();
    expect(source?.message).toBe("统计 Cursor 账号历史需要本机的 Cursor CLI 登录。");
    expect(source?.action).toBeUndefined();
    expect(test.requests).toEqual([]);
  });

  it("第一次在后台拉取并返回 refreshing，拉完后返回 cursor.com 的账号来源", async () => {
    const test = await setup({ enabled: true });
    const [pending] = await test.scan(false);
    expect(pending).toMatchObject({ files: [], refreshing: true });
    await test.awaitPersisted();
    const [source] = await test.scan(false);
    expect(source?.hostId).toBe("cursor.com");
    expect(source?.dir).toBe(`cursor-account:${source?.volumeId}`);
    expect(source?.refreshing).toBeUndefined();
    expect(source?.files?.[0]?.records.map((record) => record.sessionId)).toEqual([
      "conversation-user-a",
    ]);
    // 缓存写到磁盘，换一个读取器实例也能读到
    expect(
      (await fs.readdir(path.join(test.home, "state"))).some((name) => name.includes("cursor")),
    ).toBe(true);
  });

  it("1 分钟内不重复请求，过期后增量再拉", async () => {
    const test = await setup({ enabled: true });
    await test.scan(true);
    expect(test.requests).toEqual(["user-a"]);
    test.advance(30_000);
    await test.scan(true);
    expect(test.requests).toEqual(["user-a"]);
    test.advance(31_000);
    const [source] = await test.scan(true);
    expect(test.requests).toEqual(["user-a", "user-a"]);
    expect(source?.files?.[0]?.records).toHaveLength(1);
  });

  it("换了账号就丢掉旧账号的缓存并从头拉", async () => {
    const test = await setup({ enabled: true });
    const [first] = await test.scan(true);
    test.switchAccount("auth|user-b");
    test.advance(61_000);
    const [second] = await test.scan(true);
    // 先按旧缓存增量拉一次，发现账号变了再完整拉一次
    expect(test.requests).toEqual(["user-a", "user-b", "user-b"]);
    expect(second?.volumeId).not.toBe(first?.volumeId);
    expect(second?.files?.[0]?.records.map((record) => record.sessionId)).toEqual([
      "conversation-user-b",
    ]);
  });
});
