import fs from "node:fs/promises";
import path from "node:path";
import type { AccountIdentity, AppState, CurrentStatus } from "../shared/types";
import {
  AUTH_FILE,
  decryptCredentials,
  identityFromCredentials,
  sameAccount,
} from "./credentials";
import type { Env } from "./env";
import { moveIntoBackup } from "./fs-utils";
import { resetAccountCaches, stripSessionOrgTags } from "./sessions";
import {
  ACCOUNT_FILES,
  accountIdFor,
  createBackupDir,
  findAccount,
  listAccounts,
  listApiKeyHints,
  markUsed,
  readSavedAuth,
  restoreAccountFiles,
  saveAccount,
} from "./vault";

// Factory 有进行中的会话时退出会慢一些，给足时间
const QUIT_TIMEOUT_MS = 20_000;

/** 用户能看懂的操作失败，界面直接展示 message */
export class SwitchError extends Error {}

interface CurrentCredentials {
  identity: AccountIdentity;
  /** 校验身份时读到的原始文件内容，保存时直接用它 */
  content: string;
}

/** 读取 Factory 当前的凭证和身份；本地没有凭证时返回 null */
async function readCurrentCredentials(
  env: Env,
): Promise<CurrentCredentials | null> {
  let content: string;
  try {
    content = await fs.readFile(path.join(env.factoryDir, AUTH_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const key = await env.readEncryptionKey();
  return {
    identity: identityFromCredentials(decryptCredentials(content, key)),
    content,
  };
}

/** 汇总界面需要的全部状态 */
export async function getState(env: Env): Promise<AppState> {
  const accounts = await listAccounts(env);
  let current: CurrentStatus;
  try {
    const credentials = await readCurrentCredentials(env);
    if (credentials) {
      const id = accountIdFor(credentials.identity);
      current = {
        kind: "signed-in",
        identity: credentials.identity,
        accountId: id,
        savedAccountId: accounts.some((account) => account.id === id)
          ? id
          : null,
      };
    } else {
      current = { kind: "signed-out" };
    }
  } catch (error) {
    current = { kind: "unreadable", message: (error as Error).message };
  }
  return {
    current,
    accounts,
    apiKeyHints: await listApiKeyHints(env, accounts),
    factoryRunning: await env.factory.isRunning(),
  };
}

/** 读取当前登录账号的 access token 和账号 ID，用来查用量；没登录或读不出时返回 null */
export async function readCurrentAccessToken(
  env: Env,
): Promise<{ accountId: string; accessToken: string } | null> {
  let content: string;
  try {
    content = await fs.readFile(path.join(env.factoryDir, AUTH_FILE), "utf8");
  } catch {
    return null;
  }
  const credentials = decryptCredentials(
    content,
    await env.readEncryptionKey(),
  ) as { access_token?: unknown };
  if (typeof credentials.access_token !== "string") {
    return null;
  }
  return {
    accountId: accountIdFor(identityFromCredentials(credentials)),
    accessToken: credentials.access_token,
  };
}

/** 备份当前登录的账号；已备份过的账号会覆盖更新，label 为空时沿用原名 */
export async function backupCurrent(
  env: Env,
  label: string | null,
): Promise<string> {
  const credentials = await readCurrentCredentials(env);
  if (!credentials) {
    throw new SwitchError("本地没有登录凭证，请先在 Factory 里登录");
  }
  const existing = await findAccount(env, accountIdFor(credentials.identity));
  if (!existing && !label?.trim()) {
    throw new SwitchError("第一次备份这个账号，需要先起个名字");
  }
  const account = await saveAccount(
    env,
    credentials.identity,
    credentials.content,
    label,
  );
  return `已备份「${account.label}」`;
}

/** 终端里还有 droid 在跑时不能切换，它会继续用旧 token 并可能写回凭证 */
async function ensureNoCliDroid(env: Env): Promise<void> {
  const others = await env.factory.listOtherDroidProcesses();
  if (others.length > 0) {
    throw new SwitchError(
      `终端里还有 droid 在运行，请先关掉：\n${others.join("\n")}`,
    );
  }
}

/** 退出 Factory 并等主进程和 daemon 都退出 */
async function quitFactory(env: Env): Promise<void> {
  env.report("正在退出 Factory…");
  if (!(await env.factory.quit(QUIT_TIMEOUT_MS))) {
    throw new SwitchError(
      "Factory 没有在 20 秒内退出，请手动退出（Cmd+Q）后重试",
    );
  }
}

/** 退出 Factory 后，把当前账号的最新凭证存回它的备份；当前账号没备份过时返回 false */
async function refreshCurrentBackup(env: Env): Promise<boolean> {
  const credentials = await readCurrentCredentials(env);
  if (!credentials) {
    return true;
  }
  const existing = await findAccount(env, accountIdFor(credentials.identity));
  if (!existing) {
    return false;
  }
  await saveAccount(env, credentials.identity, credentials.content, null);
  env.report(`已更新「${existing.label}」的备份`);
  return true;
}

/** 去掉会话组织标记并清掉账号相关缓存，让换号后左侧会话仍然可见 */
async function prepareSessions(env: Env, backupDir: string): Promise<void> {
  env.report("正在处理会话的组织标记…");
  const changed = await stripSessionOrgTags(env, backupDir);
  await resetAccountCaches(env, backupDir);
  env.report(`已处理 ${changed} 个会话，会话索引会在 Factory 启动时重建`);
}

/** 删除本地凭证，好让 Factory 回到登录页登录新账号；凭证移进备份区而不是直接删 */
export async function deleteLocalCredentials(env: Env): Promise<string> {
  // 1. 先检查再退出，避免白白关掉 Factory
  await ensureNoCliDroid(env);
  await quitFactory(env);

  // 2. 已备份的账号先更新备份，确保拿到退出前最后一次刷新的 token
  await refreshCurrentBackup(env);

  // 3. 凭证和组织缓存移进本次操作的备份目录，没备份过的账号也还能找回
  const backupDir = await createBackupDir(env, "delete-credentials");
  for (const file of ACCOUNT_FILES) {
    await moveIntoBackup(path.join(env.factoryDir, file), backupDir, file);
  }
  await prepareSessions(env, backupDir);

  // 4. 重新打开 Factory，进入登录页
  env.report("正在打开 Factory…");
  await env.factory.open();
  return "本地凭证已删除，请在 Factory 里登录新账号，然后回来点「备份当前账号」";
}

/** 切换到某个已备份的账号 */
export async function switchTo(env: Env, accountId: string): Promise<string> {
  const target = await findAccount(env, accountId);
  if (!target) {
    throw new SwitchError("找不到这个备份账号");
  }
  // 1. 先检查备份能解开、身份对得上，坏备份不值得关掉 Factory
  const key = await env.readEncryptionKey();
  const targetIdentity = identityFromCredentials(
    decryptCredentials(await readSavedAuth(env, accountId), key),
  );
  if (!sameAccount(targetIdentity, target)) {
    throw new SwitchError("备份里的凭证和账号信息对不上，请重新备份这个账号");
  }
  const current = await readCurrentCredentials(env);
  if (current && sameAccount(current.identity, target)) {
    return `当前已经是「${target.label}」`;
  }
  if (current && !(await findAccount(env, accountIdFor(current.identity)))) {
    throw new SwitchError(
      "当前登录的账号还没有备份，请先点「备份当前账号」再切换",
    );
  }
  await ensureNoCliDroid(env);

  // 2. 退出 Factory，并把当前账号最新的凭证存回备份，防止 token 刷新后旧备份失效
  await quitFactory(env);
  if (!(await refreshCurrentBackup(env))) {
    throw new SwitchError(
      "当前登录的账号还没有备份，请先备份；Factory 已退出，可手动重新打开",
    );
  }

  // 3. 处理会话，再换入目标账号的凭证
  const backupDir = await createBackupDir(env, "switch");
  await prepareSessions(env, backupDir);
  env.report(`正在换入「${target.label}」的凭证…`);
  await restoreAccountFiles(env, accountId);
  await markUsed(env, accountId);

  // 4. 重新打开 Factory
  env.report("正在打开 Factory…");
  await env.factory.open();
  return `已切换到「${target.label}」`;
}
