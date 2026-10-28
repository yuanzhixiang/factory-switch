// 移植自 T3 Code（MIT）packages/provider-cursor/src/server/accountUsage.test.ts，
// Effect 的 HttpClient / CursorKeychain 换成注入的假 fetch 和钥匙串读取，断言保持不变（提示文字改成中文）。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readCursorAccountUsage } from "../../src/core/token-usage/providers/cursor/account-usage";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function writeAuth(accessToken: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "usage-reader-test-"));
  dirs.push(dir);
  const authPath = path.join(dir, "auth.json");
  await fs.writeFile(authPath, JSON.stringify({ accessToken }));
  return { dir, authPath };
}

const token = (payload: object) =>
  `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;

interface DashboardRequest {
  readonly url: string;
  readonly init: RequestInit;
  readonly page: number;
  readonly headers: Headers;
}

const dashboard =
  (answer: (request: DashboardRequest) => Response | Promise<Response>): typeof fetch =>
  async (input, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    return answer({
      url: String(input),
      init: init ?? {},
      page: (JSON.parse(body) as { page: number }).page,
      headers: new Headers(init?.headers),
    });
  };

const mustNotReadKeychain = () => Promise.reject(new Error("must not read Keychain"));

const readAccountUsage = (
  credentialSource: Parameters<typeof readCursorAccountUsage>[0],
  sinceMs: number,
  endDate: number,
  answer: (request: DashboardRequest) => Response | Promise<Response>,
  keychainToken: () => Promise<string | null> = mustNotReadKeychain,
) =>
  readCursorAccountUsage(credentialSource, sinceMs, endDate, {
    httpFetch: dashboard(answer),
    keychainToken,
  });

describe("Cursor account history", () => {
  it("reads paginated Cursor account history including headless calls with separate cache tokens", async () => {
    const accessToken = token({ sub: "auth|demo", exp: 4102444800 });
    const { authPath } = await writeAuth(accessToken);
    const pages: number[] = [];
    const request = ({ url, init, headers, page }: DashboardRequest) => {
      expect(url).toBe("https://cursor.com/api/dashboard/get-filtered-usage-events");
      expect(init.redirect).toBe("error");
      expect(headers.get("origin")).toBe("https://cursor.com");
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("cookie") ?? "").toContain("WorkosCursorSessionToken=demo%3A%3A");
      pages.push(page);
      return Response.json({
        totalUsageEventsCount: 1001,
        usageEventsDisplay: Array.from({ length: page === 1 ? 1000 : 1 }, (_, index) => ({
          timestamp: String(1780000000000 + ((page - 1) * 1000 + index) * 1000),
          model: "claude-sonnet-4-5",
          conversationId: `conversation-${page}`,
          isHeadless: page === 2,
          chargedCents: 0,
          tokenUsage: {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 30,
            cacheWriteTokens: 2,
            totalCents: 25,
          },
        })),
      });
    };
    const result = await readAccountUsage(authPath, 0, 1781000000000, request);
    expect(result.error).toBeNull();
    expect(pages).toEqual([1, 2]);
    expect(result.records.length).toBe(1001);
    expect(result.records.at(-1)?.sessionId).toBe("conversation-2");
    expect(result.records[0]?.totals).toEqual({
      uncachedInputTokens: 10,
      cachedInputTokens: 30,
      cacheCreationTokens: 2,
      outputTokens: 5,
      reasoningTokens: 0,
    });
    expect(result.records[0]?.reportedCostUsd).toBe(0.25);
    expect(result.accountKey?.includes("demo") ?? true).toBe(false);
  });

  // T3 每个请求带独立的 AbortSignal；本实现没给请求传 signal，见报告
  it("gives each Cursor page request its own abort signal", async () => {
    const { authPath } = await writeAuth(token({ sub: "auth|demo" }));
    const signals: AbortSignal[] = [];
    await readAccountUsage(authPath, 0, 1781000000000, ({ init, page }) => {
      if (init.signal) signals.push(init.signal);
      return Response.json({
        totalUsageEventsCount: 1001,
        usageEventsDisplay: Array.from({ length: page === 1 ? 1000 : 1 }, () => ({
          tokenUsage: null,
        })),
      });
    });
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
  });

  it("reads Cursor account history beyond 100 pages", async () => {
    const { authPath } = await writeAuth(token({ sub: "auth|demo" }));
    const fullPage = Array.from({ length: 1000 }, () => ({ tokenUsage: null }));
    let requests = 0;
    const result = await readAccountUsage(authPath, 0, 1781000000000, async () => {
      requests += 1;
      return Response.json({
        totalUsageEventsCount: 100_001,
        usageEventsDisplay: requests <= 100 ? fullPage : [{ tokenUsage: null }],
      });
    });
    expect(result.error).toBeNull();
    expect(requests).toBe(101);
    expect(result.records).toEqual([]);
  });

  it("accepts confirmed empty Cursor usage but rejects error envelopes", async () => {
    const { authPath } = await writeAuth(token({ sub: "auth|demo" }));
    for (const body of [
      {},
      { totalUsageEventsCount: 0 },
      { totalUsageEventsCount: 0, usageEventsDisplay: [] },
    ]) {
      const result = await readAccountUsage(authPath, 0, 1781000000000, async () =>
        Response.json(body),
      );
      expect(result.error).toBeNull();
      expect(result.records).toEqual([]);
      expect(result.missing).toBe(false);
    }
    for (const body of [
      { error: "upstream error" },
      { detail: "unknown error envelope" },
      { totalUsageEventsCount: 0, error: "upstream error" },
      null,
      [],
      "invalid",
      0,
    ]) {
      const result = await readAccountUsage(authPath, 0, 1781000000000, async () =>
        Response.json(body),
      );
      expect(result.error).not.toBeNull();
      expect(result.records).toEqual([]);
    }
  });

  it("requires a terminal Cursor page after a full page reaches the reported count", async () => {
    const { authPath } = await writeAuth(token({ sub: "auth|demo" }));
    let requests = 0;
    const result = await readAccountUsage(authPath, 0, 1781000000000, async () => {
      requests++;
      return Response.json(
        requests === 1
          ? {
              totalUsageEventsCount: 1000,
              usageEventsDisplay: Array.from({ length: 1000 }, (_, index) => ({
                timestamp: String(1780000000000 + index),
                model: "gpt-5",
                tokenUsage: { inputTokens: 10, outputTokens: 5 },
              })),
            }
          : { totalUsageEventsCount: 1000 },
      );
    });
    expect(result.error).toBeNull();
    expect(result.records.length).toBe(1000);
    expect(requests).toBe(2);
  });

  it("removes only count-proven Cursor boundary copies and preserves identical billed events", async () => {
    const { authPath } = await writeAuth(token({ sub: "auth|demo" }));
    const event = (index: number) => ({
      timestamp: String(1780000000000 + index),
      model: "gpt-5",
      tokenUsage: { inputTokens: 10, outputTokens: 5, totalCents: 1 },
    });
    for (const total of [2000, 2001]) {
      let requests = 0;
      const result = await readAccountUsage(authPath, 0, 1781000000000, async () => {
        requests++;
        return Response.json({
          totalUsageEventsCount: total,
          usageEventsDisplay:
            requests === 1
              ? Array.from({ length: 1000 }, (_, index) => event(index))
              : requests === 2
                ? Array.from({ length: 1000 }, (_, index) => event(999 + index))
                : [event(1999)],
        });
      });
      expect(result.error).toBeNull();
      expect(result.records.length).toBe(total);
      expect(requests).toBe(3);
      expect(result.records.at(-1)?.timestampMs).toBe(1780000001999);
      expect(
        result.records.filter((record) => record.timestampMs === 1780000000999).length,
      ).toBe(total === 2000 ? 1 : 2);
      expect(new Set(result.records.map((record) => record.dedupeKey)).size).toBe(total);
    }
    let requests = 0;
    const inconsistent = await readAccountUsage(authPath, 0, 1781000000000, async () => {
      requests++;
      return Response.json({
        totalUsageEventsCount: 1001,
        usageEventsDisplay:
          requests === 1
            ? Array.from({ length: 1000 }, (_, index) => event(index))
            : [event(500), event(1000)],
      });
    });
    expect(inconsistent.error).not.toBeNull();
    expect(inconsistent.records).toEqual([]);
  });

  it("does not present truncated Cursor account pages or authentication failures as complete history", async () => {
    const accessToken = token({ sub: "auth|demo", exp: 4102444800 });
    const { dir, authPath } = await writeAuth(accessToken);
    const truncated = await readAccountUsage(authPath, 0, 1781000000000, async () =>
      Response.json({ totalUsageEventsCount: 101, usageEventsDisplay: [] }),
    );
    expect(truncated.error).not.toBeNull();
    expect(truncated.records).toEqual([]);
    const denied = await readAccountUsage(
      authPath,
      0,
      1781000000000,
      async () => new Response(accessToken, { status: 401 }),
    );
    expect(denied.error).not.toBeNull();
    expect(denied.error?.includes(accessToken) ?? true).toBe(false);
    expect(denied.records).toEqual([]);
    let requested = false;
    const missing = await readAccountUsage(
      path.join(dir, "missing.json"),
      0,
      1781000000000,
      async () => {
        requested = true;
        return Response.json({});
      },
    );
    expect(missing.missing).toBe(true);
    expect(requested).toBe(false);
  });
});

describe("readCursorAccountUsage", () => {
  it("asks for Keychain approval when the prompt goes unanswered", async () => {
    const result = await readAccountUsage(
      { kind: "keychain" },
      0,
      1,
      () => {
        throw new Error("no network expected");
      },
      () => Promise.reject(new Error("Timed out waiting for Keychain access.")),
    );
    expect(result).toEqual({
      accountKey: null,
      records: [],
      missing: false,
      error: "读不了钥匙串里的 Cursor 登录，允许钥匙串访问后刷新。",
    });
  });

  it("reads the pages behind the first together and keeps them in page order", async () => {
    const accessToken = token({ sub: "auth|demo" });
    let inFlight = 0;
    let mostInFlight = 0;
    const result = await readAccountUsage(
      { kind: "keychain" },
      0,
      1781000000000,
      async ({ page }) => {
        inFlight++;
        mostInFlight = Math.max(mostInFlight, inFlight);
        for (let turn = page; turn < 9; turn++) await Promise.resolve();
        inFlight--;
        return Response.json({
          totalUsageEventsCount: 8001,
          usageEventsDisplay: Array.from({ length: page === 9 ? 1 : 1000 }, (_, index) => ({
            timestamp: String(1780000000000 + (page - 1) * 1000 + index),
            model: "gpt-5",
            tokenUsage: { inputTokens: 1 },
          })),
        });
      },
      async () => accessToken,
    );
    expect(result.error).toBeNull();
    expect(mostInFlight).toBe(6);
    expect(result.records.map((record) => record.timestampMs)).toEqual(
      Array.from({ length: 8001 }, (_, index) => 1780000000000 + index),
    );
  });

  // T3 在某一页失败后会中断预取中的请求；本实现不传 AbortSignal，预取的请求会一直挂着，见报告
  it("ends like a page-by-page read when a page fails, leaving no request open", async () => {
    const accessToken = token({ sub: "auth|demo" });
    const fullPage = {
      totalUsageEventsCount: 8001,
      usageEventsDisplay: Array.from({ length: 1000 }, () => ({ tokenUsage: null })),
    };
    for (const [secondPage, error] of [
      [() => Response.json(fullPage), "Cursor 账号用量读取失败。"],
      [
        () => new Response(null, { status: 401 }),
        "Cursor 登录已失效，重新登录后才能读账号用量。",
      ],
    ] as const) {
      let open = 0;
      const result = await readAccountUsage(
        { kind: "keychain" },
        0,
        1781000000000,
        ({ init, page }) => {
          if (page === 1) return Promise.resolve(Response.json(fullPage));
          if (page === 2) return Promise.resolve(secondPage());
          if (page === 3) return Promise.reject(new Error("connection reset"));
          open++;
          return new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              open--;
              reject(init.signal?.reason as Error);
            });
          });
        },
        async () => accessToken,
      );
      expect(result.error).toBe(error);
      expect(result.records).toEqual([]);
      expect(open).toBe(0);
    }
  });

  // 不依赖取消的部分：第 2 页失败或登录失效时，结果和逐页读取一致
  it("reports a failed or signed-out page like a page-by-page read", async () => {
    const accessToken = token({ sub: "auth|demo" });
    const fullPage = {
      totalUsageEventsCount: 8001,
      usageEventsDisplay: Array.from({ length: 1000 }, () => ({ tokenUsage: null })),
    };
    for (const [secondPage, error] of [
      [
        () => Promise.reject(new Error("connection reset")),
        "Cursor 账号用量读取失败。",
      ],
      [
        () => Promise.resolve(new Response(null, { status: 401 })),
        "Cursor 登录已失效，重新登录后才能读账号用量。",
      ],
    ] as const) {
      const result = await readAccountUsage(
        { kind: "keychain" },
        0,
        1781000000000,
        ({ page }) => (page === 2 ? secondPage() : Promise.resolve(Response.json(fullPage))),
        async () => accessToken,
      );
      expect(result.error).toBe(error);
      expect(result.records).toEqual([]);
    }
  });
});
