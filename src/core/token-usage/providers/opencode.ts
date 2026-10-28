// OpenCode 的用量：读数据目录下的 opencode*.db（message / session_message 表），
// 以及旧版的 storage/message/**/*.json。
// 移植自 T3 Code（MIT）packages/provider-opencode/src/server/usage.ts，Effect SqlClient 换成 node:sqlite。
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { totalTokens, type ProviderUsageReader, type UsageRecord } from "../types";
import { expandHomePath } from "./paths";

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function tokens(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function parseOpenCodeMessage(
  source: string,
  fallback: {
    readonly id?: string;
    readonly sessionId?: string;
    readonly timestampMs?: number;
  } = {},
): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  const message = object(parsed);
  if (message["role"] !== undefined && message["role"] !== "assistant") return null;
  const usage = object(message["tokens"]);
  const cache = object(usage["cache"]);
  const modelReference = object(message["model"]);
  const model =
    text(modelReference["id"]) || text(modelReference["modelID"]) || text(message["modelID"]);
  const timestampMs = object(message["time"])["created"] ?? fallback.timestampMs;
  if (!model || typeof timestampMs !== "number" || !Number.isFinite(timestampMs)) return null;
  const reasoningTokens = tokens(usage["reasoning"]);
  const totals = {
    uncachedInputTokens: tokens(usage["input"]),
    cachedInputTokens: tokens(cache["read"]),
    cacheCreationTokens: tokens(cache["write"]),
    outputTokens: tokens(usage["output"]) + reasoningTokens,
    reasoningTokens,
  };
  if (totalTokens(totals) === 0) return null;
  const id = fallback.id || text(message["id"]);
  const cost = message["cost"];
  return {
    provider: "opencode",
    timestampMs,
    model,
    sessionId: fallback.sessionId || text(message["sessionID"]),
    totals,
    // OpenCode 不知道价格时记 0，订阅也是 0；交给共用价格表估算
    reportedCostUsd: typeof cost === "number" && Number.isFinite(cost) && cost > 0 ? cost : null,
    speed: "standard",
    dedupeKey: id ? `opencode:${id}` : null,
  };
}

export interface OpenCodeUsageReadResult {
  readonly files: readonly { readonly path: string; readonly records: readonly UsageRecord[] }[];
  readonly missing: boolean;
  readonly error: boolean;
}

const MESSAGE_PAGE_SIZE = 64;
// 分批 stat，避免超大目录一次性占用内存
const LEGACY_STAT_BATCH = 256;

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

async function isSymbolicLink(entry: string): Promise<boolean> {
  return fs.lstat(entry).then(
    (info) => info.isSymbolicLink(),
    () => false,
  );
}

/** 读一个数据库里在窗口内的助手消息；读不了返回 false */
function readDatabase(
  file: string,
  sinceMs: number,
  append: (record: UsageRecord | null) => void,
): boolean {
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(file, { readOnly: true });
  } catch {
    return false;
  }
  try {
    // 遇到正在写入的锁马上失败，不卡住
    database.exec("PRAGMA busy_timeout = 100");
    const tables = new Set(
      (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: unknown;
      }[]).map((row) => row.name),
    );
    const ok = tables.has("message") || tables.has("session_message");
    for (const table of ["message", "session_message"] as const) {
      if (!tables.has(table)) continue;
      const columns = new Set(
        (database.prepare(`PRAGMA table_info(${table})`).all() as { name: unknown }[]).map(
          (row) => row.name,
        ),
      );
      const timestamp = columns.has("time_created") ? "time_created" : "NULL";
      const predicates = table === "session_message" ? ["type = 'assistant'"] : [];
      if (timestamp !== "NULL") predicates.push("time_created >= ?");
      predicates.push("rowid > ?", "rowid <= ?");
      const range = database
        .prepare(
          `SELECT (SELECT MIN(rowid) FROM ${table}) AS first_row_id, (SELECT MAX(rowid) FROM ${table}) AS last_row_id`,
        )
        .get() as { first_row_id: unknown; last_row_id: unknown } | undefined;
      const firstRowId = range?.first_row_id;
      const lastRowId = range?.last_row_id;
      if (typeof firstRowId !== "number" || typeof lastRowId !== "number") continue;
      const page = database.prepare(
        `SELECT id, session_id, data, ${timestamp} AS created
         FROM ${table} WHERE ${predicates.join(" AND ")} ORDER BY rowid`,
      );
      // all() 会一次取出全部结果；按 rowid 分页，并排除扫描过程中新追加的行
      for (let after = firstRowId - 1; after < lastRowId; after += MESSAGE_PAGE_SIZE) {
        const rows = page.all(
          ...(timestamp === "NULL" ? [] : [sinceMs]),
          after,
          Math.min(after + MESSAGE_PAGE_SIZE, lastRowId),
        ) as { id: unknown; session_id: unknown; data: unknown; created: unknown }[];
        for (const row of rows) {
          append(
            parseOpenCodeMessage(text(row.data), {
              id: text(row.id),
              sessionId: text(row.session_id),
              ...(typeof row.created === "number" ? { timestampMs: row.created } : {}),
            }),
          );
        }
      }
    }
    return ok;
  } catch {
    return false;
  } finally {
    database.close();
  }
}

