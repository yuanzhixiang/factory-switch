// Antigravity 的用量：读 Antigravity CLI / ACP 会话目录里的 .db（gen_metadata / steps 表中的 protobuf）。
// 移植自 T3 Code（MIT）apps/server/src/provider/Drivers/antigravityUsageReader.ts 与 AntigravityUsage.ts，
// Effect SqlClient 换成 node:sqlite。T3 另外会读它自己管理的 Antigravity 登录目录，本程序没有这个目录。
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ProviderUsageReader, ProviderUsageScan, UsageRecord } from "../types";
import { expandHomePath } from "./paths";

type FieldValue = number | bigint | Uint8Array;
type Fields = Map<number, FieldValue[]>;

function fields(bytes: Uint8Array): Fields {
  let offset = 0;
  const result: Fields = new Map();
  const varint = () => {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      const byte = bytes[offset++];
      if (byte === undefined || (shift === 63n && byte > 1)) {
        throw new Error("Invalid Antigravity protobuf varint");
      }
      value |= BigInt(byte & 127) << shift;
      if (byte < 128) {
        return value > BigInt(Number.MAX_SAFE_INTEGER) ? value : Number(value);
      }
    }
    throw new Error("Invalid Antigravity protobuf varint");
  };
  while (offset < bytes.length) {
    const tag = varint();
    if (typeof tag !== "number") throw new Error("Invalid protobuf field");
    const number = Math.floor(tag / 8);
    const wire = tag % 8;
    if (number === 0) throw new Error("Invalid protobuf field");
    let value: FieldValue;
    if (wire === 0) {
      value = varint();
    } else if (wire === 1 || wire === 5 || wire === 2) {
      const length = wire === 2 ? varint() : wire === 1 ? 8 : 4;
      if (typeof length !== "number") throw new Error("Invalid protobuf field length");
      if (length > bytes.length - offset) throw new Error("Truncated protobuf field");
      value = bytes.subarray(offset, offset + length);
      offset += length;
      if (wire !== 2) continue;
    } else {
      throw new Error("Unsupported protobuf wire type");
    }
    const entries = result.get(number) ?? [];
    entries.push(value);
    result.set(number, entries);
  }
  return result;
}

const numberAt = (value: Fields, key: number) => {
  const entry = value.get(key)?.[0];
  return typeof entry === "number" ? entry : 0;
};
const bytesAt = (value: Fields, key: number) => {
  const entry = value.get(key)?.[0];
  return entry instanceof Uint8Array ? entry : undefined;
};
const nested = (value: Fields, key: number) => {
  const bytes = bytesAt(value, key);
  return bytes === undefined ? new Map<number, FieldValue[]>() : fields(bytes);
};
const textAt = (value: Fields, key: number) => {
  const bytes = bytesAt(value, key);
  return bytes === undefined ? "" : new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
};
const timestamp = (value: Fields) => {
  const seconds = numberAt(value, 1);
  return seconds > 0 ? seconds * 1000 + Math.floor(numberAt(value, 2) / 1_000_000) : null;
};

const MODEL_IDS: Record<number, string> = {
  246: "gemini-2.5-pro",
  312: "gemini-2.5-flash",
  313: "gemini-2.5-flash-thinking",
  329: "gemini-2.5-flash-thinking",
  330: "gemini-2.5-flash-lite",
  281: "claude-sonnet-4",
  282: "claude-sonnet-4",
  290: "claude-opus-4",
  291: "claude-opus-4",
  333: "claude-sonnet-4-5",
  334: "claude-sonnet-4-5",
  340: "claude-haiku-4-5",
  341: "claude-haiku-4-5",
  1026: "claude-opus-4-6",
  1035: "claude-sonnet-4-6",
  1016: "gemini-3.1-pro",
  1036: "gemini-3.1-pro",
  1037: "gemini-3.1-pro",
  1018: "gemini-3-flash-preview",
  1084: "gemini-3-flash-preview",
  1047: "gemini-3-flash-preview",
};

// ACP 的模型名带思考档位后缀，价格和基础模型一样
function withRateModel(record: UsageRecord): UsageRecord {
  const rateModel = record.model.replace(/-(?:low|medium|high)$/, "");
  return rateModel === record.model ? record : { ...record, rateModel };
}

function modelName(name: string, id: number): string {
  if (name) {
    const normalized = name
      .toLowerCase()
      .replace(/\s*\([^)]*\)\s*$/, "")
      .replaceAll(" ", "-");
    if (normalized.startsWith("claude-")) {
      return normalized
        .replace(/^claude-(4(?:\.\d+)?)-(sonnet|opus|haiku)/, "claude-$2-$1")
        .replaceAll(".", "-");
    }
    return normalized;
  }
  return MODEL_IDS[id] ?? (id > 0 ? `antigravity-model-${id}` : "");
}

