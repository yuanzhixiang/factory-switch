// 移植自 T3 Code（MIT）packages/provider-cursor/src/server/usageLimits.test.ts（本机只有 macOS 路径），
// Effect 的 HttpClient / 钥匙串服务换成注入的假实现，断言保持不变（提示文字改成中文）。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { cursorUsageResponseToLimits, probeCursor } from "../../src/core/usage-limits/cursor";

const mustNotFetch: typeof fetch = () => {
  throw new Error("must not request usage");
};
const mustNotReadKeychain = () => Promise.reject(new Error("must not read Keychain"));

function usageFetch(expectedToken: string, totalPercentUsed: number): typeof fetch {
  return async (_input, init) => {
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${expectedToken}`);
    return Response.json({ planUsage: { totalPercentUsed } });
  };
}

describe("Cursor usage limits", () => {
  const checkedAt = "2026-09-16T00:00:00.000Z";

  it("uses the advertised percentages and billing-cycle reset", () => {
    const limits = cursorUsageResponseToLimits(
      {
        billingCycleEnd: "1789876386000",
        planUsage: { totalPercentUsed: 72.4, autoPercentUsed: 69.5, apiPercentUsed: 100 },
      },
      checkedAt,
    );
    expect(limits.windows).toEqual(
      expect.arrayContaining([
        {
          id: "totalPercentUsed",
          kind: "monthly",
          label: "Overall",
          usedPercent: 72.4,
          resetsAt: "2026-09-20T03:53:06.000Z",
        },
        {
          id: "autoPercentUsed",
          kind: "monthly",
          label: "Cursor Models",
          usedPercent: 69.5,
          resetsAt: "2026-09-20T03:53:06.000Z",
        },
        {
          id: "apiPercentUsed",
          kind: "monthly",
          label: "Other Models",
          usedPercent: 100,
          resetsAt: "2026-09-20T03:53:06.000Z",
        },
      ]),
    );
  });

  it("does not invent unused allowance for absent buckets", () => {
    expect(cursorUsageResponseToLimits({ planUsage: {} }, checkedAt).unavailable?.reason).toBe(
      "unsupported",
    );
    expect(
      cursorUsageResponseToLimits({ planUsage: { totalPercentUsed: 0 } }, checkedAt).windows,
    ).toEqual([{ id: "totalPercentUsed", kind: "monthly", label: "Overall", usedPercent: 0 }]);
    expect(
      cursorUsageResponseToLimits({ planUsage: { totalPercentUsed: 150 } }, checkedAt).windows,
    ).toEqual([{ id: "totalPercentUsed", kind: "monthly", label: "Overall", usedPercent: 100 }]);
  });

  it("reads a file login when the CLI stores credentials in a file", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-limits-test-"));
    try {
      await fs.mkdir(path.join(home, ".cursor"));
      await fs.writeFile(
        path.join(home, ".cursor", "auth.json"),
        JSON.stringify({ accessToken: "file-token" }),
      );
      const provider = await probeCursor({
        allowKeychain: false,
        environment: { HOME: home, AGENT_CLI_CREDENTIAL_STORE: "file" },
        httpFetch: usageFetch("file-token", 33),
        readKeychain: mustNotReadKeychain,
      });
      expect(provider.usageLimits?.windows[0]?.usedPercent).toBe(33);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("never reads stale files for keychain or memory logins, but accepts an explicit auth token", async () => {
    for (const store of ["memory", "default"] as const) {
      for (const token of [undefined, "explicit-token"]) {
        const provider = await probeCursor({
          allowKeychain: false,
          environment: {
            HOME: "/nonexistent",
            AGENT_CLI_CREDENTIAL_STORE: store,
            ...(token ? { CURSOR_AUTH_TOKEN: token } : {}),
          },
          httpFetch: token ? usageFetch(token, 10) : mustNotFetch,
          readKeychain: mustNotReadKeychain,
        });
        if (token) expect(provider.usageLimits?.windows[0]?.usedPercent).toBe(10);
        else expect(provider.usageLimits?.unavailable?.reason).toBe("unsupported");
      }
    }
  });

  it("reports failed requests without exposing credentials or response bodies", async () => {
    const provider = await probeCursor({
      allowKeychain: false,
      environment: { CURSOR_AUTH_TOKEN: "private-token" },
      httpFetch: async () => new Response("private response", { status: 401 }),
    });
    expect(provider.usageLimits?.unavailable).toEqual({
      reason: "probeFailed",
      message: "Cursor 读取额度失败。",
    });
  });

  it("does not use a stored login for an explicit API key", async () => {
    const provider = await probeCursor({
      allowKeychain: true,
      environment: { CURSOR_API_KEY: "different-account" },
      httpFetch: mustNotFetch,
      readKeychain: mustNotReadKeychain,
    });
    expect(provider.usageLimits?.unavailable?.reason).toBe("unsupported");
  });

  it("asks for permission before reading the macOS Keychain", async () => {
    const provider = await probeCursor({
      allowKeychain: false,
      environment: {},
      httpFetch: mustNotFetch,
      readKeychain: mustNotReadKeychain,
    });
    expect(provider.usageLimits?.unavailable?.reason).toBe("unsupported");
    expect(provider.usageLimits?.unavailable?.message).toContain("钥匙串");
  });

  it("reads the default macOS Cursor login from Keychain for limits", async () => {
    const provider = await probeCursor({
      allowKeychain: true,
      environment: {},
      httpFetch: usageFetch("keychain-token", 42),
      readKeychain: async () => "keychain-token",
    });
    expect(provider.usageLimits?.windows[0]?.usedPercent).toBe(42);
  });

  it("reports a Keychain initialization failure without failing the provider refresh", async () => {
    const provider = await probeCursor({
      allowKeychain: true,
      environment: {},
      httpFetch: mustNotFetch,
      readKeychain: () => Promise.reject(new Error("Keychain initialization failed")),
    });
    expect(provider.usageLimits?.unavailable?.reason).toBe("probeFailed");
  });

  it("does not read Keychain or send its token to a custom endpoint", async () => {
    for (const endpoint of ["http://localhost:3000", "https://cursor-proxy.example"]) {
      const provider = await probeCursor({
        allowKeychain: true,
        environment: { CURSOR_API_ENDPOINT: endpoint },
        httpFetch: mustNotFetch,
        readKeychain: mustNotReadKeychain,
      });
      expect(provider.usageLimits?.unavailable?.reason).toBe("unsupported");
      expect(provider.usageLimits?.unavailable?.message).toContain("默认接口地址");
    }
  });
});
