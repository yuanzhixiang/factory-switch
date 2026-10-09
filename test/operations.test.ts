import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUTH_FILE, decryptCredentials } from "../src/core/credentials";
import {
  backupCurrent,
  deleteLocalCredentials,
  getState,
  switchTo,
} from "../src/core/operations";
import { stripOrgFromTranscript } from "../src/core/sessions";
import {
  accountIdFor,
  listAccounts,
  removeAccount,
  renameAccount,
} from "../src/core/vault";
import { ALICE, BOB, createTestEnv, signIn, type TestEnv } from "./helpers";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await fs.rm(env.root, { recursive: true, force: true });
});

/** 读出 Factory 目录里当前凭证的 refresh_token，用来判断是哪个账号的哪一版 */
async function currentRefreshToken(): Promise<string> {
  const content = await fs.readFile(
    path.join(env.factoryDir, AUTH_FILE),
    "utf8",
  );
  return (decryptCredentials(content, env.key) as { refresh_token: string })
    .refresh_token;
}

/** 写一个会话文件 */
async function writeSession(
  relative: string,
  header: Record<string, unknown>,
  body = "",
) {
  const file = path.join(env.factoryDir, "sessions", relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(header)}\n${body}`);
  return file;
}

describe("getState", () => {
  it("读出当前登录账号的身份，且不包含 token", async () => {
    await signIn(env, ALICE);
    const state = await getState(env);
    expect(state.current).toEqual({
      kind: "signed-in",
      identity: {
        userId: "user_alice",
        orgId: "org_A",
        email: "alice@example.com",
        name: "Test user_alice",
      },
      accountId: accountIdFor(ALICE),
      savedAccountId: null,
    });
    expect(JSON.stringify(state)).not.toContain("refresh-");
  });

  it("没有凭证文件时是未登录", async () => {
    expect((await getState(env)).current).toEqual({ kind: "signed-out" });
  });

  it("凭证解不开时返回 unreadable 而不是抛错", async () => {
    await fs.writeFile(path.join(env.factoryDir, AUTH_FILE), "a:b:c");
    expect((await getState(env)).current.kind).toBe("unreadable");
  });
});

describe("backupCurrent", () => {
  it("首次备份必须给名字", async () => {
    await signIn(env, ALICE);
    await expect(backupCurrent(env, null)).rejects.toThrow("起个名字");
  });

  it("再次备份会覆盖凭证并保留原名", async () => {
    await signIn(env, ALICE, "v1");
    await backupCurrent(env, "工作号");
    await signIn(env, ALICE, "v2");
    await backupCurrent(env, null);
    const [account] = await listAccounts(env);
    expect(account?.label).toBe("工作号");
    const saved = await fs.readFile(
      path.join(env.vaultDir, "accounts", accountIdFor(ALICE), AUTH_FILE),
      "utf8",
    );
    expect(
      (decryptCredentials(saved, env.key) as { refresh_token: string })
        .refresh_token,
    ).toBe("refresh-user_alice-v2");
    expect((await getState(env)).current).toMatchObject({
      savedAccountId: accountIdFor(ALICE),
    });
  });

  it("没有登录时不能备份", async () => {
    await expect(backupCurrent(env, "x")).rejects.toThrow("没有登录凭证");
  });
});

describe("switchTo", () => {
  beforeEach(async () => {
    await signIn(env, BOB);
    await backupCurrent(env, "B");
    await signIn(env, ALICE);
    await backupCurrent(env, "A");
  });

  it("换入目标凭证，并先把当前账号退出前刷新的 token 存回备份", async () => {
    // Factory 退出前把 Alice 的 token 刷新成 v2
    env.factory.onQuit = () => signIn(env, ALICE, "v2");
    await switchTo(env, accountIdFor(BOB));

    expect(await currentRefreshToken()).toBe("refresh-user_bob-v1");
    expect(env.factory.calls).toEqual(["quit", "open"]);
    const org = await fs.readFile(
      path.join(env.factoryDir, "org-managed-settings.cache.json"),
      "utf8",
    );
    expect(JSON.parse(org).orgId).toBe("org_B");

    // 再切回 Alice，拿到的是 v2 而不是旧的 v1
    env.factory.onQuit = null;
    await switchTo(env, accountIdFor(ALICE));
    expect(await currentRefreshToken()).toBe("refresh-user_alice-v2");
  });

  it("去掉会话组织标记，保留修改时间，并备份原文件和会话索引", async () => {
    const tagged = await writeSession(
      "-proj/s1.jsonl",
      { type: "session_start", id: "s1", organizationId: "org_A", title: "t" },
      '{"type":"message"}\n',
    );
    const untouched = await writeSession("-proj/s2.jsonl", {
      type: "session_start",
      id: "s2",
    });
    const mtime = new Date("2026-01-02T03:04:05Z");
    await fs.utimes(tagged, mtime, mtime);
    const indexDir = path.join(env.factoryDir, "cache", "session-index");
    await fs.mkdir(indexDir, { recursive: true });
    await fs.writeFile(path.join(indexDir, "index.db"), "db");

    await switchTo(env, accountIdFor(BOB));

    const lines = (await fs.readFile(tagged, "utf8")).split("\n");
    expect(JSON.parse(lines[0]!)).toEqual({
      type: "session_start",
      id: "s1",
      title: "t",
    });
    expect(lines[1]).toBe('{"type":"message"}');
    expect((await fs.stat(tagged)).mtime.getTime()).toBe(mtime.getTime());
    expect(await fs.readFile(untouched, "utf8")).toContain('"id":"s2"');
    await expect(fs.access(path.join(indexDir, "index.db"))).rejects.toThrow();

    const backups = await fs.readdir(path.join(env.vaultDir, "backups"));
    const backupRoot = path.join(env.vaultDir, "backups", backups[0]!);
    expect(
      await fs.readFile(
        path.join(backupRoot, "sessions/-proj/s1.jsonl"),
        "utf8",
      ),
    ).toContain("org_A");
    expect(
      await fs.readFile(
        path.join(backupRoot, "cache/session-index/index.db"),
        "utf8",
      ),
    ).toBe("db");
  });

  it("当前账号没备份时拒绝切换，且不退出 Factory", async () => {
    await signIn(env, {
      userId: "user_new",
      orgId: "org_N",
      email: "n@example.com",
    });
    await expect(switchTo(env, accountIdFor(BOB))).rejects.toThrow(
      "还没有备份",
    );
    expect(env.factory.calls).toEqual([]);
  });

  it("终端里有 droid 时拒绝切换", async () => {
    env.factory.otherDroids = ["123 /Users/me/.local/bin/droid"];
    await expect(switchTo(env, accountIdFor(BOB))).rejects.toThrow(
      "终端里还有 droid",
    );
    expect(env.factory.calls).toEqual([]);
  });

  it("Factory 退出超时就中止，不改任何文件", async () => {
    env.factory.quitSucceeds = false;
    await expect(switchTo(env, accountIdFor(BOB))).rejects.toThrow(
      "没有在 20 秒内退出",
    );
    expect(await currentRefreshToken()).toBe("refresh-user_alice-v1");
  });

  it("目标就是当前账号时什么都不做", async () => {
    expect(await switchTo(env, accountIdFor(ALICE))).toContain("当前已经是");
    expect(env.factory.calls).toEqual([]);
  });

  it("备份凭证被篡改时拒绝切换", async () => {
    await fs.writeFile(
      path.join(env.vaultDir, "accounts", accountIdFor(BOB), AUTH_FILE),
      await fs.readFile(
        path.join(env.vaultDir, "accounts", accountIdFor(ALICE), AUTH_FILE),
      ),
    );
    await expect(switchTo(env, accountIdFor(BOB))).rejects.toThrow("对不上");
  });
});

describe("deleteLocalCredentials", () => {
  it("凭证移进备份区，更新已备份账号，然后重开 Factory", async () => {
    await signIn(env, ALICE);
    await backupCurrent(env, "A");
    env.factory.onQuit = () => signIn(env, ALICE, "v3");

    await deleteLocalCredentials(env);

    await expect(
      fs.access(path.join(env.factoryDir, AUTH_FILE)),
    ).rejects.toThrow();
    await expect(
      fs.access(path.join(env.factoryDir, "org-managed-settings.cache.json")),
    ).rejects.toThrow();
    expect(env.factory.calls).toEqual(["quit", "open"]);
    expect((await getState(env)).current).toEqual({ kind: "signed-out" });

    // 删掉之后再切回 A，拿到的是退出前最后刷新的 v3
    await switchTo(env, accountIdFor(ALICE));
    expect(await currentRefreshToken()).toBe("refresh-user_alice-v3");
  });

  it("没备份的账号删除后凭证仍保留在备份区", async () => {
    await signIn(env, ALICE);
    await deleteLocalCredentials(env);
    const backups = await fs.readdir(path.join(env.vaultDir, "backups"));
    const kept = path.join(env.vaultDir, "backups", backups[0]!, AUTH_FILE);
    expect(await fs.readFile(kept, "utf8")).toContain(":");
  });
});

describe("账号管理", () => {
  it("改名和删除", async () => {
    await signIn(env, ALICE);
    await backupCurrent(env, "A");
    await renameAccount(env, accountIdFor(ALICE), "  新名字 ");
    expect((await listAccounts(env))[0]?.label).toBe("新名字");
    await expect(renameAccount(env, accountIdFor(ALICE), " ")).rejects.toThrow(
      "不能为空",
    );
    await removeAccount(env, accountIdFor(ALICE));
    expect(await listAccounts(env)).toEqual([]);
  });
});

describe("stripOrgFromTranscript", () => {
  it("首行不是会话头或没有标记时不改", () => {
    expect(
      stripOrgFromTranscript(Buffer.from('{"type":"message"}\n')),
    ).toBeNull();
    expect(
      stripOrgFromTranscript(Buffer.from('{"type":"session_start"}')),
    ).toBeNull();
    expect(stripOrgFromTranscript(Buffer.from("not json"))).toBeNull();
  });
});
