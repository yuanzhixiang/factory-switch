import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backupCurrent, getState } from "../src/core/operations";
import {
  collectUsage,
  detectUsageAlerts,
  parseLimits,
  setApiKey,
} from "../src/core/usage";
import { accountIdFor, listAccounts, readApiKey } from "../src/core/vault";
import type { UsageMap, UsageSnapshot } from "../src/shared/types";
import {
  ALICE,
  BOB,
  createTestEnv,
  limitsBody,
  signIn,
  type TestEnv,
} from "./helpers";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await fs.rm(env.root, { recursive: true, force: true });
});

const ALICE_ID = accountIdFor(ALICE);
const BOB_ID = accountIdFor(BOB);

/** 造一份只关心 5 小时用量的快照 */
function snapshot(fiveHour: number, fetchedAt = 1): UsageSnapshot {
  return parseLimits(limitsBody(fiveHour), fetchedAt);
}

describe("parseLimits", () => {
  it("转换百分比、重置时间和额外额度", () => {
    const result = parseLimits(limitsBody(82, "2026-10-09T12:00:00.000Z"), 5);
    expect(result.standard.fiveHour).toEqual({
      usedPercent: 82,
      windowEnd: Date.parse("2026-10-09T12:00:00.000Z"),
    });
    expect(result.extraUsageCents).toBe(250);
    expect(result.overagePreference).toBe("droidCore");
    expect(parseLimits(limitsBody(0), 5).core.weekly.windowEnd).toBeNull();
  });

  it("缺 limits.standard 视为格式变化", () => {
    expect(() => parseLimits({}, 1)).toThrow("格式变了");
  });
});

describe("collectUsage", () => {
  beforeEach(async () => {
    await signIn(env, BOB);
    await backupCurrent(env, "B");
    await signIn(env, ALICE);
    await backupCurrent(env, "A");
  });

  it("当前账号用本地凭证，其他账号用 API Key，没 Key 的标为 none", async () => {
    env.respond = (bearer) =>
      bearer === "fk-bob-key"
        ? { status: 200, body: limitsBody(12) }
        : bearer.startsWith("fk-")
          ? { status: 401, body: {} }
          : { status: 200, body: limitsBody(82) };
    const usage = await collectUsage(env, {});
    expect(usage[ALICE_ID]).toMatchObject({
      source: "local-credentials",
      error: null,
    });
    expect(usage[ALICE_ID]?.snapshot?.standard.fiveHour.usedPercent).toBe(82);
    expect(usage[BOB_ID]).toEqual({
      source: "none",
      snapshot: null,
      error: null,
    });

    await setApiKey(env, BOB_ID, " fk-bob-key ");
    expect(await readApiKey(env, BOB_ID)).toBe("fk-bob-key");
    const next = await collectUsage(env, usage);
    expect(next[BOB_ID]?.source).toBe("api-key");
    expect(next[BOB_ID]?.snapshot?.standard.fiveHour.usedPercent).toBe(12);
    expect((await getState(env)).apiKeyHints).toEqual({ [BOB_ID]: "-key" });
  });

  it("查询失败时保留上一次的数据并给出错误", async () => {
    env.respond = () => ({ status: 200, body: limitsBody(30) });
    const first = await collectUsage(env, {});
    env.respond = () => ({ status: 503, body: {} });
    const second = await collectUsage(env, first);
    expect(second[ALICE_ID]?.snapshot).toBe(first[ALICE_ID]?.snapshot);
    expect(second[ALICE_ID]?.error).toContain("503");
  });

  it("本地凭证失效时退回用当前账号的 API Key", async () => {
    env.respond = (bearer) =>
      bearer === "fk-alice"
        ? { status: 200, body: limitsBody(40) }
        : { status: 401, body: {} };
    // setApiKey 校验时也要能查到
    await setApiKey(env, ALICE_ID, "fk-alice");
    const usage = await collectUsage(env, {});
    expect(usage[ALICE_ID]?.source).toBe("api-key");
  });

  it("没备份的当前账号也会查", async () => {
    await signIn(env, {
      userId: "user_new",
      orgId: "org_N",
      email: "n@example.com",
    });
    env.respond = () => ({ status: 200, body: limitsBody(5) });
    const usage = await collectUsage(env, {});
    expect(Object.keys(usage)).toContain(
      accountIdFor({ userId: "user_new", orgId: "org_N" }),
    );
  });

  it("本地没有凭证时只查有 Key 的账号", async () => {
    await fs.rm(path.join(env.factoryDir, "auth.v2.loginkeychain"));
    env.respond = () => ({ status: 200, body: limitsBody(5) });
    const usage = await collectUsage(env, {});
    expect(env.bearers).toEqual([]);
    expect(usage[ALICE_ID]?.source).toBe("none");
  });
});

