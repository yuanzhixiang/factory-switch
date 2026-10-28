// token 统计服务：找到各家日志目录、增量扫描、计价、聚合，结果和价格表都缓存到磁盘。
// 移植自 T3 Code（MIT）apps/server/src/usage/UsageService.ts，Effect 改写成普通 async 代码，逻辑保持一致。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  USAGE_CONTRACT_VERSION,
  type TokenUsageSettings,
  type UsagePricing,
  type UsageProviderKind,
  type UsageSource,
  type UsageSummary,
  type UsageSummaryInput,
} from "../../shared/token-usage";
import { writeFileAtomic } from "../fs-utils";
import { resolveModelAliases, UsageAggregator } from "./aggregation";
import { createOverrideRateTable, parseRateTable, type RateTable } from "./pricing";
import { BUILT_IN_USAGE_READERS } from "./providers";
import {
  decodeScanCache,
  dedupeWithinFile,
  LEGACY_SCAN_CACHE_FILE_NAMES,
  makeScanCacheWriter,
  pruneScanCache,
  SCAN_CACHE_FILE_NAME,
  type CachedFile,
  type ScanCache,
} from "./scan-cache";
import {
  listTranscriptFiles,
  readDirectoryVolumeId,
  readTranscriptRecords,
} from "./transcript-reader";
import type {
  ProviderUsageReader,
  TranscriptUsageFormat,
  UsageReaderEnv,
  UsageRecord,
  UsageSpeed,
} from "./types";

const LITELLM_RATES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const LITELLM_RATES_API_URL =
  "https://api.github.com/repos/BerriAI/litellm/contents/model_prices_and_context_window.json?ref=main";

const RATES_TTL_MS = 24 * 60 * 60 * 1000;

const RATES_REFRESH_FLOOR_MS = 60 * 1000;

const RATES_FETCH_TIMEOUT_MS = 10_000;

// 修改时间放宽 36 小时，覆盖窗口第一天本地午夜前写入的记录
const MTIME_SLACK_MS = 36 * 60 * 60 * 1000;
const MAX_HOURLY_WINDOW_MS = 24 * 60 * 60 * 1000;

const CACHE_RETENTION_DAYS = 92;

const TRANSCRIPT_READ_CONCURRENCY = 4;

type TranscriptReader = Extract<ProviderUsageReader, { kind: "transcripts" }>;
type ScanReader = Extract<ProviderUsageReader, { kind: "scan" }>;

interface TranscriptSource {
  readonly provider: UsageProviderKind;
  readonly format: TranscriptUsageFormat<unknown>;
  readonly dir: string;
  readonly volumeId: string;
  readonly fileName?: string;
}

interface CachedSource {
  readonly dir: string;
  readonly volumeId: string;
}

interface ScannedDir {
  readonly provider: UsageProviderKind;
  readonly dir: string;
  readonly volumeId: string;
  readonly hostId?: string;
  readonly status?: UsageSource["status"];
  readonly message?: string;
  readonly action?: UsageSource["action"];
  readonly files:
    | readonly {
        readonly path: string;
        readonly records: readonly UsageRecord[];
        readonly malformedRecords: number;
      }[]
    | null;
  readonly refreshing?: true;
}

export class UsageReadError extends Error {
  constructor(
    readonly reason: "scanFailed" | "invalidWindow",
    readonly detail: string,
  ) {
    super(`读取用量失败（${reason}）：${detail}`);
  }
}

export interface UsageServiceOptions {
  /** 价格表和扫描缓存存放目录 */
  readonly stateDir: string;
  readonly readerEnv: UsageReaderEnv;
  readonly readSettings: () => Promise<TokenUsageSettings>;
  readonly httpFetch: typeof fetch;
  readonly now?: () => number;
  /** 测试时替换提供方 */
  readonly readers?: readonly ProviderUsageReader[];
}

export interface UsageService {
  readSummary(input: UsageSummaryInput): Promise<UsageSummary>;
  refreshRates(): Promise<UsagePricing>;
  /** 等待后台写缓存完成，测试和退出前用 */
  awaitPersisted(): Promise<void>;
}

function isLaterRead(a: CachedFile, b: CachedFile): boolean {
  return a.mtimeMs > b.mtimeMs || (a.mtimeMs === b.mtimeMs && a.size > b.size);
}

