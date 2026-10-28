// 移植自 T3 Code（MIT）apps/server/src/provider/Drivers/antigravityUsageReader.test.ts，
// Effect 的 SqlClient / FileSystem 换成 node:sqlite 和 node:fs，断言保持不变。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  makeAntigravityUsageCache,
  readAntigravityUsage,
} from "../../src/core/token-usage/providers/antigravity";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "usage-reader-test-"));
  dirs.push(dir);
  return dir;
}

interface TestDatabase {
  exec(statement: string): void;
  run(statement: string, params: ReadonlyArray<number | string | Uint8Array>): void;
}

function openDatabase(filename: string): TestDatabase & { close(): void } {
  const db = new DatabaseSync(filename);
  return {
    exec: (statement) => db.exec(statement),
    run: (statement, params) => {
      db.prepare(statement).run(...params);
    },
    close: () => db.close(),
  };
}

function seedDatabase(filename: string, seed: (db: TestDatabase) => void) {
  const db = openDatabase(filename);
  try {
    seed(db);
  } finally {
    db.close();
  }
}

function protoNumber(field: number, value: number): number[] {
  const varint = (number: number) => {
    const bytes: number[] = [];
    do {
      const byte = number % 128;
      number = Math.floor(number / 128);
      bytes.push(byte + (number > 0 ? 128 : 0));
    } while (number > 0);
    return bytes;
  };
  return [...varint(field * 8), ...varint(value)];
}

function protoBytes(field: number, bytes: readonly number[]): number[] {
  const encoded = protoNumber(field, bytes.length);
  encoded[0] = encoded[0]! + 2;
  return [...encoded, ...bytes];
}

function protoText(field: number, value: string): number[] {
  return protoBytes(field, [...Buffer.from(value)]);
}

const TABLES =
  "CREATE TABLE gen_metadata (idx INTEGER, data BLOB); CREATE TABLE steps (idx INTEGER, metadata BLOB)";

const createTables = (db: TestDatabase) => {
  for (const statement of TABLES.split("; ")) db.exec(statement);
};

const records = (result: Awaited<ReturnType<typeof readAntigravityUsage>>) =>
  result.files.flatMap((file) => file.records);

