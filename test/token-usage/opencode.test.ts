// 移植自 T3 Code（MIT）packages/provider-opencode/src/server/usage.test.ts，
// Effect 的 SqlClient / FileSystem 换成 node:sqlite 和 node:fs，断言保持不变。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as NodeSqlite from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  openCodeUsageReader,
  readOpenCodeUsage,
} from "../../src/core/token-usage/providers/opencode";

const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

describe("readOpenCodeUsage", () => {
  it("bounds raw history allocations while counting every eligible message once", async () => {
    const dir = await tempDir("usage-reader-large-test-");
    const db = new NodeSqlite.DatabaseSync(path.join(dir, "opencode.db"));
    db.exec("CREATE TABLE message (id TEXT, session_id TEXT, data TEXT, time_created INTEGER)");
    const sinceMs = 1780000000000;
    const message = {
      role: "assistant",
      modelID: "claude-sonnet-4-5",
      time: { created: sinceMs },
      tokens: { input: 100, output: 20 },
      body: "x".repeat(64 * 1024),
    };
    const data = JSON.stringify(message);
    const insertStatement = db.prepare(
      "INSERT INTO message (rowid, id, session_id, data, time_created) VALUES (?, ?, ?, ?, ?)",
    );
    const insert = (rowId: number, id: string, payload: string, created = sinceMs) =>
      insertStatement.run(rowId, id, "session-1", payload, created);
    for (let index = 0; index < 130; index++) insert(index * 2 - 10, `msg-${index}`, data);
    insert(300, "old", data, sinceMs - 1);
    insert(301, "user", JSON.stringify({ ...message, role: "user" }));
    insert(302, "invalid", "{invalid");
    insert(303, "msg-0", data);
    db.close();

    let largestRawResult = 0;
    const originalAll = NodeSqlite.StatementSync.prototype.all;
    vi.spyOn(NodeSqlite.StatementSync.prototype, "all").mockImplementation(function (
      this: NodeSqlite.StatementSync,
      ...params: Parameters<NodeSqlite.StatementSync["all"]>
    ) {
      const rows = originalAll.apply(this, params);
      const rawSize = rows.reduce<number>(
        (size, row) =>
          size + (typeof (row as { data?: unknown }).data === "string"
            ? ((row as { data: string }).data).length
            : 0),
        0,
      );
      largestRawResult = Math.max(largestRawResult, rawSize);
      return rows;
    });
    const result = await readOpenCodeUsage(dir, sinceMs);
    expect(result.error).toBe(false);
    const records = result.files.flatMap((file) => file.records);
    expect(records.map((record) => record.dedupeKey)).toEqual(
      Array.from({ length: 130 }, (_, index) => `opencode:msg-${index}`),
    );
    expect(records.reduce((total, record) => total + record.totals.uncachedInputTokens, 0)).toBe(
      13000,
    );
    expect(largestRawResult).toBeGreaterThan(0);
    expect(largestRawResult).toBeLessThan(6 * 1024 * 1024);
  });

  it("counts migrated OpenCode messages once and sees subsequent WAL writes", async () => {
    const dir = await tempDir("usage-reader-test-");
    const db = new NodeSqlite.DatabaseSync(path.join(dir, "opencode.db"));
    try {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA wal_autocheckpoint = 0");
      db.exec("CREATE TABLE message (id TEXT, session_id TEXT, data TEXT)");
      const message = {
        id: "msg-1",
        sessionID: "session-1",
        role: "assistant",
        modelID: "claude-sonnet-4-5",
        time: { created: 1780000000000 },
        cost: 0.25,
        tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 30, write: 10 } },
      };
      const insert = (id: string, sessionId: string, payload: string) =>
        db.prepare("INSERT INTO message VALUES (?, ?, ?)").run(id, sessionId, payload);
      insert(message.id, message.sessionID, JSON.stringify(message));
      const legacy = path.join(dir, "storage", "message", message.sessionID);
      await fs.mkdir(legacy, { recursive: true });
      await fs.writeFile(path.join(legacy, "msg-1.json"), JSON.stringify(message));
      const first = await readOpenCodeUsage(dir, 0);
      expect(first.error).toBe(false);
      const records = first.files.flatMap((file) => file.records);
      expect(records.length).toBe(1);
      expect(records[0]?.totals).toEqual({
        uncachedInputTokens: 100,
        cachedInputTokens: 30,
        cacheCreationTokens: 10,
        outputTokens: 25,
        reasoningTokens: 5,
      });
      expect(records[0]?.reportedCostUsd).toBe(0.25);
      insert(
        "msg-2",
        message.sessionID,
        JSON.stringify({ ...message, id: "msg-2", time: { created: 1780000001000 } }),
      );
      const next = await readOpenCodeUsage(dir, 1780000001000);
      expect(next.error).toBe(false);
      expect(next.files.flatMap((file) => file.records).map((record) => record.dedupeKey)).toEqual([
        "opencode:msg-2",
      ]);
      expect((await fs.stat(path.join(dir, "opencode.db-wal"))).size).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("reads only legacy OpenCode messages written since the window opened", async () => {
    const dir = await tempDir("usage-reader-test-");
    const sinceMs = 1780000000000;
    const legacy = path.join(dir, "storage", "message", "session-1");
    await fs.mkdir(legacy, { recursive: true });
    const write = async (id: string, mtimeMs: number) => {
      const file = path.join(legacy, `${id}.json`);
      await fs.writeFile(
        file,
        JSON.stringify({
          id,
          sessionID: "session-1",
          role: "assistant",
          modelID: "claude-sonnet-4-5",
          time: { created: sinceMs + 1000 },
          tokens: { input: 100, output: 20 },
        }),
      );
      await fs.utimes(file, mtimeMs / 1000, mtimeMs / 1000);
      return file;
    };
    await write("msg-old", sinceMs - 60_000);

    const stale = await readOpenCodeUsage(dir, sinceMs);
    expect(stale).toEqual({ files: [], missing: false, error: false });

    const recent = await write("msg-new", sinceMs + 60_000);
    const result = await readOpenCodeUsage(dir, sinceMs);
    expect(result.missing).toBe(false);
    expect(result.error).toBe(false);
    expect(result.files.map((file) => file.path)).toEqual([recent]);
    expect(result.files.flatMap((file) => file.records).map((record) => record.dedupeKey)).toEqual([
      "opencode:msg-new",
    ]);
  });

  it("never follows symlinks in the legacy OpenCode store", async () => {
    const dir = await tempDir("usage-reader-test-");
    const outside = await tempDir("usage-reader-test-");
    const sinceMs = 1780000000000;
    const store = path.join(dir, "storage", "message");
    const session = path.join(store, "session-1");
    await fs.mkdir(session, { recursive: true });
    const write = async (directory: string, id: string, mtimeMs: number) => {
      const file = path.join(directory, `${id}.json`);
      await fs.writeFile(
        file,
        JSON.stringify({
          id,
          sessionID: "session-1",
          role: "assistant",
          modelID: "claude-sonnet-4-5",
          time: { created: sinceMs + 1000 },
          tokens: { input: 100, output: 20 },
        }),
      );
      await fs.utimes(file, mtimeMs / 1000, mtimeMs / 1000);
      return file;
    };
    const target = await write(outside, "msg-linked", sinceMs + 60_000);
    const stale = await write(outside, "msg-stale", sinceMs - 60_000);
    await fs.symlink(target, path.join(session, "msg-linked.json"));
    await fs.symlink(stale, path.join(session, "msg-stale.json"));
    await fs.symlink(outside, path.join(store, "session-linked"));
    await fs.symlink(store, path.join(session, "cycle"));
    await fs.symlink(path.join(outside, "gone.json"), path.join(session, "gone.json"));
    await fs.symlink(path.join(session, "loop.json"), path.join(session, "loop.json"));

    const linksOnly = await readOpenCodeUsage(dir, sinceMs);
    expect(linksOnly).toEqual({ files: [], missing: true, error: false });

    const real = await write(session, "msg-real", sinceMs + 60_000);
    const result = await readOpenCodeUsage(dir, sinceMs);
    expect(result.missing).toBe(false);
    expect(result.error).toBe(false);
    expect(result.files.map((file) => file.path)).toEqual([real]);
    expect(result.files.flatMap((file) => file.records).map((record) => record.dedupeKey)).toEqual([
      "opencode:msg-real",
    ]);
  });
});

describe("openCodeUsageReader", () => {
  // T3 合并多个实例各自的环境变量；本程序只有一个环境，三种目录来源分别用一次 scan 验证
  it("scans canonical roots once, including XDG and home defaults", async () => {
    const home = await fs.realpath(await tempDir("usage-instances-test-"));
    const defaultRoot = path.join(home, ".local", "share", "opencode");
    const instanceRoot = path.join(home, "instance");
    const dataHome = path.join(home, "xdg");
    const xdgRoot = path.join(dataHome, "opencode");
    const alias = path.join(home, "default-alias");
    for (const root of [defaultRoot, instanceRoot, xdgRoot]) {
      await fs.mkdir(root, { recursive: true });
    }
    await fs.symlink(defaultRoot, alias);
    const reader = openCodeUsageReader;
    if (reader.kind !== "scan") throw new Error("Expected an OpenCode scan reader");
    const scan = (environment: NodeJS.ProcessEnv) =>
      reader.scan(
        { homeDir: home, environment },
        { windowStartMs: 0, retentionCutoffMs: 0, awaitRefresh: true },
      );
    const dirsOf = async (environment: NodeJS.ProcessEnv) =>
      (await scan(environment)).map((source) => source.dir).sort();

    expect(await dirsOf({})).toEqual([defaultRoot]);
    expect(
      await dirsOf({ OPENCODE_DATA_DIR: ` ${instanceRoot}, ${alias}, ${defaultRoot}, , ` }),
    ).toEqual([defaultRoot, instanceRoot].sort());
    expect(await dirsOf({ XDG_DATA_HOME: dataHome })).toEqual([xdgRoot]);
  });
});