/** 简单的互斥锁，代替 Effect 的 Semaphore(1) */
function makeLock(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (task) => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}

/** 按顺序保留结果、最多 concurrency 个同时进行 */
async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function isValidDay(day: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(`${day}T00:00:00Z`));
}

export function createUsageService(options: UsageServiceOptions): UsageService {
  const now = options.now ?? (() => Date.now());
  const readers = options.readers ?? BUILT_IN_USAGE_READERS;
  const transcriptReaders = readers.filter(
    (reader): reader is TranscriptReader => reader.kind === "transcripts",
  );
  const scanReaders = readers.filter((reader): reader is ScanReader => reader.kind === "scan");
  const transcriptFormats = new Map(
    transcriptReaders.map((reader) => [reader.provider, reader.format] as const),
  );
  const sharedSessionProviders: ReadonlySet<UsageProviderKind> = new Set(
    transcriptReaders.flatMap((reader) =>
      reader.format.sharedSessionsAcrossFiles ? [reader.provider] : [],
    ),
  );

  // 只有跨文件共享会话的提供方需要跨文件去重；其余按文件内出现次数就能区分
  const sharedSessions = (
    files: readonly { readonly records: readonly UsageRecord[] }[],
  ): ReadonlySet<string> => {
    const firstFile = new Map<string, number>();
    const shared = new Set<string>();
    for (const [index, file] of files.entries()) {
      let previous = "";
      for (const { provider, sessionId } of file.records) {
        if (
          !sharedSessionProviders.has(provider) ||
          sessionId === previous ||
          sessionId.length === 0
        )
          continue;
        previous = sessionId;
        const first = firstFile.get(sessionId);
        if (first === undefined) firstFile.set(sessionId, index);
        else if (first !== index) shared.add(sessionId);
      }
    }
    return shared;
  };

  const fileCache: ScanCache = new Map();
  // 并发窗口里的读取可能还拿着修正前的原始记录
  const resolvedRecords = new WeakMap<UsageRecord, UsageRecord>();
  const correctedRecord = (record: UsageRecord) => resolvedRecords.get(record) ?? record;
  const correctedBatch = (records: readonly UsageRecord[]) =>
    records.some((record) => resolvedRecords.has(record)) ? records.map(correctedRecord) : records;
  const sourceCache = new Map<string, CachedSource>();
  let cacheDirty = false;
  const isWithinDirectory = (filePath: string, dir: string) => {
    const relative = path.relative(dir, filePath);
    return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
  };

  const ratesCachePath = path.join(options.stateDir, "usage-model-rates.json");
  const scanCachePath = path.join(options.stateDir, SCAN_CACHE_FILE_NAME);
  const writeCacheFile = async (filePath: string, contents: string) => {
    await fs.mkdir(options.stateDir, { recursive: true });
    await writeFileAtomic(filePath, contents);
  };
  let rates: RateTable = new Map();
  let ratesFetchedAtMs: number | null = null;
  let ratesLastFailedAtMs: number | null = null;
  let ratesStatus: UsagePricing["status"] = "unavailable";
  const ratesLock = makeLock();

  const pricing = (): UsagePricing => ({
    status: ratesStatus,
    source: LITELLM_RATES_URL,
    fetchedAt: ratesFetchedAtMs === null ? null : new Date(ratesFetchedAtMs).toISOString(),
    knownModels: rates.size,
  });

  const fetchRates = async (url: string, accept = "application/json") => {
    try {
      const response = await options.httpFetch(url, {
        headers: { accept },
        signal: AbortSignal.timeout(RATES_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) return null;
      const document: unknown = await response.json();
      const parsed = parseRateTable(document);
      return parsed.size > 0 ? { document, parsed } : null;
    } catch {
      return null;
    }
  };

  const loadRates = async (force: boolean) => {
    const startedAtMs = now();
    const maxAgeMs = force ? RATES_REFRESH_FLOOR_MS : RATES_TTL_MS;
    if (ratesFetchedAtMs !== null && startedAtMs - ratesFetchedAtMs < maxAgeMs) return;

    if (ratesFetchedAtMs === null) {
      const fromDisk = await fs
        .readFile(ratesCachePath, "utf8")
        .then((raw) => JSON.parse(raw) as unknown)
        .catch(() => null);
      if (
        typeof fromDisk === "object" &&
        fromDisk !== null &&
        typeof (fromDisk as { fetchedAtMs?: unknown }).fetchedAtMs === "number"
      ) {
        const cached = fromDisk as { fetchedAtMs: number; document: unknown };
        const parsed = parseRateTable(cached.document);
        if (parsed.size > 0) {
          rates = parsed;
          ratesFetchedAtMs = cached.fetchedAtMs;
          ratesStatus = "cached";
          if (startedAtMs - cached.fetchedAtMs < maxAgeMs) return;
        }
      }
    }

    if (ratesLastFailedAtMs !== null && startedAtMs - ratesLastFailedAtMs < RATES_REFRESH_FLOOR_MS)
      return;

    let fetched = await fetchRates(LITELLM_RATES_URL);
    if (fetched === null) {
      fetched = await fetchRates(LITELLM_RATES_API_URL, "application/vnd.github.raw+json");
    }
    if (fetched === null) {
      ratesLastFailedAtMs = now();
      if (rates.size > 0) ratesStatus = "cached";
      return;
    }

    rates = fetched.parsed;
    ratesFetchedAtMs = startedAtMs;
    ratesLastFailedAtMs = null;
    ratesStatus = "fresh";

    await writeCacheFile(
      ratesCachePath,
      JSON.stringify({ fetchedAtMs: startedAtMs, document: fetched.document }),
    ).catch(() => undefined);
  };

  const ensureRates = (force: boolean) => ratesLock(() => loadRates(force));

  const refreshRates = async () => {
    await ensureRates(true);
    return pricing();
  };

  const resolveTranscriptDirs = async (retentionCutoffMs: number) => {
    const dirs: TranscriptSource[] = [];
    const seen = new Set<string>();
    for (const reader of transcriptReaders) {
      const { provider, format } = reader;
      const directories = await reader.directories(options.readerEnv);
      for (const { dir: directory, fileName } of directories) {
        const sourceKey = provider + "\0" + directory;
        const previous = sourceCache.get(sourceKey);
        const dir = await fs.realpath(directory).catch(() => previous?.dir ?? directory);
        const currentVolumeId = await readDirectoryVolumeId(dir);
        const hasRetainedHistory = [...fileCache.entries()].some(
          ([filePath, entry]) =>
            entry.provider === provider &&
            entry.mtimeMs >= retentionCutoffMs &&
            (entry.records.length + entry.tailRecords.length > 0 || entry.malformedRecords > 0) &&
            isWithinDirectory(filePath, dir),
        );
        const volumeId =
          previous?.dir === dir && (hasRetainedHistory || !currentVolumeId)
            ? previous.volumeId || currentVolumeId
            : currentVolumeId;
        if (previous?.dir !== dir || previous.volumeId !== volumeId) {
          sourceCache.set(sourceKey, { dir, volumeId });
          cacheDirty = true;
        }
        const key = `${provider}\0${dir}`;
        if (seen.has(key)) continue;
        seen.add(key);
        dirs.push({
          provider,
          format,
          dir,
          volumeId,
          ...(fileName === undefined ? {} : { fileName }),
        });
      }
    }
    return dirs;
  };

  // 首次加载共用一个 Promise，避免并发读取在空缓存上各扫一遍
  let scanCacheLoaded: Promise<void> | null = null;
  const ensureScanCacheLoaded = () => {
    scanCacheLoaded ??= (async () => {
      const readDocument = (filePath: string) =>
        fs
          .readFile(filePath, "utf8")
          .then((raw) => JSON.parse(raw) as unknown)
          .catch(() => null);
      let document = await readDocument(scanCachePath);
      for (const fileName of LEGACY_SCAN_CACHE_FILE_NAMES) {
        if (document !== null) break;
        document = await readDocument(path.join(options.stateDir, fileName));
        cacheDirty = document !== null;
      }
      if (document === null) return;
      for (const [filePath, entry] of decodeScanCache(document, transcriptFormats)) {
        fileCache.set(filePath, entry);
      }
      const sources = (document as { sources?: unknown }).sources;
      if (typeof sources === "object" && sources !== null) {
        for (const [key, source] of Object.entries(sources)) {
          if (
            typeof source === "object" &&
            source !== null &&
            typeof (source as CachedSource).dir === "string" &&
            typeof (source as CachedSource).volumeId === "string"
          ) {
            sourceCache.set(key, source as CachedSource);
          }
        }
      }
    })();
    return scanCacheLoaded;
  };

  const writeScanCache = makeScanCacheWriter();
  // 写缓存串行，避免较早结束的扫描覆盖较新的快照
  const persistLock = makeLock();

  // 编码前先清掉 dirty，期间的新改动会重新置位；失败时恢复以便重试
  const persistCaches = () =>
    persistLock(async () => {
      if (!cacheDirty) return;
      cacheDirty = false;
      try {
        const contents = writeScanCache(fileCache, { sources: Object.fromEntries(sourceCache) });
        await writeCacheFile(scanCachePath, contents);
      } catch {
        cacheDirty = true;
      }
    });

  const pendingPersists = new Set<Promise<void>>();
  const schedulePersist = () => {
    const pending = persistCaches();
    pendingPersists.add(pending);
    void pending.finally(() => pendingPersists.delete(pending));
  };
  const awaitPersisted = async () => {
    await Promise.all([...pendingPersists]);
  };

  /**
   * 文件并发读取，但调用方按遍历顺序而不是完成顺序写回缓存：
   * 已删除日志的保存记录按缓存顺序聚合，重复记录以第一份为准。
   */
  const readFileRecords = async (
    filePath: string,
    size: number,
    mtimeMs: number,
    provider: UsageProviderKind,
    format: TranscriptUsageFormat<unknown>,
  ): Promise<{
    readonly records: readonly UsageRecord[];
    readonly malformedRecords: number;
    readonly failed?: true;
    readonly update?: { readonly entry: CachedFile; readonly replaces: CachedFile | undefined };
  }> => {
    const cached = fileCache.get(filePath);
    // 提供方也是缓存身份的一部分：两家指向同一目录时，不能复用另一家解析的结果
    if (
      cached &&
      cached.size === size &&
      cached.mtimeMs === mtimeMs &&
      cached.provider === provider
    ) {
      return {
        records:
          cached.tailRecords.length === 0
            ? cached.records
            : [...cached.records, ...cached.tailRecords],
        malformedRecords: cached.malformedRecords,
      };
    }

    // 只有严格变大的文件可以续读；大小相同但修改时间变了或变小，说明内容被改写，整篇重读
    const resumeFrom =
      cached !== undefined && cached.provider === provider && size > cached.size
        ? cached.position
        : undefined;

    const parsed = await readTranscriptRecords(filePath, format, resumeFrom);
    // 读取失败不等于空日志：按这个大小和修改时间缓存成空，会在文件变化前一直丢失用量
    if (parsed === null)
      return {
        records: cached?.provider === provider ? [...cached.records, ...cached.tailRecords] : [],
        malformedRecords: cached?.provider === provider ? cached.malformedRecords : 0,
        failed: true,
      };

    if (parsed.resumed && cached !== undefined && cached.tailRecords.length > 0) {
      // 续读会重新解析之前的暂定末行。只有产出同样的用量时才沿用之前的档位修正，
      // 推断出的档位不放进解析状态
      const reparsed = [...parsed.records, ...parsed.tailRecords];
      const identity = (record: UsageRecord) =>
        JSON.stringify([
          record.provider,
          record.sessionId,
          record.timestampMs,
          record.model,
          record.rateModel,
          record.totals,
          record.reportedCostUsd,
          record.dedupeKey,
        ]);
      for (const [index, previous] of cached.tailRecords.entries()) {
        const record = reparsed[index];
        const corrected = correctedRecord(previous);
        if (
          record?.unresolvedServiceTierTurnId !== undefined &&
          corrected.unresolvedServiceTierTurnId === undefined &&
          identity(record) === identity(corrected)
        ) {
          resolvedRecords.set(record, corrected);
        }
      }
    }
    const base = parsed.resumed && cached !== undefined ? cached.records : [];
    const seen = new Set<string>();
    const records = dedupeWithinFile([...base, ...parsed.records], seen);
    const tailRecords = dedupeWithinFile(parsed.tailRecords, seen);

    return {
      records: tailRecords.length === 0 ? records : [...records, ...tailRecords],
      malformedRecords: parsed.malformedRecords,
      update: {
        entry: {
          size,
          mtimeMs,
          provider,
          records,
          tailRecords,
          malformedRecords: parsed.malformedRecords,
          position: parsed.position,
        },
        replaces: cached,
      },
    };
  };

  const scanTranscriptDir = async (
    source: TranscriptSource,
    windowStartMs: number,
  ): Promise<ScannedDir> => {
    const { provider, format, dir, volumeId, fileName } = source;
    const exists = await fs.stat(dir).then(
      () => true,
      () => false,
    );
    if (!exists) return { provider, dir, volumeId, files: null };
    const { files, failedPaths } = await listTranscriptFiles(
      dir,
      windowStartMs,
      fileName === undefined ? undefined : { fileName },
    );
    const read = await mapConcurrent(files, TRANSCRIPT_READ_CONCURRENCY, async (file) => ({
      path: file.path,
      ...(await readFileRecords(file.path, file.size, file.mtimeMs, provider, format)),
    }));
    const parsedFiles = read.map(({ path: filePath, records, malformedRecords, update }) => {
      if (update === undefined) return { path: filePath, records, malformedRecords };
      // 另一个时间窗口的扫描可能已缓存了这个文件；保留看到更新版本的那次，
      // 慢的扫描不能用旧用量覆盖新的
      const current = fileCache.get(filePath);
      if (
        current === update.replaces ||
        current === undefined ||
        isLaterRead(update.entry, current)
      ) {
        fileCache.set(filePath, {
          ...update.entry,
          records: correctedBatch(update.entry.records),
          tailRecords: correctedBatch(update.entry.tailRecords),
        });
        cacheDirty = true;
      }
      return { path: filePath, records, malformedRecords };
    });
    const unread = failedPaths + read.filter((file) => file.failed).length;
    return {
      provider,
      dir,
      volumeId,
      files: parsedFiles,
      ...(unread > 0
        ? {
            status: "partial" as const,
            message: `${unread} 个日志路径读取失败，用量可能不完整。`,
          }
        : {}),
    };
  };

  const collectDirs = async (
    windowStartMs: number,
    retentionCutoffMs: number,
    awaitRefresh: boolean,
  ): Promise<readonly ScannedDir[]> => {
    const dirs = await resolveTranscriptDirs(retentionCutoffMs);

    const scans = Promise.all(
      scanReaders.map(async (reader) => {
        const sources = await reader.scan(options.readerEnv, {
          windowStartMs,
          retentionCutoffMs,
          awaitRefresh,
        });
        return Promise.all(
          sources.map(async ({ volumeId, ...source }): Promise<ScannedDir> => ({
            ...source,
            files: source.files?.map((file) => ({ ...file, malformedRecords: 0 })) ?? null,
            provider: reader.provider,
            volumeId: volumeId ?? (await readDirectoryVolumeId(source.dir)),
          })),
        );
      }),
    );

    // 不同数据源并行扫描；目录之间顺序扫描以限制打开的文件数，并保持「先见到的优先」的去重顺序
    const transcriptsTask = (async () => {
      const results: ScannedDir[] = [];
      for (const dir of dirs) results.push(await scanTranscriptDir(dir, windowStartMs));
      return results;
    })();
    const [transcripts, scanDirs] = await Promise.all([transcriptsTask, scans]);
    return [...transcripts, ...scanDirs.flat()];
  };

  const scanSummary = async (
    input: UsageSummaryInput,
    settings: TokenUsageSettings,
  ): Promise<UsageSummary> => {
    if (!isValidDay(input.sinceDay) || !isValidDay(input.untilDay)) {
      throw new UsageReadError("invalidWindow", "日期格式不是 YYYY-MM-DD");
    }
    if (input.sinceDay > input.untilDay) {
      throw new UsageReadError(
        "invalidWindow",
        `sinceDay '${input.sinceDay}' 晚于 untilDay '${input.untilDay}'`,
      );
    }

    let hourlyWindow: { readonly sinceTimeMs: number; readonly untilTimeMs: number } | null = null;
    if (input.resolution === "hour") {
      const sinceTimeMs = input.sinceTime === undefined ? NaN : Date.parse(input.sinceTime);
      const untilTimeMs = input.untilTime === undefined ? NaN : Date.parse(input.untilTime);
      if (Number.isNaN(sinceTimeMs) || Number.isNaN(untilTimeMs)) {
        throw new UsageReadError("invalidWindow", "按小时统计需要有效的 sinceTime 和 untilTime");
      }
      const durationMs = untilTimeMs - sinceTimeMs;
      if (durationMs <= 0 || durationMs > MAX_HOURLY_WINDOW_MS) {
        throw new UsageReadError("invalidWindow", "按小时统计的时间窗口必须大于 0 且不超过 24 小时");
      }
      hourlyWindow = { sinceTimeMs, untilTimeMs };
    }

    const startedAtMs = now();
    await ensureScanCacheLoaded();

    const hostId = os.hostname();
    const windowStartMs =
      (hourlyWindow?.sinceTimeMs ?? Date.parse(`${input.sinceDay}T00:00:00Z`)) - MTIME_SLACK_MS;

    const retentionCutoffMs = startedAtMs - CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

    const [, scannedDirs] = await Promise.all([
      ensureRates(false),
      collectDirs(windowStartMs, retentionCutoffMs, input.awaitRefresh === true),
    ]);

    const aggregator = new UsageAggregator({
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      resolution: input.resolution ?? "day",
      ...hourlyWindow,
      rates,
      priceOverrides: createOverrideRateTable(settings.usagePriceOverrides),
      modelAliases: resolveModelAliases(settings.usageModelAliases),
    });

    const sources: UsageSource[] = [];

    // 已删除日志的保存用量照常参与聚合和去重
    const retainedSinceMs = Math.max(windowStartMs, retentionCutoffMs);
    const filesByDir = scannedDirs.map(({ provider, dir, files }) => {
      const retainedFiles = [...(files ?? [])];
      const livePaths = new Set(retainedFiles.map((file) => file.path));
      for (const [filePath, entry] of fileCache) {
        if (
          entry.provider !== provider ||
          entry.mtimeMs < retainedSinceMs ||
          livePaths.has(filePath) ||
          !isWithinDirectory(filePath, dir)
        )
          continue;
        retainedFiles.push({
          path: filePath,
          records: [...entry.records, ...entry.tailRecords],
          malformedRecords: entry.malformedRecords,
        });
      }
      return retainedFiles;
    });
    const windowEndMs =
      hourlyWindow?.untilTimeMs ??
      Date.parse(`${input.untilDay}T00:00:00Z`) + 86400000 + MTIME_SLACK_MS;
    let resolvedAny = false;
    for (const reader of transcriptReaders) {
      if (reader.resolveServiceTiers === undefined) continue;
      const pending = new Set<UsageRecord>();
      for (const [index, files] of filesByDir.entries()) {
        if (scannedDirs[index]?.provider !== reader.provider) continue;
        for (const file of files) {
          for (const raw of file.records) {
            const record = correctedRecord(raw);
            if (
              record.provider === reader.provider &&
              record.unresolvedServiceTierTurnId !== undefined &&
              record.timestampMs >= windowStartMs &&
              record.timestampMs < windowEndMs
            ) {
              pending.add(record);
            }
          }
        }
      }
      if (pending.size === 0) continue;
      const resolved: ReadonlyMap<UsageRecord, UsageSpeed> = await reader
        .resolveServiceTiers([...pending])
        .catch(() => new Map<UsageRecord, UsageSpeed>());
      for (const [record, speed] of resolved) {
        const corrected: { -readonly [K in keyof UsageRecord]: UsageRecord[K] } = { ...record, speed };
        delete corrected.unresolvedServiceTierTurnId;
        resolvedRecords.set(record, corrected);
        resolvedAny = true;
      }
    }
    if (resolvedAny) {
      for (const [filePath, entry] of fileCache) {
        const records = correctedBatch(entry.records);
        const tailRecords = correctedBatch(entry.tailRecords);
        if (records === entry.records && tailRecords === entry.tailRecords) continue;
        // 按对象身份更新当前条目；慢的修正不能恢复旧版本的文件
        fileCache.set(filePath, { ...entry, records, tailRecords });
        cacheDirty = true;
      }
    }
    const crossFileSessions = sharedSessions(filesByDir.flat());

    for (const [
      index,
      { provider, dir, volumeId, files, status, message, action, refreshing, hostId: sourceHostId },
    ] of scannedDirs.entries()) {
      let scannedFiles = 0;
      let skippedFiles = 0;
      let malformedRecords = 0;
      // 按目录去重的会话数。bucket 上也有会话数，但会话跨天跨模型，页面合计要用这个
      const sessionIds = new Set<string>();

      for (const file of filesByDir[index] ?? []) {
        malformedRecords += file.malformedRecords;
        if (file.records.length === 0) {
          skippedFiles += 1;
          continue;
        }
        scannedFiles += 1;
        const eventOccurrences = new Map<string, number>();
        for (const rawRecord of file.records) {
          const record = correctedRecord(rawRecord);
          let usageRecord = record;
          if (
            sharedSessionProviders.has(record.provider) &&
            crossFileSessions.has(record.sessionId)
          ) {
            // 去掉移动产生的副本，但保留同一文件内重复的相同事件（包括秒级时间戳相同的）
            const key = JSON.stringify([
              record.provider,
              record.sessionId,
              record.timestampMs,
              record.model,
              record.totals,
            ]);
            const occurrence = (eventOccurrences.get(key) ?? 0) + 1;
            eventOccurrences.set(key, occurrence);
            usageRecord = { ...record, dedupeKey: key + ":" + occurrence };
          }
          if (aggregator.add(usageRecord, dir) && record.sessionId.length > 0) {
            sessionIds.add(record.sessionId);
          }
        }
      }

      const sourceMessage = message ?? (files === null ? "本机没有这个日志目录。" : null);
      sources.push({
        fingerprint: { hostId: sourceHostId ?? hostId, provider, resolvedHomePath: dir, volumeId },
        status:
          files === null && scannedFiles === 0
            ? "missing"
            : malformedRecords > 0
              ? status === undefined || status === "ok"
                ? "partial"
                : status
              : (status ?? "ok"),
        scannedFiles,
        skippedFiles,
        malformedRecords,
        distinctSessions: sessionIds.size,
        message:
          malformedRecords > 0
            ? [
                sourceMessage,
                `跳过了 ${malformedRecords} 条格式有误或不一致的用量记录，用量可能不完整。`,
              ]
                .filter(Boolean)
                .join(" ")
            : sourceMessage,
        ...(action ? { action } : {}),
        ...(refreshing ? { refreshing } : {}),
      });
    }

    const pruned = pruneScanCache(fileCache, retentionCutoffMs);
    if (pruned > 0) cacheDirty = true;

    const aggregated = aggregator.finish();
    const finishedAtMs = now();

    return {
      contractVersion: USAGE_CONTRACT_VERSION,
      readAt: new Date(finishedAtMs).toISOString(),
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      buckets: aggregated.buckets,
      sources,
      pricing: pricing(),
      scanDurationMs: Math.max(0, finishedAtMs - startedAtMs),
    };
  };

  const inflightScans = new Map<string, Promise<UsageSummary>>();

  const scanKey = (input: UsageSummaryInput, settings: TokenUsageSettings): string =>
    JSON.stringify([
      input.timeZone,
      input.sinceDay,
      input.untilDay,
      input.resolution ?? "day",
      input.sinceTime ?? null,
      input.untilTime ?? null,
      settings,
      input.awaitRefresh === true,
    ]);

  const readSummary = async (input: UsageSummaryInput): Promise<UsageSummary> => {
    let settings: TokenUsageSettings;
    try {
      settings = await options.readSettings();
    } catch (error) {
      throw new UsageReadError("scanFailed", `读取设置失败：${(error as Error).message}`);
    }
    const key = scanKey(input, settings);
    const existing = inflightScans.get(key);
    if (existing !== undefined) return existing;

    // 相同参数的并发请求共用一次扫描；扫描成功后再在后台写缓存
    const created = scanSummary(input, settings).finally(() => inflightScans.delete(key));
    inflightScans.set(key, created);
    void created.then(schedulePersist, () => undefined);
    return created;
  };

  return { readSummary, refreshRates, awaitPersisted };
}