describe("setApiKey", () => {
  beforeEach(async () => {
    await signIn(env, ALICE);
    await backupCurrent(env, "A");
  });

  it("格式不对或查不到用量就不保存", async () => {
    await expect(setApiKey(env, ALICE_ID, "abc")).rejects.toThrow("fk-");
    env.respond = () => ({ status: 401, body: {} });
    await expect(setApiKey(env, ALICE_ID, "fk-bad")).rejects.toThrow("401");
    expect(await readApiKey(env, ALICE_ID)).toBeNull();
  });

  it("Key 文件权限是 600", async () => {
    env.respond = () => ({ status: 200, body: limitsBody(1) });
    await setApiKey(env, ALICE_ID, "fk-ok");
    const stat = await fs.stat(
      path.join(env.vaultDir, "accounts", ALICE_ID, "api-key"),
    );
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

describe("detectUsageAlerts", () => {
  const entry = (fiveHour: number, error: string | null = null) => ({
    source: "api-key" as const,
    snapshot: snapshot(fiveHour),
    error,
  });

  it("当前账号涨过 70% 时提醒换号，其他账号回落到 70% 以下时提醒可用", async () => {
    await signIn(env, ALICE);
    await backupCurrent(env, "A");
    const accounts = await listAccounts(env);
    const previous: UsageMap = { [ALICE_ID]: entry(65), [BOB_ID]: entry(90) };
    const next: UsageMap = { [ALICE_ID]: entry(71), [BOB_ID]: entry(20) };
    const alerts = detectUsageAlerts(previous, next, ALICE_ID, accounts, 1);
    expect(alerts.map((alert) => alert.accountId)).toEqual([ALICE_ID, BOB_ID]);
    expect(alerts[0]?.title).toBe("「A」5 小时用量已到 71%");
  });

  it("没跨过 70%、第一次看到、查询出错时都不提醒", () => {
    expect(
      detectUsageAlerts(
        { a: entry(80), b: entry(10) },
        { a: entry(85), b: entry(20) },
        "a",
        [],
        1,
      ),
    ).toEqual([]);
    expect(detectUsageAlerts({}, { a: entry(90) }, "a", [], 1)).toEqual([]);
    expect(
      detectUsageAlerts({ b: entry(90) }, { b: entry(20, "x") }, "a", [], 1),
    ).toEqual([]);
  });

  it("5 小时周期过期按 0% 算，触发回落提醒", () => {
    // 上一次查询时周期就已经过期：前后都是 0%，不提醒
    const expired = parseLimits(
      limitsBody(95, "2026-01-01T00:00:00Z"),
      Date.parse("2026-01-15T00:00:00Z"),
    );
    const before = {
      source: "api-key" as const,
      snapshot: expired,
      error: null,
    };
    const after = {
      source: "api-key" as const,
      snapshot: { ...expired, fetchedAt: 2 },
      error: null,
    };
    const alerts = detectUsageAlerts(
      { b: before },
      { b: after },
      "a",
      [],
      Date.parse("2026-02-01T00:00:00Z"),
    );
    expect(alerts).toEqual([]);
    // 上一次还在周期内（95%），这一次周期已过期
    const live = parseLimits(limitsBody(95, "2026-01-01T00:00:00Z"), 0);
    const crossed = detectUsageAlerts(
      { b: { ...before, snapshot: live } },
      { b: after },
      "a",
      [],
      Date.parse("2026-02-01T00:00:00Z"),
    );
    expect(crossed).toHaveLength(1);
  });
});
