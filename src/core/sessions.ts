import fs from "node:fs/promises";
import path from "node:path";
import type { Env } from "./env";
import { moveIntoBackup, pathExists, writeFileAtomic } from "./fs-utils";

/** 递归找出 sessions 目录下所有会话记录文件 */
async function listSessionFiles(dir: string): Promise<string[]> {
  if (!(await pathExists(dir))) {
    return [];
  }
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSessionFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(full);
    }
  }
  return files;
}

/** 去掉单个会话文件首行的组织标记；没有标记或不是会话文件时返回 null */
export function stripOrgFromTranscript(content: Buffer): Buffer | null {
  const newline = content.indexOf(0x0a);
  const firstLine = (
    newline === -1 ? content : content.subarray(0, newline)
  ).toString("utf8");
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(firstLine) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (header.type !== "session_start" || !("organizationId" in header)) {
    return null;
  }
  delete header.organizationId;
  const rest = newline === -1 ? Buffer.alloc(0) : content.subarray(newline);
  return Buffer.concat([Buffer.from(JSON.stringify(header), "utf8"), rest]);
}

/**
 * 去掉所有会话的组织标记，让任何账号登录后左侧都能看到。
 * 改之前把原文件备份到 backupDir，返回改动的文件数。
 */
export async function stripSessionOrgTags(
  env: Env,
  backupDir: string,
): Promise<number> {
  const sessionsDir = path.join(env.factoryDir, "sessions");
  let changed = 0;
  for (const file of await listSessionFiles(sessionsDir)) {
    const original = await fs.readFile(file);
    const stripped = stripOrgFromTranscript(original);
    if (!stripped) {
      continue;
    }
    // 1. 原文件先备份，出问题可以原样放回
    const backupPath = path.join(
      backupDir,
      "sessions",
      path.relative(sessionsDir, file),
    );
    await fs.mkdir(path.dirname(backupPath), { recursive: true });
    await fs.writeFile(backupPath, original, { mode: 0o600 });

    // 2. 写回去掉标记的内容，并恢复原来的修改时间，左侧列表按它排序
    const stat = await fs.stat(file);
    await writeFileAtomic(file, stripped, stat.mode & 0o777);
    await fs.utimes(file, stat.atime, stat.mtime);
    changed += 1;
  }
  return changed;
}

// 会话索引更新时新值为空会保留旧的组织 ID，所以只改会话文件不够，要让索引整个重建
const SESSION_INDEX_FILES = ["index.db", "index.db-wal", "index.db-shm"];

// 和登录账号绑定、Factory 启动时会重新拉取的缓存
const ACCOUNT_CACHE_PATHS = ["feature-flags.json", "connector-tool-catalogs"];

/** 把会话索引和账号相关缓存移进备份目录，Factory 下次启动会重新生成 */
export async function resetAccountCaches(
  env: Env,
  backupDir: string,
): Promise<void> {
  const cacheDir = path.join(env.factoryDir, "cache");
  for (const file of SESSION_INDEX_FILES) {
    await moveIntoBackup(
      path.join(cacheDir, "session-index", file),
      backupDir,
      path.join("cache", "session-index", file),
    );
  }
  for (const entry of ACCOUNT_CACHE_PATHS) {
    await moveIntoBackup(
      path.join(cacheDir, entry),
      backupDir,
      path.join("cache", entry),
    );
  }
}
