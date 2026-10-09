import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Factory 通过 /usr/bin/security 写入的钥匙串条目，用来加密 auth.v2.loginkeychain
const KEYCHAIN_SERVICE = "Factory CLI";
const KEYCHAIN_ACCOUNT = "auth-encryption-key-security-cli";

/** 从 macOS 钥匙串读出 Factory 加密凭证用的 32 字节密钥 */
export async function readKeychainEncryptionKey(): Promise<Buffer> {
  const { stdout } = await execFileAsync("/usr/bin/security", [
    "find-generic-password",
    "-s",
    KEYCHAIN_SERVICE,
    "-a",
    KEYCHAIN_ACCOUNT,
    "-w",
  ]);
  const key = Buffer.from(stdout.trim(), "base64");
  // 密钥格式不对说明 Factory 改了存储方式，宁可报错也不要乱解
  if (key.length !== 32) {
    throw new Error("钥匙串里的 Factory 密钥格式不是预期的 32 字节");
  }
  return key;
}
