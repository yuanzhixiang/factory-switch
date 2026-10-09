import os from "node:os";
import path from "node:path";
import { readKeychainEncryptionKey } from "./keychain";
import { macFactoryProcess, type FactoryProcess } from "./factory-process";

/** 核心逻辑依赖的外部环境，测试时整体替换成临时目录和假进程 */
export interface Env {
  /** Factory 的数据目录，默认 ~/.factory */
  factoryDir: string;
  /** 本程序保存账号备份的目录，默认 ~/.factory-switch */
  vaultDir: string;
  /** 读取解密凭证文件用的 AES 密钥 */
  readEncryptionKey(): Promise<Buffer>;
  factory: FactoryProcess;
  now(): number;
  /** 进度回调，界面上显示每一步 */
  report(message: string): void;
}

/** 真实运行环境 */
export function createDefaultEnv(report: (message: string) => void): Env {
  const home = os.homedir();
  return {
    factoryDir: path.join(home, ".factory"),
    vaultDir: path.join(home, ".factory-switch"),
    readEncryptionKey: readKeychainEncryptionKey,
    factory: macFactoryProcess,
    now: () => Date.now(),
    report,
  };
}