interface Metadata {
  model: string;
  timestampMs: number | null;
  usages: Fields[];
}

function metadata(bytes: Uint8Array, step: boolean): Metadata {
  const root = fields(bytes);
  if (!step && bytesAt(root, 1) === undefined) {
    throw new Error("Missing Antigravity generation metadata");
  }
  const data = step ? root : nested(root, 1);
  const model = step ? nested(data, 24) : data;
  const usage = bytesAt(data, step ? 9 : 4);
  // 复制 usage 字节：保留 subarray 会让整行 blob 一直占着内存
  const usages = usage === undefined ? [] : [fields(usage.slice())];
  for (const retry of data.get(step ? 28 : 17) ?? []) {
    if (!(retry instanceof Uint8Array)) throw new Error("Invalid retry metadata");
    const retryUsage = bytesAt(fields(retry), 2);
    if (retryUsage !== undefined) usages.push(fields(retryUsage.slice()));
  }
  return {
    model: modelName(
      textAt(model, step ? 12 : 19) || textAt(model, step ? 8 : 21),
      numberAt(model, step ? 1 : 3),
    ),
    timestampMs: step
      ? (timestamp(nested(data, 8)) ?? timestamp(nested(data, 1)))
      : timestamp(nested(nested(data, 9), 4)),
    usages,
  };
}

function blob(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error("Invalid Antigravity metadata blob");
  return value;
}

interface UsageCandidate {
  record: UsageRecord;
  keys: readonly string[];
  timestampQuality: number;
}

class AntigravityDatabaseDecodeError extends Error {
  constructor(readonly file: string) {
    super(`无法解析 Antigravity 用量：${file}`);
  }
}

/** 生成记录可能有好几 MB 上下文，一次只读一行，限制单次 all() 的阻塞时间 */
const GENERATION_PAGE_ROWS = 1;
const STEP_PAGE_ROWS = 64;

function readDatabase(
  file: string,
  sessionId: string,
  fallbackTimestamp: number,
): UsageCandidate[] {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    database.exec("PRAGMA busy_timeout = 100");
    // 在一个读事务里读完，保证几张表看到的是同一时刻的数据
    database.exec("BEGIN");
    try {
      const tables = new Set(
        (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: unknown;
        }[]).map((row) => row.name),
      );
      if (!tables.has("gen_metadata") && !tables.has("steps")) {
        throw new AntigravityDatabaseDecodeError(file);
      }
      // 不依赖索引，按 rowid 翻页；idx 通常就是 rowid，但不是时也按 idx 排序
      const readMetadata = (query: string, pageRows: number, step: boolean) => {
        const entries: Array<{ idx: number; entry: Metadata }> = [];
        const statement = database.prepare(query);
        let after = -Infinity;
        while (true) {
          const rows = statement.all(after, pageRows) as {
            row_id: number;
            idx: unknown;
            data: unknown;
          }[];
          for (const row of rows) {
            // 在 SQL 外过滤，保证每次只扫一页，包括没有元数据的行
            if (step && row.data === null) continue;
            if (typeof row.idx !== "number") throw new AntigravityDatabaseDecodeError(file);
            entries.push({ idx: row.idx, entry: metadata(blob(row.data), step) });
          }
          if (rows.length < pageRows) break;
          after = rows[rows.length - 1]!.row_id;
        }
        return entries.sort((a, b) => a.idx - b.idx);
      };
      const generations = tables.has("gen_metadata")
        ? readMetadata(
            "SELECT rowid AS row_id, idx, data FROM gen_metadata WHERE rowid > ? ORDER BY rowid LIMIT ?",
            GENERATION_PAGE_ROWS,
            false,
          )
        : [];
      let trajectoryTimestamp: number | null = null;
      if (tables.has("trajectory_metadata_blob")) {
        for (const row of database.prepare("SELECT data FROM trajectory_metadata_blob").all() as {
          data: unknown;
        }[]) {
          trajectoryTimestamp ??= timestamp(nested(fields(blob(row.data)), 2));
        }
      }
      const steps = tables.has("steps")
        ? readMetadata(
            "SELECT rowid AS row_id, idx, metadata AS data FROM steps WHERE rowid > ? ORDER BY rowid LIMIT ?",
            STEP_PAGE_ROWS,
            true,
          )
        : [];
      return usageCandidates(sessionId, generations, steps, trajectoryTimestamp, fallbackTimestamp);
    } finally {
      database.exec("COMMIT");
    }
  } finally {
    database.close();
  }
}

