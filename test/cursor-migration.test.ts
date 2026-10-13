import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * 仅用于临时数据库实验，不接入应用，也不接收外部数据路径。
 * 表结构参考 Cursor 3.24.12；记录内容、引用格式和工作区入口均为合成夹具。
 * refs 是实验定义的依赖清单，不代表已经解析了 Cursor 的真实引用格式。
 */
const SCHEMA = `
  CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
  CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
  CREATE TABLE composerHeaders (
    composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER,
    lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER,
    recency INTEGER, checkpointAt INTEGER, subagentTypeName TEXT, value TEXT
  );
`;
const WORKSPACE_SCHEMA =
  "CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)";
const RECORD_PREFIXES = [
  "composerData:", "bubbleId:", "checkpointId:", "agentKv:", "ofsContent:",
];
const ROOT_ID = "conversation-a";
const WORKSPACE_ID = "shared-project";

type Row = Record<string, string | number | bigint | Uint8Array | null>;

let root: string;
let source: DatabaseSync;
let target: DatabaseSync;
let sourceWorkspace: DatabaseSync;
let targetWorkspace: DatabaseSync;

function put(db: DatabaseSync, table: "ItemTable" | "cursorDiskKV", key: string, value: unknown) {
  db.prepare(`INSERT OR REPLACE INTO ${table} VALUES (?, ?)`).run(
    key, Buffer.from(JSON.stringify(value)),
  );
}

function get(db: DatabaseSync, table: "ItemTable" | "cursorDiskKV", key: string) {
  return db.prepare(`SELECT value FROM ${table} WHERE key = ?`).get(key)?.value as
    Uint8Array | undefined;
}

function json(bytes: Uint8Array): unknown {
  return JSON.parse(Buffer.from(bytes).toString("utf8"));
}

function rows(db: DatabaseSync, table: string): Row[] {
  return db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all() as Row[];
}

function header(db: DatabaseSync, id: string, refs: string[] = []) {
  db.prepare("INSERT INTO composerHeaders VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, WORKSPACE_ID, 100, 200, 0, 0, 200, 180, null,
      JSON.stringify({ composerId: id, refs }));
}

function decodeRefs(value: string | Uint8Array): string[] {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : json(value);
  if (typeof parsed !== "object" || parsed === null || !("refs" in parsed)
    || !Array.isArray(parsed.refs) || parsed.refs.some((ref) => typeof ref !== "string")) {
    throw new Error("实验引用清单格式不兼容");
  }
  return parsed.refs;
}

function decodeIndex(value: Uint8Array | undefined): string[] {
  const parsed: unknown = value ? json(value) : [];
  if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== "string")) {
    throw new Error("实验工作区索引格式不兼容");
  }
  return parsed;
}

/** 只从实验清单收集依赖，未知键和缺失引用必须失败，不能扩大复制范围。 */
function collectRecords(headerRow: Row): Map<string, Uint8Array> {
  const pending = [`composerData:${ROOT_ID}`, ...decodeRefs(headerRow.value as string)];
  const records = new Map<string, Uint8Array>();
  while (pending.length > 0) {
    const key = pending.pop()!;
    if (records.has(key)) continue;
    if (!RECORD_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      throw new Error("引用不在实验会话白名单中");
    }
    const value = get(source, "cursorDiskKV", key);
    if (!value) throw new Error("会话依赖缺失");
    records.set(key, value);
    // ofsContent 在实验中是二进制叶节点，其余记录按实验 refs 格式解析。
    if (!key.startsWith("ofsContent:")) pending.push(...decodeRefs(value));
  }
  return records;
}

/**
 * 操作的连接均由 beforeEach 在 mkdtemp 中创建，不提供真实目录入口。
 * SQLite backup 包含 WAL 中尚未 checkpoint 的记录；备份只落到实验目录。
 * 事务覆盖两份目标数据库的异常回滚，不承诺多数据库的断电原子性。
 */