export async function readOpenCodeUsage(
  root: string,
  sinceMs: number,
): Promise<OpenCodeUsageReadResult> {
  const files: { path: string; records: UsageRecord[] }[] = [];
  const seen = new Set<string>();
  let found = false;
  let error = false;
  const appendTo = (records: UsageRecord[]) => (record: UsageRecord | null) => {
    if (record === null || record.timestampMs < sinceMs) return;
    if (record.dedupeKey !== null) {
      if (seen.has(record.dedupeKey)) return;
      seen.add(record.dedupeKey);
    }
    records.push(record);
  };

  let names: string[] = [];
  try {
    names = await fs.readdir(root);
  } catch (cause) {
    if (!isNotFound(cause)) error = true;
  }
  const databases: string[] = [];
  for (const name of names.filter((entry) => /^opencode(?:-[a-zA-Z0-9_-]+)?\.db$/.test(entry))) {
    const info = await fs.lstat(path.join(root, name)).catch(() => null);
    if (info?.isFile()) databases.push(name);
  }
  databases.sort((a, b) => (a === "opencode.db" ? -1 : b === "opencode.db" ? 1 : a.localeCompare(b)));
  for (const name of databases) {
    found = true;
    const file = { path: path.join(root, name), records: [] as UsageRecord[] };
    files.push(file);
    if (!readDatabase(file.path, sinceMs, appendTo(file.records))) error = true;
  }

  const directories = [path.join(root, "storage", "message")];
  while (directories.length > 0) {
    const directory = directories.pop()!;
    let entries: string[];
    try {
      entries = await fs.readdir(directory);
    } catch (cause) {
      if (!isNotFound(cause)) error = true;
      continue;
    }
    for (let start = 0; start < entries.length; start += LEGACY_STAT_BATCH) {
      const batch = entries.slice(start, start + LEGACY_STAT_BATCH);
      const infos = await Promise.all(
        batch.map((name) => fs.stat(path.join(directory, name)).catch(() => null)),
      );
      for (const [index, name] of batch.entries()) {
        const entry = path.join(directory, name);
        const info = infos[index];
        if (info?.isDirectory()) {
          if (!(await isSymbolicLink(entry))) directories.push(entry);
        } else if (info?.isFile() && name.endsWith(".json")) {
          const id = name.slice(0, -5);
          // 消息时间不会晚于文件修改时间；更早的文件里没有窗口内的用量
          const skip = seen.has(`opencode:${id}`) || info.mtimeMs < sinceMs;
          if (found && skip) continue;
          if (await isSymbolicLink(entry)) continue;
          found = true;
          if (skip) continue;
          const file = { path: entry, records: [] as UsageRecord[] };
          files.push(file);
          try {
            appendTo(file.records)(parseOpenCodeMessage(await fs.readFile(entry, "utf8"), { id }));
          } catch (cause) {
            if (!isNotFound(cause)) error = true;
          }
        }
      }
    }
  }
  return { files, missing: !found && !error, error };
}

async function resolveOpenCodeDataDirs(
  homeDir: string,
  environment: NodeJS.ProcessEnv,
): Promise<string[]> {
  const roots = environment["OPENCODE_DATA_DIR"]
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const dataHome = environment["XDG_DATA_HOME"]?.trim();
  const defaults = [
    path.join(
      dataHome && path.isAbsolute(dataHome) ? dataHome : path.join(homeDir, ".local", "share"),
      "opencode",
    ),
  ];
  const canonical = new Set<string>();
  for (const root of roots?.length ? roots : defaults) {
    const resolved = path.resolve(expandHomePath(root, homeDir));
    canonical.add(await fs.realpath(resolved).catch(() => resolved));
  }
  return [...canonical];
}

export const openCodeUsageReader: ProviderUsageReader = {
  kind: "scan",
  provider: "opencode",
  scan: async ({ homeDir, environment }, { windowStartMs }) => {
    const roots = await resolveOpenCodeDataDirs(homeDir, environment);
    return Promise.all(
      roots.map(async (dir) => {
        const result = await readOpenCodeUsage(dir, windowStartMs);
        return {
          dir,
          files: result.missing && !result.error ? null : result.files,
          status: result.error ? ("partial" as const) : ("ok" as const),
          ...(result.error ? { message: "部分 OpenCode 历史读取失败。" } : {}),
        };
      }),
    );
  },
};
