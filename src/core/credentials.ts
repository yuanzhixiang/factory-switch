import crypto from "node:crypto";
import fs from "node:fs/promises";
import type { AccountIdentity } from "../shared/types";

/** Factory 的加密凭证文件名，桌面版和命令行共用 */
export const AUTH_FILE = "auth.v2.loginkeychain";

/** 解密凭证文件内容，返回明文 JSON（格式为 iv:tag:密文，AES-256-GCM） */
export function decryptCredentials(fileContent: string, key: Buffer): unknown {
  const parts = fileContent.trim().split(":");
  if (parts.length !== 3) {
    throw new Error("凭证文件格式不是 iv:tag:密文");
  }
  const [iv, tag, data] = parts.map((part) => Buffer.from(part, "base64")) as [
    Buffer,
    Buffer,
    Buffer,
  ];
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([
    decipher.update(data),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(plain);
}

/** 用同样的格式加密凭证明文，只给测试造数据用 */
export function encryptCredentials(payload: unknown, key: Buffer): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${tag.toString("base64")}:${data.toString("base64")}`;
}

/** 解析 JWT 的 payload 段，不校验签名，只用来读身份 */
function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (!payload) {
    throw new Error("access_token 不是 JWT");
  }
  return JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
}

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/** 从解密后的凭证里提取账号身份 */
export function identityFromCredentials(credentials: unknown): AccountIdentity {
  const record = (credentials ?? {}) as Record<string, unknown>;
  const accessToken = asString(record.access_token);
  if (!accessToken) {
    throw new Error("凭证里没有 access_token");
  }
  const claims = decodeJwtPayload(accessToken);
  const userId = asString(claims.sub) ?? asString(claims.id);
  // Factory 的组织 ID 是 active_organization_id，JWT 里的 external_org_id 是同一个值
  const orgId =
    asString(record.active_organization_id) ?? asString(claims.external_org_id);
  if (!userId || !orgId) {
    throw new Error("凭证里缺少用户 ID 或组织 ID");
  }
  const name = [asString(claims.first_name), asString(claims.last_name)]
    .filter(Boolean)
    .join(" ");
  return { userId, orgId, email: asString(claims.email), name: name || null };
}

/** 读取一个凭证文件并返回其中的账号身份；文件不存在时返回 null */
export async function readIdentityFromFile(
  filePath: string,
  key: Buffer,
): Promise<AccountIdentity | null> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  return identityFromCredentials(decryptCredentials(content, key));
}

/** 两个身份是不是同一个账号（同一用户在同一组织） */
export function sameAccount(a: AccountIdentity, b: AccountIdentity): boolean {
  return a.userId === b.userId && a.orgId === b.orgId;
}