function usageCandidates(
  sessionId: string,
  generations: ReadonlyArray<{ idx: number; entry: Metadata }>,
  steps: ReadonlyArray<{ idx: number; entry: Metadata }>,
  trajectoryTimestamp: number | null,
  fallbackTimestamp: number,
): UsageCandidate[] {
  const records: UsageCandidate[] = [];
  const generationModels = new Map(generations.map(({ idx, entry }) => [idx, entry.model]));
  for (const [source, entries] of [
    ["step", steps],
    ["generation", generations],
  ] as const) {
    for (const [index, { idx, entry }] of entries.entries()) {
      for (const [usageIndex, usage] of entry.usages.entries()) {
        const outputTokens = Math.max(numberAt(usage, 3), numberAt(usage, 9) + numberAt(usage, 10));
        const totals = {
          uncachedInputTokens: numberAt(usage, 2),
          cachedInputTokens: numberAt(usage, 5),
          cacheCreationTokens: numberAt(usage, 4),
          outputTokens,
          reasoningTokens: Math.min(outputTokens, numberAt(usage, 9)),
        };
        if (
          totals.uncachedInputTokens +
            totals.cachedInputTokens +
            totals.cacheCreationTokens +
            outputTokens ===
          0
        )
          continue;
        const keys = ([11, 12, 7] as const).flatMap((key) => {
          const id = textAt(usage, key);
          return id ? [`antigravity:${key}:${id}`] : [];
        });
        const record: UsageRecord = {
          provider: "antigravity",
          sessionId,
          timestampMs: entry.timestampMs ?? trajectoryTimestamp ?? fallbackTimestamp,
          model:
            MODEL_IDS[numberAt(usage, 1)] ||
            entry.model ||
            (source === "step" ? generationModels.get(idx) : "") ||
            modelName("", numberAt(usage, 1)) ||
            "antigravity-unknown",
          totals,
          reportedCostUsd: null,
          speed: "standard",
          dedupeKey: keys[0] ?? `antigravity:${sessionId}:${source}:${index}:${usageIndex}`,
        };
        records.push({
          record,
          keys,
          timestampQuality: entry.timestampMs !== null ? 2 : trajectoryTimestamp !== null ? 1 : 0,
        });
      }
    }
  }
  return records;
}

interface CachedDatabase {
  readonly fingerprint: string;
  readonly candidates: readonly UsageCandidate[];
}

/** 用数据库和 WAL 的大小、mtime、ctime 做指纹；WAL 里有新行，ctime 能发现被还原的 mtime */
export const makeAntigravityUsageCache = () => new Map<string, CachedDatabase>();

