import fs from "node:fs/promises";
import path from "node:path";
import type { AccountIdentity, SavedAccount } from "../shared/types";
import { AUTH_FILE } from "./credentials";
import type { Env } from "./env";
import { copyFileAtomic, pathExists, writeFileAtomic } from "./fs-utils";

/** 跟着账号走的 Factory 文件：凭证本身，加上按组织缓存的管理设置 */
export const ACCOUNT_FILES = [
  AUTH_FILE,
  "org-managed-settings.cache.json",
  "org-managed-settings.cache.json.backup",
] as const;

const META_FILE = "meta.json";

/** 账号在备份目录里的文件夹名，由用户 ID 和组织 ID 决定 */
export function accountIdFor(
  identity: Pick<AccountIdentity, "userId" | "orgId">,
): string {
  return `${identity.userId}__${identity.orgId}`.replace(
    /[^A-Za-z0-9_-]/g,
    "_",
  );
}

const accountsDir = (env: Env) => path.join(env.vaultDir, "accounts");
const accountDir = (env: Env, id: string) => path.join(accountsDir(env), id);

/** 新建一个本次操作专用的备份目录，名字带时间和操作类型 */
export async function createBackupDir(
  env: Env,
  operation: string,
): Promise<string> {
  const stamp = new Date(env.now()).toISOString().replace(/[:.]/g, "-");
  const dir = path.join(env.vaultDir, "backups", `${stamp}-${operation}`);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** 列出所有已备份的账号，按备份时间排序 */
export async function listAccounts(env: Env): Promise<SavedAccount[]> {
  if (!(await pathExists(accountsDir(env)))) {
    return [];
  }
  const entries = await fs.readdir(accountsDir(env), { withFileTypes: true });
  const accounts: SavedAccount[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    // 缺 meta 或 meta 坏掉的目录不当作账号，避免整个列表打不开
    const meta = await readMeta(env, entry.name).catch(() => null);
    if (meta) {
      accounts.push(meta);
    }
  }
  return accounts.sort((a, b) => a.savedAt - b.savedAt);
}

async function readMeta(env: Env, id: string): Promise<SavedAccount> {
  const raw = await fs.readFile(
    path.join(accountDir(env, id), META_FILE),
    "utf8",
  );
  return JSON.parse(raw) as SavedAccount;
}

async function writeMeta(env: Env, account: SavedAccount): Promise<void> {
  await writeFileAtomic(
    path.join(accountDir(env, account.id), META_FILE),
    JSON.stringify(account, null, 2),
  );
}

/** 按 ID 查找已备份账号，找不到返回 null */
export async function findAccount(
  env: Env,
  id: string,
): Promise<SavedAccount | null> {
  const accounts = await listAccounts(env);
  return accounts.find((account) => account.id === id) ?? null;
}

/** 把 Factory 当前的凭证保存为某个账号的备份；authContent 是调用方已校验过身份的凭证内容 */
export async function saveAccount(
  env: Env,
  identity: AccountIdentity,
  authContent: string,
  label: string | null,
): Promise<SavedAccount> {
  const id = accountIdFor(identity);
  const existing = await findAccount(env, id);
  const dir = accountDir(env, id);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });

  // 1. 凭证写入校验时读到的那份内容，避免读和写之间 Factory 刷新了文件
  await writeFileAtomic(path.join(dir, AUTH_FILE), authContent);

  // 2. 其余跟账号走的文件有就复制，没有就删掉旧备份里的，保持和当前一致
  for (const file of ACCOUNT_FILES) {
    if (file === AUTH_FILE) {
      continue;
    }
    const source = path.join(env.factoryDir, file);
    if (await pathExists(source)) {
      await copyFileAtomic(source, path.join(dir, file));
    } else {
      await fs.rm(path.join(dir, file), { force: true });
    }
  }

  // 3. 更新 meta；已有账号没传名字就沿用原来的名字
  const account: SavedAccount = {
    ...identity,
    id,
    label:
      label?.trim() || existing?.label || identity.email || identity.userId,
    savedAt: env.now(),
    lastUsedAt: existing?.lastUsedAt ?? env.now(),
  };
  await writeMeta(env, account);
  return account;
}

/** 把某个备份账号的文件写回 Factory 目录 */
export async function restoreAccountFiles(env: Env, id: string): Promise<void> {
  const dir = accountDir(env, id);
  // 凭证最后写：前面任何一步失败，Factory 里仍是原来的账号或没有凭证，不会出现半个账号
  const ordered = [
    ...ACCOUNT_FILES.filter((file) => file !== AUTH_FILE),
    AUTH_FILE,
  ];
  for (const file of ordered) {
    const source = path.join(dir, file);
    const target = path.join(env.factoryDir, file);
    if (await pathExists(source)) {
      await copyFileAtomic(source, target);
    } else {
      await fs.rm(target, { force: true });
    }
  }
}

/** 读取备份账号里的凭证内容 */
export async function readSavedAuth(env: Env, id: string): Promise<string> {
  return fs.readFile(path.join(accountDir(env, id), AUTH_FILE), "utf8");
}

/** 记录账号最近一次被切换使用的时间 */
export async function markUsed(env: Env, id: string): Promise<void> {
  const account = await readMeta(env, id);
  await writeMeta(env, { ...account, lastUsedAt: env.now() });
}

/** 修改账号显示名 */
export async function renameAccount(
  env: Env,
  id: string,
  label: string,
): Promise<void> {
  const account = await readMeta(env, id);
  const trimmed = label.trim();
  if (!trimmed) {
    throw new Error("名字不能为空");
  }
  await writeMeta(env, { ...account, label: trimmed });
}

/** 删除备份账号：整个目录移进备份区而不是直接删，误删还能找回 */
export async function removeAccount(env: Env, id: string): Promise<void> {
  const backupDir = await createBackupDir(env, "remove-account");
  await fs.rename(accountDir(env, id), path.join(backupDir, id));
}