describe("readAntigravityUsage", () => {
  it("deduplicates Antigravity generation and step usage while preserving retry model and token buckets", async () => {
    const dir = await tempDir();
    const stamp = protoNumber(1, 1780000000);
    const usage = [
      ...protoNumber(2, 100),
      ...protoNumber(3, 40),
      ...protoNumber(4, 5),
      ...protoNumber(5, 20),
      ...protoNumber(9, 10),
      ...protoText(11, "response-1"),
    ];
    const retry = [
      ...protoNumber(1, 1026),
      ...protoNumber(2, 12),
      ...protoNumber(3, 3),
      ...protoText(11, "retry-1"),
    ];
    const generation = protoBytes(1, [
      ...protoBytes(4, usage),
      ...protoText(19, "Gemini 3 Pro"),
      ...protoBytes(9, protoBytes(4, stamp)),
    ]);
    const step = [
      ...protoBytes(9, usage),
      ...protoBytes(8, stamp),
      ...protoBytes(28, protoBytes(2, retry)),
    ];
    seedDatabase(path.join(dir, "session-1.db"), (db) => {
      createTables(db);
      db.run("INSERT INTO gen_metadata VALUES (?, ?)", [0, new Uint8Array(generation)]);
      db.run("INSERT INTO steps VALUES (?, ?)", [0, new Uint8Array(step)]);
    });
    const result = await readAntigravityUsage(dir, 0);
    expect(result.errors).toEqual([]);
    const read = records(result);
    expect(read.length).toBe(2);
    const main = read.find((record) => record.model === "gemini-3-pro");
    expect(main).toBeDefined();
    expect(main?.timestampMs).toBe(1780000000000);
    expect(main?.sessionId).toBe("session-1");
    expect(main?.totals).toEqual({
      uncachedInputTokens: 100,
      cachedInputTokens: 20,
      cacheCreationTokens: 5,
      outputTokens: 40,
      reasoningTokens: 10,
    });
    expect(
      read.find((record) => record.model === "claude-opus-4-6")?.totals.uncachedInputTokens,
    ).toBe(12);
    expect(records(await readAntigravityUsage(dir, 1780000000001))).toEqual([]);
  });

  it("uses the matching Antigravity generation model for each model-less step", async () => {
    const dir = await tempDir();
    seedDatabase(path.join(dir, "model-switch.db"), (db) => {
      createTables(db);
      for (const [idx, name] of ["Gemini 3 Pro", "Claude Opus 4.6"].entries()) {
        db.run("INSERT INTO gen_metadata VALUES (?, ?)", [
          idx,
          new Uint8Array(protoBytes(1, protoText(19, name))),
        ]);
        db.run("INSERT INTO steps VALUES (?, ?)", [
          idx,
          new Uint8Array(protoBytes(9, protoNumber(2, 10 + idx))),
        ]);
      }
    });
    const result = await readAntigravityUsage(dir, 0);
    expect(result.errors).toEqual([]);
    expect(records(result).map((record) => record.model)).toEqual([
      "gemini-3-pro",
      "claude-opus-4-6",
    ]);
  });

  it("prices ACP effort variants at the base model rate", async () => {
    const dir = await tempDir();
    seedDatabase(path.join(dir, "effort.db"), (db) => {
      createTables(db);
      for (const [idx, name] of ["gemini-4-argon-high", "gemini-4-argon"].entries()) {
        db.run("INSERT INTO gen_metadata VALUES (?, ?)", [
          idx,
          new Uint8Array(protoBytes(1, protoText(19, name))),
        ]);
        db.run("INSERT INTO steps VALUES (?, ?)", [
          idx,
          new Uint8Array(protoBytes(9, protoNumber(2, 10 + idx))),
        ]);
      }
    });
    const result = await readAntigravityUsage(dir, 0);
    expect(records(result).map(({ model, rateModel }) => [model, rateModel])).toEqual([
      ["gemini-4-argon-high", "gemini-4-argon"],
      ["gemini-4-argon", undefined],
    ]);
  });

  it("merges Antigravity aliases that bridge previously separate step records", async () => {
    const dir = await tempDir();
    seedDatabase(path.join(dir, "bridge.db"), (db) => {
      createTables(db);
      db.run("INSERT INTO steps VALUES (?, ?)", [
        0,
        new Uint8Array(protoBytes(9, [...protoNumber(2, 100), ...protoText(11, "response")])),
      ]);
      db.run("INSERT INTO steps VALUES (?, ?)", [
        1,
        new Uint8Array(protoBytes(9, [...protoNumber(3, 40), ...protoText(12, "provider")])),
      ]);
      db.run("INSERT INTO gen_metadata VALUES (?, ?)", [
        0,
        new Uint8Array(
          protoBytes(1, [
            ...protoText(19, "Gemini 3 Pro"),
            ...protoBytes(4, [
              ...protoNumber(2, 50),
              ...protoNumber(5, 20),
              ...protoText(11, "response"),
              ...protoText(12, "provider"),
            ]),
          ]),
        ),
      ]);
    });
    const result = await readAntigravityUsage(dir, 0);
    expect(result.errors).toEqual([]);
    const read = records(result);
    expect(read.length).toBe(1);
    expect(read[0]?.totals).toEqual({
      uncachedInputTokens: 100,
      cachedInputTokens: 20,
      cacheCreationTokens: 0,
      outputTokens: 40,
      reasoningTokens: 0,
    });
  });

  it("merges Antigravity provider and message aliases across configured roots while keeping original ownership", async () => {
    const dir = await tempDir();
    const roots = [path.join(dir, "first"), path.join(dir, "second")];
    for (const [index, root] of roots.entries()) {
      await fs.mkdir(root);
      seedDatabase(path.join(root, `session-${index}.db`), (db) => {
        db.exec("CREATE TABLE steps (idx INTEGER, metadata BLOB)");
        for (const identity of [7, 12]) {
          const usage = [
            ...protoNumber(1, 246),
            ...protoNumber(2, index === 0 ? 100 : 150),
            ...protoText(11, `response-${index}-${identity}`),
            ...protoText(identity, `shared-${identity}`),
          ];
          db.run("INSERT INTO steps VALUES (?, ?)", [identity, new Uint8Array(protoBytes(9, usage))]);
        }
      });
    }
    const result = await readAntigravityUsage(roots, 0);
    expect(result.errors).toEqual([]);
    expect(result.files.length).toBe(2);
    expect(result.files[0]?.root).toBe(roots[0]);
    expect(result.files[0]?.records.length).toBe(2);
    expect(result.files[1]?.records.length).toBe(0);
    expect(result.files[0]?.records.map((record) => record.totals.uncachedInputTokens)).toEqual([
      150, 150,
    ]);
    expect(result.files[0]?.records.every((record) => record.sessionId === "session-0")).toBe(true);
  });

  it("upgrades Antigravity fallback timestamps before applying the date window", async () => {
    const dir = await tempDir();
    for (const fallback of ["mtime", "trajectory"]) {
      const file = path.join(dir, `${fallback}.db`);
      seedDatabase(file, (db) => {
        createTables(db);
        if (fallback === "trajectory") {
          db.exec("CREATE TABLE trajectory_metadata_blob (data BLOB)");
          db.run("INSERT INTO trajectory_metadata_blob VALUES (?)", [
            new Uint8Array(protoBytes(2, protoNumber(1, 1780000200))),
          ]);
        }
        for (const [index, seconds] of [1780000000, 1780000200].entries()) {
          const usage = [...protoNumber(2, 10), ...protoText(11, `${fallback}-${index}`)];
          db.run("INSERT INTO steps VALUES (?, ?)", [index, new Uint8Array(protoBytes(9, usage))]);
          db.run("INSERT INTO gen_metadata VALUES (?, ?)", [
            index,
            new Uint8Array(
              protoBytes(1, [
                ...protoBytes(4, usage),
                ...protoBytes(9, protoBytes(4, protoNumber(1, seconds))),
              ]),
            ),
          ]);
        }
      });
      await fs.utimes(file, 1780000000, 1780000000);
    }
    const result = await readAntigravityUsage(dir, 1780000100000);
    expect(result.errors).toEqual([]);
    const read = records(result);
    expect(read.length).toBe(2);
    expect(read.map((record) => record.timestampMs)).toEqual([1780000200000, 1780000200000]);
  });

  const antigravityGeneration = (responseId: string) =>
    new Uint8Array(
      protoBytes(1, [
        ...protoBytes(4, [...protoNumber(2, 100), ...protoNumber(3, 40), ...protoText(11, responseId)]),
        ...protoText(19, "Gemini 3 Pro"),
        ...protoBytes(9, protoBytes(4, protoNumber(1, 1780000000))),
      ]),
    );

  it("rereads an Antigravity database when only its WAL changed", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "session-1.db");
    const db = openDatabase(file);
    try {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA wal_autocheckpoint = 0");
      db.exec("CREATE TABLE gen_metadata (idx INTEGER, data BLOB)");
      const insert = (idx: number, responseId: string) =>
        db.run("INSERT INTO gen_metadata VALUES (?, ?)", [idx, antigravityGeneration(responseId)]);
      insert(0, "r-1");
      const cache = makeAntigravityUsageCache();
      const first = await readAntigravityUsage(dir, 0, cache);
      expect(records(first).length).toBe(1);

      const before = await fs.stat(file);
      insert(1, "r-2");
      const after = await fs.stat(file);
      expect(after.size).toBe(before.size);
      expect(after.mtimeMs).toBe(before.mtimeMs);

      const next = await readAntigravityUsage(dir, 0, cache);
      expect(records(next).map((record) => record.dedupeKey)).toEqual([
        "antigravity:11:r-1",
        "antigravity:11:r-2",
      ]);
    } finally {
      db.close();
    }
  });

  it("reads Antigravity step-only stores and reports malformed databases", async () => {
    const dir = await tempDir();
    seedDatabase(path.join(dir, "steps.db"), (db) => {
      db.exec("CREATE TABLE steps (idx INTEGER, metadata BLOB)");
      const usage = [...protoNumber(1, 246), ...protoNumber(2, 10), ...protoNumber(3, 5)];
      db.run("INSERT INTO steps VALUES (?, ?)", [
        0,
        new Uint8Array([...protoBytes(9, usage), ...protoBytes(8, protoNumber(1, 1780000000))]),
      ]);
    });
    await fs.writeFile(path.join(dir, "broken.db"), "not a sqlite database");
    const result = await readAntigravityUsage(dir, 0);
    expect(result.errors.length).toBe(1);
    expect(records(result)[0]?.model).toBe("gemini-2.5-pro");
    expect(records(result)[0]?.totals.outputTokens).toBe(5);
  });

  it("ignores large values in unused Antigravity protobuf fields", async () => {
    const dir = await tempDir();
    seedDatabase(path.join(dir, "large-varint.db"), (db) => {
      db.exec("CREATE TABLE steps (idx INTEGER, metadata BLOB)");
      const unusedField = [...protoNumber(99, 0).slice(0, -1), ...Array<number>(9).fill(0xff), 0x01];
      const usage = [...protoNumber(1, 246), ...protoNumber(2, 10), ...unusedField];
      db.run("INSERT INTO steps VALUES (?, ?)", [0, new Uint8Array(protoBytes(9, usage))]);
    });
    const result = await readAntigravityUsage(dir, 0);
    expect(result.errors).toEqual([]);
    expect(records(result)[0]?.totals.uncachedInputTokens).toBe(10);
  });

  const stepUsage = (responseId: string) =>
    new Uint8Array(protoBytes(9, [...protoNumber(2, 10), ...protoText(11, responseId)]));

  it("returns Antigravity records in idx order however the rows are stored", async () => {
    const dir = await tempDir();
    seedDatabase(path.join(dir, "session-1.db"), (db) => {
      createTables(db);
      db.exec("BEGIN");
      for (let idx = 99; idx >= 0; idx--) {
        db.run("INSERT INTO steps VALUES (?, ?)", [idx, stepUsage(`s-${idx}`)]);
      }
      for (const idx of [1, 0]) {
        db.run("INSERT INTO gen_metadata VALUES (?, ?)", [idx, antigravityGeneration(`g-${idx}`)]);
      }
      db.exec("COMMIT");
    });
    const result = await readAntigravityUsage(dir, 0);
    expect(result.errors).toEqual([]);
    expect(records(result).map((record) => record.dedupeKey)).toEqual([
      ...Array.from({ length: 100 }, (_, idx) => `antigravity:11:s-${idx}`),
      "antigravity:11:g-0",
      "antigravity:11:g-1",
    ]);
  });
});