export async function readAntigravityUsage(
  conversationsDirectories: string | readonly string[],
  sinceMs: number,
  cache?: Map<string, CachedDatabase>,
): Promise<{
  readonly files: Array<{ root: string; path: string; records: UsageRecord[] }>;
  readonly errors: string[];
}> {
  const roots =
    typeof conversationsDirectories === "string"
      ? [conversationsDirectories]
      : conversationsDirectories;
  const files: Array<{ root: string; path: string; records: UsageRecord[] }> = [];
  const errors: string[] = [];
  const identities = new Map<string, number>();
  const groups: Array<
    UsageCandidate & { parent: number; size: number; owner: number; fileIndex: number }
  > = [];
  const find = (index: number): number => {
    let root = index;
    while (groups[root]!.parent !== root) root = groups[root]!.parent;
    while (index !== root) {
      const parent = groups[index]!.parent;
      groups[index]!.parent = root;
      index = parent;
    }
    return root;
  };
  const merge = (left: number, right: number): number => {
    let a = find(left);
    let b = find(right);
    if (a === b) return a;
    if (groups[a]!.size < groups[b]!.size) [a, b] = [b, a];
    const target = groups[a]!;
    const source = groups[b]!;
    const first = target.owner < source.owner ? target : source;
    const bestTime =
      source.timestampQuality > target.timestampQuality ||
      (source.timestampQuality === target.timestampQuality &&
        source.record.timestampMs < target.record.timestampMs)
        ? source
        : target;
    const x = target.record.totals;
    const y = source.record.totals;
    target.record = {
      ...first.record,
      model:
        first.record.model === "antigravity-unknown"
          ? first === target
            ? source.record.model
            : target.record.model
          : first.record.model,
      timestampMs: bestTime.record.timestampMs,
      totals: {
        uncachedInputTokens: Math.max(x.uncachedInputTokens, y.uncachedInputTokens),
        cachedInputTokens: Math.max(x.cachedInputTokens, y.cachedInputTokens),
        cacheCreationTokens: Math.max(x.cacheCreationTokens, y.cacheCreationTokens),
        outputTokens: Math.max(x.outputTokens, y.outputTokens),
        reasoningTokens: Math.max(x.reasoningTokens, y.reasoningTokens),
      },
    };
    target.timestampQuality = bestTime.timestampQuality;
    target.owner = first.owner;
    target.fileIndex = first.fileIndex;
    target.size += source.size;
    source.parent = a;
    return a;
  };
  const append = (candidate: UsageCandidate, fileIndex: number) => {
    const index = groups.length;
    groups.push({ ...candidate, parent: index, size: 1, owner: index, fileIndex });
    for (const key of candidate.keys) {
      const existing = identities.get(key);
      if (existing !== undefined) merge(index, existing);
      identities.set(key, index);
    }
  };
  const visited = new Set<string>();
  const readFile = async (file: string): Promise<readonly UsageCandidate[] | null> => {
    const canonical = await fs.realpath(file);
    if (visited.has(canonical)) return null;
    visited.add(canonical);
    const stat = await fs.stat(file);
    const part = (info: { size: number; mtimeMs: number; ctimeMs: number }) =>
      `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    const wal = await fs.stat(`${file}-wal`).catch(() => null);
    const fingerprint = `${part(stat)}/${wal ? part(wal) : "-"}`;
    const cached = cache?.get(canonical);
    if (cached?.fingerprint === fingerprint) return cached.candidates;
    const candidates = readDatabase(file, path.basename(file, ".db"), stat.mtimeMs);
    cache?.set(canonical, { fingerprint, candidates });
    return candidates;
  };
  const walk = async (directory: string, root: string): Promise<void> => {
    let names: string[];
    try {
      names = await fs.readdir(directory);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") errors.push(directory);
      return;
    }
    names.sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      const entry = path.join(directory, name);
      // 和目录列表的类型一致：符号链接既不当文件也不当目录
      const link = await fs.lstat(entry).catch(() => null);
      const type = link?.isSymbolicLink()
        ? "SymbolicLink"
        : await fs.stat(entry).then(
            (info) => (info.isDirectory() ? "Directory" : info.isFile() ? "File" : "Other"),
            () => null,
          );
      if (type === "Directory") {
        await walk(entry, root);
      } else if ((type === "File" || type === null) && name.endsWith(".db")) {
        let candidates: readonly UsageCandidate[] | null;
        try {
          candidates = await readFile(entry);
        } catch {
          errors.push(entry);
          continue;
        }
        if (candidates === null) continue;
        const fileIndex = files.length;
        files.push({ root, path: entry, records: [] });
        for (const candidate of candidates) append(candidate, fileIndex);
      }
    }
  };
  for (const root of roots) await walk(root, root);
  if (cache !== undefined) {
    for (const key of cache.keys()) if (!visited.has(key)) cache.delete(key);
  }
  for (const [index, group] of groups.entries()) {
    if (group.parent === index && group.record.timestampMs >= sinceMs) {
      files[group.fileIndex]!.records.push(withRateModel(group.record));
    }
  }
  return { files, errors };
}

/** 对应 T3 AntigravityUsage.dataRoots：默认的几个 ~/.gemini 目录，或 ANTIGRAVITY_DATA_DIR */
async function dataRoots(homeDir: string, environment: NodeJS.ProcessEnv): Promise<string[]> {
  const configured = environment["ANTIGRAVITY_DATA_DIR"]
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const defaults = [
    ...["antigravity", "antigravity-cli", "antigravity-ide", "antigravity-backup"].map((name) =>
      path.join(homeDir, ".gemini", name),
    ),
    path.join(homeDir, ".config", "antigravity"),
  ];
  const canonical = new Set<string>();
  for (const root of configured?.length ? configured : defaults) {
    const resolved = path.resolve(expandHomePath(root, homeDir));
    canonical.add(await fs.realpath(resolved).catch(() => resolved));
  }
  return [...canonical];
}

const usageCache = makeAntigravityUsageCache();

export const antigravityUsageReader: ProviderUsageReader = {
  kind: "scan",
  provider: "antigravity",
  scan: async ({ homeDir, environment }, { windowStartMs }) => {
    const conversationDirs = new Set<string>();
    for (const root of await dataRoots(homeDir, environment)) {
      const resolvedRoot = await fs.realpath(root).catch(() => root);
      const nestedDir = path.join(resolvedRoot, "conversations");
      const dir = (await fs.stat(nestedDir).then(
        () => true,
        () => false,
      ))
        ? nestedDir
        : resolvedRoot;
      conversationDirs.add(await fs.realpath(dir).catch(() => dir));
    }
    const result = await readAntigravityUsage([...conversationDirs], windowStartMs, usageCache);
    const scanned: ProviderUsageScan[] = [];
    for (const dir of conversationDirs) {
      const exists = await fs.stat(dir).then(
        () => true,
        () => false,
      );
      const failed = result.errors.some(
        (error) => error === dir || error.startsWith(`${dir}${path.sep}`),
      );
      scanned.push({
        dir,
        files: !exists && !failed ? null : result.files.filter((file) => file.root === dir),
        status: failed ? "partial" : "ok",
        ...(failed ? { message: "部分 Antigravity 历史读取失败。" } : {}),
      });
    }
    return scanned;
  },
};
