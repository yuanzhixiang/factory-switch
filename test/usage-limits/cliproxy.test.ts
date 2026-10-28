// 移植自 T3 Code（MIT）apps/server/src/usage/cliproxyApi.test.ts，
// Effect 的 HttpClient 换成假的 fetch，断言保持不变（提示文字改成中文）。
import { describe, expect, it } from "vitest";

import { makeCliproxyApi, UsageLimitSourceError } from "../../src/core/usage-limits/cliproxy";

const config = {
  kind: "cliproxy",
  url: "http://hub.test:8317",
  managementKey: "management-secret",
  enabled: true,
} as const;
const accounts = [
  {
    id: "first.json",
    auth_index: "a",
    provider: "codex",
    email: "first@example.com",
    id_token: { chatgpt_account_id: "account-a" },
  },
  {
    id: "second.json",
    auth_index: "b",
    provider: "codex",
    email: "second@example.com",
    id_token: { chatgpt_account_id: "account-b" },
  },
];
const credit = (id: string, expires_at = "2099-01-01T00:00:00Z") => ({
  id,
  expires_at,
  status: "available",
  reset_type: "codex_rate_limits",
});

interface RequestBody {
  readonly auth_index: string;
  readonly method?: string;
  readonly url?: string;
  readonly header?: Record<string, string>;
  readonly data?: string;
}

function fixture(
  options: {
    accounts?: Array<
      (typeof accounts)[number] & {
        disabled?: boolean;
        id_token: { chatgpt_account_id: string; plan_type?: string; chatgpt_plan_type?: string };
      }
    >;
    upstream?: (request: RequestBody) => { status: number; body: unknown };
    cooldownStatus?: number;
    now?: () => Date;
  } = {},
) {
  const requests: Array<{ path: string; body?: RequestBody }> = [];
  const httpFetch: typeof fetch = async (input, init) => {
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer management-secret");
    const path = new URL(String(input)).pathname;
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as RequestBody) : undefined;
    requests.push({ path, ...(body ? { body } : {}) });
    if (path.endsWith("/auth-files")) return Response.json({ files: options.accounts ?? accounts });
    if (path.endsWith("/reset-quota")) {
      return Response.json({}, { status: options.cooldownStatus ?? 200 });
    }
    expect(path).toMatch(/\/v0\/management\/api-call$/);
    expect(body?.header?.Authorization).toBe("Bearer $TOKEN$");
    const upstream = options.upstream?.(body!) ?? {
      status: 200,
      body: body?.url?.endsWith("/consume")
        ? { code: "reset" }
        : body?.url?.endsWith("/rate-limit-reset-credits")
          ? {
              credits: [
                credit("later", "2099-02-01T00:00:00Z"),
                credit("first"),
                credit("expired", "2000-01-01T00:00:00Z"),
                { ...credit("used"), status: "redeemed" },
              ],
            }
          : {
              plan_type: "pro",
              rate_limit: {
                secondary_window: {
                  used_percent: 78,
                  reset_at: 4070908800,
                  limit_window_seconds: 604800,
                },
              },
            },
    };
    return Response.json({ status_code: upstream.status, body: JSON.stringify(upstream.body) });
  };
  return { requests, api: makeCliproxyApi(httpFetch, options.now) };
}

async function failure(promise: Promise<unknown>): Promise<UsageLimitSourceError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(UsageLimitSourceError);
    return error as UsageLimitSourceError;
  }
  throw new Error("expected a failure");
}

