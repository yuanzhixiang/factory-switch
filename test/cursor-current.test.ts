import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCursorCurrent } from "../src/core/cursor-current";

let root: string;
let dbPath: string;
let db: DatabaseSync;
const NOW = 1_800_000_000_000;

function jwt(sub: string, exp: unknown = NOW / 1000 + 3600) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ sub, exp })}.synthetic`;
}

function put(key: string, value: string | Uint8Array) {
  db.prepare("INSERT OR REPLACE INTO ItemTable VALUES (?, ?)").run(`cursorAuth/${key}`, value);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-current-test-"));
  dbPath = path.join(root, "User/globalStorage/state.vscdb");
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
  put("accessToken", jwt("user-a"));
  put("refreshToken", jwt("user-a"));
  put("cachedEmail", "alice@example.invalid");
  put("cachedScopedProfile", JSON.stringify({ authId: "user-a", displayName: "测试账号" }));
  put("stripeMembershipAuthId", "user-a");
  put("stripeMembershipType", "super");
  put("stripeSubscriptionStatus", "active");
});

afterEach(async () => {
  db.close();
  await fs.rm(root, { recursive: true, force: true });
});

describe("Cursor 当前账号只读识别", () => {
  it("读取 WAL 中最新身份，只返回允许展示的字段，数据库及 WAL 字节不变", async () => {
    const files = [dbPath, `${dbPath}-wal`];
    const before = await Promise.all(files.map((file) => fs.readFile(file)));
    const result = await readCursorCurrent(root, NOW);
    expect(result).toEqual({ kind: "identified", dataDirectory: root, checkedAt: NOW,
      userId: "user-a", email: "alice@example.invalid", name: "测试账号",
      expiresAt: NOW + 3_600_000, tokenStatus: "unexpired", hasRefreshToken: true,
      membership: "super", subscription: "active", cacheMismatch: false });
    expect(JSON.stringify(result)).not.toContain(jwt("user-a"));
    expect(JSON.stringify(result)).not.toContain("synthetic");
    expect(await Promise.all(files.map((file) => fs.readFile(file)))).toEqual(before);
  });

  it("缓存归属不匹配时不混入旧账号邮箱、名字和订阅", async () => {
    put("cachedScopedProfile", JSON.stringify({ authId: "user-b", displayName: "旧账号" }));
    put("stripeMembershipAuthId", "user-b");
    expect(await readCursorCurrent(root, NOW)).toMatchObject({ kind: "identified",
      userId: "user-a", email: null, name: null, membership: null, subscription: null, cacheMismatch: true });
  });

  it("缺少缓存时仍能按凭证声明识别账号 ID", async () => {
    db.prepare("DELETE FROM ItemTable WHERE key LIKE 'cursorAuth/cached%' OR key LIKE 'cursorAuth/stripe%'").run();
    expect(await readCursorCurrent(root, NOW)).toMatchObject({ kind: "identified", userId: "user-a", email: null, name: null });
  });

  it.each([[NOW / 1000 - 1, "expired"], [null, "unknown"], ["invalid", "unknown"], [1e300, "unknown"]])(
    "区分已过期或未知的本地到期声明：%s", async (expiry, status) => {
      put("accessToken", jwt("user-a", expiry));
      expect(await readCursorCurrent(root, NOW)).toMatchObject({ kind: "identified", tokenStatus: status });
    },
  );

  it("没有数据库或没有 token 时返回未发现凭证，不创建文件", async () => {
    const missing = path.join(root, "missing");
    expect(await readCursorCurrent(missing, NOW)).toMatchObject({ kind: "signed-out" });
    await expect(fs.stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
    db.prepare("DELETE FROM ItemTable WHERE key IN ('cursorAuth/accessToken','cursorAuth/refreshToken')").run();
    expect(await readCursorCurrent(root, NOW)).toMatchObject({ kind: "signed-out" });
  });

  it.each(["broken", "different-owner", "missing-access", "oversized", "missing-sub"])(
    "拒绝损坏或不一致的凭证，错误不泄漏内容：%s", async (kind) => {
      if (kind === "broken") put("accessToken", "synthetic-sensitive-invalid-token");
      if (kind === "different-owner") put("refreshToken", jwt("user-b"));
      if (kind === "missing-access") db.prepare("DELETE FROM ItemTable WHERE key='cursorAuth/accessToken'").run();
      if (kind === "oversized") put("accessToken", "sensitive".repeat(5000));
      if (kind === "missing-sub") put("accessToken", jwt(""));
      const result = await readCursorCurrent(root, NOW);
      expect(result.kind).toBe("unreadable");
      expect(JSON.stringify(result)).not.toMatch(/sensitive|synthetic|user-b/);
    },
  );

  it("支持账号字段以 BLOB 存储", async () => {
    put("accessToken", Buffer.from(jwt("user-a")));
    expect(await readCursorCurrent(root, NOW)).toMatchObject({ kind: "identified", userId: "user-a" });
  });

  it("表结构不兼容时返回固定错误，连接关闭后可继续访问夹具", async () => {
    db.exec("DROP TABLE ItemTable");
    expect(await readCursorCurrent(root, NOW)).toMatchObject({ kind: "unreadable" });
    expect(db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
  });
});
