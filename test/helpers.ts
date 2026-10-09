import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AUTH_FILE, encryptCredentials } from "../src/core/credentials";
import type { Env } from "../src/core/env";
import type { FactoryProcess } from "../src/core/factory-process";

/** 记录调用的假 Factory 进程 */
export interface FakeFactory extends FactoryProcess {
  running: boolean;
  calls: string[];
  otherDroids: string[];
  quitSucceeds: boolean;
  /** 模拟 Factory 退出前最后一次刷新 token */
  onQuit: (() => Promise<void>) | null;
}

export interface TestEnv extends Env {
  factory: FakeFactory;
  key: Buffer;
  reports: string[];
  root: string;
  /** 每次查用量带的 Bearer，按顺序记录 */
  bearers: string[];
  /** 按 Bearer 决定假接口的返回 */
  respond: (bearer: string) => { status: number; body: unknown };
}

/** 造一个 access_token：只有 payload 有意义 */
function fakeJwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(claims)}.sig`;
}

/** 生成某个账号的加密凭证文件内容，token 后缀用来区分不同版本 */
export function makeAuth(
  env: TestEnv,
  account: { userId: string; orgId: string; email: string },
  tokenSuffix = "v1",
): string {
  return encryptCredentials(
    {
      access_token: fakeJwt({
        sub: account.userId,
        email: account.email,
        first_name: "Test",
        last_name: account.userId,
        external_org_id: account.orgId,
      }),
      refresh_token: `refresh-${account.userId}-${tokenSuffix}`,
      active_organization_id: account.orgId,
    },
    env.key,
  );
}

/** 让 Factory 目录处于“已登录某账号”的状态 */
export async function signIn(
  env: TestEnv,
  account: { userId: string; orgId: string; email: string },
  tokenSuffix = "v1",
): Promise<void> {
  await fs.writeFile(
    path.join(env.factoryDir, AUTH_FILE),
    makeAuth(env, account, tokenSuffix),
  );
  await fs.writeFile(
    path.join(env.factoryDir, "org-managed-settings.cache.json"),
    JSON.stringify({ orgId: account.orgId, userId: account.userId }),
  );
}

/** 建一套临时目录做的测试环境 */
export async function createTestEnv(): Promise<TestEnv> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fsw-test-"));
  const factoryDir = path.join(root, ".factory");
  await fs.mkdir(factoryDir, { recursive: true });
  const key = crypto.randomBytes(32);
  let clock = 1_000;
  const factory: FakeFactory = {
    running: true,
    calls: [],
    otherDroids: [],
    quitSucceeds: true,
    onQuit: null,
    async isRunning() {
      return this.running;
    },
    async quit() {
      this.calls.push("quit");
      if (!this.quitSucceeds) {
        return false;
      }
      await this.onQuit?.();
      this.running = false;
      return true;
    },
    async open() {
      this.calls.push("open");
      this.running = true;
    },
    async listOtherDroidProcesses() {
      return this.otherDroids;
    },
  };
  const reports: string[] = [];
  const env: TestEnv = {
    root,
    key,
    reports,
    bearers: [],
    respond: () => ({ status: 500, body: {} }),
    factoryDir,
    vaultDir: path.join(root, ".factory-switch"),
    readEncryptionKey: async () => key,
    factory,
    httpFetch: async (_input, init) => {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      const bearer = auth.replace(/^Bearer /, "");
      env.bearers.push(bearer);
      const { status, body } = env.respond(bearer);
      return new Response(JSON.stringify(body), { status });
    },
    now: () => (clock += 1_000),
    report: (message) => reports.push(message),
  };
  return env;
}

/** 造一份 /api/billing/limits 的响应 */
export function limitsBody(fiveHour: number, windowEnd: string | null = null) {
  const window = (usedPercent: number) => ({
    usedPercent,
    windowEnd,
    secondsRemaining: null,
  });
  return {
    limits: {
      standard: {
        fiveHour: window(fiveHour),
        weekly: window(10),
        monthly: window(5),
      },
      core: { fiveHour: window(0), weekly: window(0), monthly: window(0) },
    },
    overagePreference: "droidCore",
    extraUsageBalanceCents: 250,
  };
}

export const ALICE = {
  userId: "user_alice",
  orgId: "org_A",
  email: "alice@example.com",
};
export const BOB = {
  userId: "user_bob",
  orgId: "org_B",
  email: "bob@example.com",
};