describe("CLIProxyAPI hub failures", () => {
  it("names the TLS code when the hub's certificate is not trusted", async () => {
    const api = makeCliproxyApi(async () => {
      // Node 的 fetch 把带错误码的 TLS 错误包在通用 TypeError 里
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("unable to get local issuer certificate"), {
          code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
        }),
      });
    });
    const error = await failure(api.readAccounts(config));
    expect(error.message).toContain("UNABLE_TO_GET_ISSUER_CERT_LOCALLY");
    expect(error.message).toContain("NODE_EXTRA_CA_CERTS");
  });

  it("ignores a transport code that is not a short Node error code", async () => {
    const api = makeCliproxyApi(async () => {
      throw Object.assign(new Error("odd"), { code: "X".repeat(200) });
    });
    const error = await failure(api.readAccounts(config));
    expect(error.message).toBe("中转服务管理接口请求失败。");
  });

  it("names the status, not the body, when the hub rejects the request", async () => {
    const api = makeCliproxyApi(async () =>
      Response.json({ error: "management-secret is wrong" }, { status: 401 }),
    );
    const error = await failure(api.readAccounts(config));
    expect(error.message).toContain("401");
    expect(error.message).not.toContain("management-secret");
  });
});

describe("CLIProxyAPI built-in management API", () => {
  it("reads both accounts and their earliest unexpired credits without plugin endpoints", async () => {
    const test = fixture({ now: () => new Date(1788710400000) });
    const result = await test.api.readAccounts(config);
    expect(result.map((account) => account.usageLimits.resetCredits)).toEqual([
      { availableCount: 2, nextCreditId: "first", nextExpiresAt: "2099-01-01T00:00:00.000Z" },
      { availableCount: 2, nextCreditId: "first", nextExpiresAt: "2099-01-01T00:00:00.000Z" },
    ]);
    expect(result[0]?.usageLimits.windows).toMatchObject([
      { id: "secondary", usedPercent: 78, kind: "weekly" },
    ]);
    const calls = test.requests.filter((request) => request.body?.url);
    expect(calls.map((request) => request.body?.auth_index).sort()).toEqual(["a", "a", "b", "b"]);
    expect(
      calls.find((request) => request.body?.auth_index === "b")?.body?.header?.[
        "Chatgpt-Account-Id"
      ],
    ).toBe("account-b");
  });

  it("resolves a missing usage plan from current, then legacy, token plans", async () => {
    const test = fixture({
      accounts: [
        { ...accounts[0]!, id_token: { chatgpt_account_id: "account-a", plan_type: "free" } },
        {
          ...accounts[1]!,
          id_token: { chatgpt_account_id: "account-b", plan_type: "go", chatgpt_plan_type: "plus" },
        },
        {
          ...accounts[1]!,
          id: "third.json",
          auth_index: "c",
          id_token: { chatgpt_account_id: "account-c", chatgpt_plan_type: "free" },
        },
      ],
      upstream: (request) => ({
        status: 200,
        body: {
          ...(request.auth_index === "a" ? { plan_type: "plus" } : {}),
          rate_limit: { primary_window: { used_percent: 12 } },
        },
      }),
    });
    const result = await test.api.readAccounts(config);
    expect(result.map((account) => [account.plan, account.usageLimits.windows[0]?.kind])).toEqual([
      ["ChatGPT Plus Subscription", "session"],
      ["ChatGPT Go Subscription", "monthly"],
      ["ChatGPT Free Subscription", "monthly"],
    ]);
  });

  it("keeps the path of a hub served under a prefix", async () => {
    const test = fixture();
    await test.api.readAccounts({ ...config, url: "https://tools.test/cliproxy" });
    expect(test.requests.length).toBeGreaterThan(0);
    expect(
      test.requests.every((request) => request.path.startsWith("/cliproxy/v0/management/")),
    ).toBe(true);
  });

  it("keeps usage when the credits endpoint fails", async () => {
    const test = fixture({
      upstream: (request) =>
        request.url?.endsWith("rate-limit-reset-credits")
          ? { status: 503, body: { token: "do-not-publish" } }
          : { status: 200, body: { rate_limit: { primary_window: { used_percent: 12 } } } },
    });
    const result = await test.api.readAccounts(config);
    expect(result[0]?.usageLimits.windows[0]?.usedPercent).toBe(12);
    expect(result[0]?.usageLimits.resetCredits).toBeUndefined();
  });

  it("isolates a failed account and never publishes upstream error bodies", async () => {
    const test = fixture({
      upstream: (request) =>
        request.auth_index === "a"
          ? { status: 401, body: { token: "do-not-publish" } }
          : {
              status: 200,
              body: request.url?.endsWith("rate-limit-reset-credits")
                ? { credits: [] }
                : { rate_limit: { primary_window: { used_percent: 12 } } },
            },
    });
    const result = await test.api.readAccounts(config);
    expect(result[0]?.usageLimits.unavailable?.reason).toBe("probeFailed");
    expect(result[1]?.usageLimits.windows[0]?.usedPercent).toBe(12);
    expect(JSON.stringify(result)).not.toContain("do-not-publish");
  });

  it("maps Claude scoped windows without a scheduler plugin", async () => {
    const test = fixture({
      accounts: [{ ...accounts[0]!, provider: "claude" }],
      // 没有 Claude Code 的 User-Agent 时用量接口返回 429
      upstream: (request) => ({
        status: request.header?.["User-Agent"]?.startsWith("claude-code/") ? 200 : 429,
        body: {
          five_hour: { utilization: 10, resets_at: null },
          seven_day: { utilization: 50, resets_at: "2099-01-01T00:00:00Z" },
          limits: [
            {
              kind: "weekly_scoped",
              percent: 80,
              resets_at: null,
              scope: { model: { display_name: "Fable" } },
            },
          ],
        },
      }),
    });
    const result = await test.api.readAccounts(config);
    expect(result[0]?.usageLimits.windows.map((window) => [window.id, window.usedPercent])).toEqual(
      [
        ["five_hour", 10],
        ["seven_day", 50],
        ["seven_day_fable", 80],
      ],
    );
  });

  it("pins redemption to the displayed credit and clears only that account's cooldown", async () => {
    const test = fixture();
    expect(await test.api.consume(config, "second.json", "credit-b")).toEqual({ outcome: "reset" });
    expect(await test.api.consume(config, "second.json", "credit-b")).toEqual({ outcome: "reset" });
    const redemptions = test.requests.filter((request) => request.body?.url?.endsWith("/consume"));
    expect(redemptions).toHaveLength(2);
    expect(redemptions[0]?.body?.data).toBe(redemptions[1]?.body?.data);
    expect(redemptions[0]?.body?.data).toBe(
      JSON.stringify({
        redeem_request_id: "519d5243-011a-5b7b-91f3-44d85f095705",
        credit_id: "credit-b",
      }),
    );
    expect(
      test.requests
        .filter((request) => request.path.endsWith("/reset-quota"))
        .map((request) => request.body?.auth_index),
    ).toEqual(["b", "b"]);
  });

  it("reports redemption success even if cooldown clearing fails", async () => {
    const result = await fixture({ cooldownStatus: 404 }).api.consume(
      config,
      "first.json",
      "credit",
    );
    expect(result.outcome).toBe("reset");
    expect(result.warning).toContain("冷却");
  });

  it("skips disabled accounts and rejects redemption on them", async () => {
    const test = fixture({ accounts: [{ ...accounts[0]!, disabled: true }] });
    expect(await test.api.readAccounts(config)).toEqual([]);
    await failure(test.api.consume(config, "first.json", "credit"));
    expect(test.requests.every((request) => request.path.endsWith("/auth-files"))).toBe(true);
  });

  it("keeps the same redemption id after an uncertain upstream failure", async () => {
    let attempts = 0;
    const test = fixture({
      upstream: () =>
        ++attempts === 1
          ? { status: 503, body: {} }
          : { status: 200, body: { code: "already_redeemed" } },
    });
    await failure(test.api.consume(config, "first.json", "credit"));
    expect(await test.api.consume(config, "first.json", "credit")).toEqual({
      outcome: "alreadyRedeemed",
    });
    const data = test.requests
      .filter((request) => request.body?.url?.endsWith("/consume"))
      .map((request) => request.body?.data);
    expect(data[0]).toBe(data[1]);
    expect(test.requests.filter((request) => request.path.endsWith("/reset-quota"))).toHaveLength(1);
  });

  it("rejects unknown accounts without forwarding a redemption", async () => {
    const test = fixture();
    await failure(test.api.consume(config, "missing.json", "credit"));
    expect(test.requests).toHaveLength(1);
  });
});