async function migrate(failAfterRecords = false) {
  const sourceItems = rows(source, "ItemTable");
  const targetItems = rows(target, "ItemTable");
  const sourceHeader = source.prepare("SELECT * FROM composerHeaders WHERE composerId = ?")
    .get(ROOT_ID) as Row | undefined;
  if (!sourceHeader || sourceHeader.workspaceId !== WORKSPACE_ID) {
    throw new Error("会话列表或工作区关联缺失");
  }
  const records = collectRecords(sourceHeader);
  const sourceIndex = decodeIndex(get(sourceWorkspace, "ItemTable", "composer.composerData"));
  if (!sourceIndex.includes(ROOT_ID)) throw new Error("来源工作区入口缺失");

  await backup(target, path.join(root, "target-before.sqlite"));
  await backup(targetWorkspace, path.join(root, "workspace-before.sqlite"));
  target.exec("BEGIN IMMEDIATE");
  try {
    for (const [key, value] of records) {
      const existing = get(target, "cursorDiskKV", key);
      if (existing && !Buffer.from(existing).equals(Buffer.from(value))) {
        throw new Error("同一会话记录存在冲突");
      }
      target.prepare("INSERT OR IGNORE INTO cursorDiskKV VALUES (?, ?)").run(key, value);
    }
    const existingHeader = target.prepare("SELECT * FROM composerHeaders WHERE composerId = ?")
      .get(ROOT_ID);
    if (existingHeader && JSON.stringify(existingHeader) !== JSON.stringify(sourceHeader)) {
      throw new Error("同一会话列表存在冲突");
    }
    target.prepare("INSERT OR IGNORE INTO composerHeaders VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(...Object.values(sourceHeader));
    const targetIndex = decodeIndex(get(targetWorkspace, "ItemTable", "composer.composerData"));
    const merged = [...new Set([...targetIndex, ROOT_ID])];
    target.prepare("INSERT OR REPLACE INTO workspace.ItemTable VALUES (?, ?)")
      .run("composer.composerData", Buffer.from(JSON.stringify(merged)));
    if (failAfterRecords) throw new Error("模拟提交前故障");
    // 全部目标全局状态（包含 token、订阅、团队及扩展密钥）必须逐字节相同。
    if (JSON.stringify(rows(target, "ItemTable")) !== JSON.stringify(targetItems)
      || JSON.stringify(rows(source, "ItemTable")) !== JSON.stringify(sourceItems)) {
      throw new Error("账号状态意外改变");
    }
    target.exec("COMMIT");
    return { records: records.size, headers: 1 };
  } catch (error) {
    target.exec("ROLLBACK");
    throw error;
  }
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-migration-test-"));
  source = new DatabaseSync(path.join(root, "source.sqlite"));
  target = new DatabaseSync(path.join(root, "target.sqlite"));
  sourceWorkspace = new DatabaseSync(path.join(root, "source-workspace.sqlite"));
  targetWorkspace = new DatabaseSync(path.join(root, "target-workspace.sqlite"));
  for (const db of [source, target]) {
    db.exec(SCHEMA);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA busy_timeout=1000");
  }
  for (const db of [sourceWorkspace, targetWorkspace]) db.exec(WORKSPACE_SCHEMA);
  target.prepare("ATTACH DATABASE ? AS workspace")
    .run(path.join(root, "target-workspace.sqlite"));

  for (const [db, account] of [[source, "alice"], [target, "bob"]] as const) {
    for (const [key, value] of Object.entries({
      "cursorAuth/accessToken": `synthetic-access-${account}`,
      "cursorAuth/refreshToken": `synthetic-refresh-${account}`,
      "cursorAuth/cachedEmail": `${account}@example.invalid`,
      "cursorAuth/cachedScopedProfile": { authId: account },
      "cursorAuth/cachedTeam": { teamId: account },
      "cursorAuth/stripeMembershipType": account === "alice" ? "super" : "free",
      "adminSettings.cachedAuthId": account,
      "secret://synthetic-worker-key": `synthetic-secret-${account}`,
      "src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser":
        { aiSettings: { teamIds: [account] } },
      "unrelated-setting": { fontSize: account === "alice" ? 12 : 14 },
    })) put(db, "ItemTable", key, value);
    put(db, "cursorDiskKV", "unrelated-record", { owner: account });
  }

  header(source, ROOT_ID, ["checkpointId:checkpoint-a"]);
  put(source, "cursorDiskKV", `composerData:${ROOT_ID}`, {
    composerId: ROOT_ID, refs: ["bubbleId:message-a", "bubbleId:message-b"],
    createdAt: 100, modelConfig: { modelName: "synthetic-model" },
    blobEncryptionKey: "synthetic-local-key",
  });
  put(source, "cursorDiskKV", "bubbleId:message-a", {
    text: "合成用户消息", refs: ["bubbleId:message-b"],
  });
  put(source, "cursorDiskKV", "bubbleId:message-b", {
    text: "合成助手消息", refs: ["checkpointId:checkpoint-a", "agentKv:state-a"],
  });
  put(source, "cursorDiskKV", "checkpointId:checkpoint-a", {
    refs: ["ofsContent:file-a"], filePath: "/synthetic/project/example.ts",
  });
  put(source, "cursorDiskKV", "agentKv:state-a", {
    refs: ["bubbleId:message-a"], status: "completed",
  });
  source.prepare("INSERT INTO cursorDiskKV VALUES (?, ?)")
    .run("ofsContent:file-a", Buffer.from([0, 255, 128, 10, 13]));
  header(target, "conversation-b");
  put(target, "cursorDiskKV", "composerData:conversation-b", { refs: [], text: "目标原有会话" });
  put(sourceWorkspace, "ItemTable", "composer.composerData", [ROOT_ID]);
  put(targetWorkspace, "ItemTable", "composer.composerData", ["conversation-b"]);
  put(targetWorkspace, "ItemTable", "secret://workspace", "synthetic-target-secret");
  put(targetWorkspace, "ItemTable", "layout", { panel: "right" });
});

afterEach(async () => {
  for (const db of [source, target, sourceWorkspace, targetWorkspace]) db?.close();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

describe("Cursor 临时数据库会话迁移实验", () => {
  it("完整复制引用闭包和二进制数据，合并入口，保留双方账号及目标原有数据", async () => {
    const beforeSource = [rows(source, "ItemTable"), rows(source, "cursorDiskKV"), rows(source, "composerHeaders")];
    const beforeTarget = rows(target, "ItemTable");
    const beforeWorkspace = rows(targetWorkspace, "ItemTable")
      .filter((row) => row.key !== "composer.composerData");
    const originalConversation = get(target, "cursorDiskKV", "composerData:conversation-b");
    const unrelated = get(target, "cursorDiskKV", "unrelated-record");
    expect(await migrate()).toEqual({ records: 6, headers: 1 });
    for (const row of rows(source, "cursorDiskKV").filter((row) => row.key !== "unrelated-record")) {
      expect(get(target, "cursorDiskKV", row.key as string)).toEqual(row.value);
    }
    expect(rows(target, "composerHeaders").find((row) => row.composerId === ROOT_ID))
      .toEqual(rows(source, "composerHeaders")[0]);
    expect(json(get(targetWorkspace, "ItemTable", "composer.composerData")!))
      .toEqual(["conversation-b", ROOT_ID]);
    expect(rows(target, "ItemTable")).toEqual(beforeTarget);
    expect(rows(targetWorkspace, "ItemTable").filter((row) => row.key !== "composer.composerData"))
      .toEqual(beforeWorkspace);
    expect(get(target, "cursorDiskKV", "composerData:conversation-b")).toEqual(originalConversation);
    expect(get(target, "cursorDiskKV", "unrelated-record")).toEqual(unrelated);
    expect([rows(source, "ItemTable"), rows(source, "cursorDiskKV"), rows(source, "composerHeaders")])
      .toEqual(beforeSource);
  });

  it("重复导入不产生重复会话或工作区入口", async () => {
    await migrate();
    const before = [rows(target, "cursorDiskKV"), rows(target, "composerHeaders"), rows(targetWorkspace, "ItemTable")];
    await migrate();
    expect([rows(target, "cursorDiskKV"), rows(target, "composerHeaders"), rows(targetWorkspace, "ItemTable")])
      .toEqual(before);
  });

  it.each(["missing", "unknown", "index"])("依赖缺失、未知引用或无入口时拒绝迁移：%s", async (kind) => {
    if (kind === "missing") source.prepare("DELETE FROM cursorDiskKV WHERE key = ?").run("ofsContent:file-a");
    if (kind === "unknown") put(source, "cursorDiskKV", "agentKv:state-a", { refs: ["cursorAuth/accessToken"] });
    if (kind === "index") put(sourceWorkspace, "ItemTable", "composer.composerData", []);
    const before = [rows(target, "cursorDiskKV"), rows(target, "composerHeaders"), rows(targetWorkspace, "ItemTable")];
    await expect(migrate()).rejects.toThrow();
    expect([rows(target, "cursorDiskKV"), rows(target, "composerHeaders"), rows(targetWorkspace, "ItemTable")])
      .toEqual(before);
  });

  it.each(["record", "header"])("发生冲突时拒绝覆盖，并撤销已写入的数据：%s", async (kind) => {
    if (kind === "record") put(target, "cursorDiskKV", "bubbleId:message-a", { refs: [], text: "目标独立修改" });
    if (kind === "header") header(target, ROOT_ID, ["different-reference"]);
    const before = [rows(target, "ItemTable"), rows(target, "cursorDiskKV"), rows(target, "composerHeaders"), rows(targetWorkspace, "ItemTable")];
    await expect(migrate()).rejects.toThrow("冲突");
    expect([rows(target, "ItemTable"), rows(target, "cursorDiskKV"), rows(target, "composerHeaders"), rows(targetWorkspace, "ItemTable")])
      .toEqual(before);
  });

  it("提交前故障同时回滚会话、列表及工作区入口，备份含目标未 checkpoint 的 WAL 数据", async () => {
    const before = [rows(target, "ItemTable"), rows(target, "cursorDiskKV"), rows(target, "composerHeaders"), rows(targetWorkspace, "ItemTable")];
    expect((await fs.stat(path.join(root, "target.sqlite-wal"))).size).toBeGreaterThan(0);
    await expect(migrate(true)).rejects.toThrow("模拟提交前故障");
    expect([rows(target, "ItemTable"), rows(target, "cursorDiskKV"), rows(target, "composerHeaders"), rows(targetWorkspace, "ItemTable")])
      .toEqual(before);
    const saved = new DatabaseSync(path.join(root, "target-before.sqlite"), { readOnly: true });
    const savedWorkspace = new DatabaseSync(path.join(root, "workspace-before.sqlite"), { readOnly: true });
    try {
      expect([rows(saved, "ItemTable"), rows(saved, "cursorDiskKV"), rows(saved, "composerHeaders"), rows(savedWorkspace, "ItemTable")])
        .toEqual(before);
      expect(saved.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
    } finally {
      saved.close();
      savedWorkspace.close();
    }
  });
});
