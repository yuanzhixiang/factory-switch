import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CursorCurrentState } from "../shared/types";

const KEYS = ["accessToken", "refreshToken", "cachedEmail", "cachedScopedProfile",
  "stripeMembershipAuthId", "stripeMembershipType", "stripeSubscriptionStatus"]
  .map((key) => `cursorAuth/${key}`);

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 512
    ? value : null;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

/** 仅解码声明，不验证 JWT 签名或服务端状态；错误不携带原始凭证。 */
function claims(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) {
    throw new Error("凭证格式无法识别");
  }
  const parsed = object(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  if (!text(parsed.sub)) throw new Error("凭证缺少账号 ID");
  return parsed;
}

/** 默认目录由主进程提供，页面不能指定路径。SQLite 只读打开，查询限定在账号字段。 */
export async function readCursorCurrent(dataDirectory: string, now = Date.now()): Promise<CursorCurrentState> {
  const base = { dataDirectory, checkedAt: now };
  const dbPath = path.join(dataDirectory, "User/globalStorage/state.vscdb");
  try {
    await fs.access(dbPath, fs.constants.R_OK);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { ...base, kind: "signed-out" }
      : { ...base, kind: "unreadable", message: "无法读取 Cursor 数据库，请检查文件权限" };
  }
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000");
    const rows = db.prepare(`SELECT key, CASE WHEN length(value) <= 32768 THEN value ELSE NULL END AS value FROM ItemTable
      WHERE key IN (${KEYS.map(() => "?").join(",")})`).all(...KEYS);
    const values = new Map<string, string>();
    for (const row of rows) {
      const value = row.value instanceof Uint8Array
        ? Buffer.from(row.value).toString("utf8") : row.value;
      if (typeof value !== "string" || value.length > 32768) {
        return { ...base, kind: "unreadable", message: "Cursor 账号字段格式不兼容" };
      }
      values.set(row.key as string, value);
    }
    const get = (key: string) => values.get(`cursorAuth/${key}`);
    const access = get("accessToken");
    const refresh = get("refreshToken");
    if (!access) return refresh
      ? { ...base, kind: "unreadable", message: "Cursor 本地凭证不完整，请在 Cursor 中检查登录状态" }
      : { ...base, kind: "signed-out" };
    let token: Record<string, unknown>;
    try {
      token = claims(access);
      if (refresh && claims(refresh).sub !== token.sub) {
        return { ...base, kind: "unreadable", message: "Cursor 本地凭证的账号归属不一致" };
      }
    } catch {
      return { ...base, kind: "unreadable", message: "Cursor 本地凭证格式无法识别" };
    }
    const userId = text(token.sub)!;
    const profile = object(get("cachedScopedProfile"));
    const profileOwned = profile.authId === userId;
    const membershipOwned = get("stripeMembershipAuthId") === userId;
    const expiresAt = typeof token.exp === "number" && Number.isFinite(token.exp)
      && token.exp > 0 && token.exp * 1000 <= 8.64e15 ? token.exp * 1000 : null;
    return { ...base, kind: "identified", userId,
      email: text(token.email) ?? (profileOwned ? text(get("cachedEmail")) : null),
      name: profileOwned ? text(profile.displayName) : null,
      expiresAt, tokenStatus: expiresAt === null ? "unknown" : expiresAt <= now ? "expired" : "unexpired",
      hasRefreshToken: Boolean(refresh),
      membership: membershipOwned ? text(get("stripeMembershipType")) : null,
      subscription: membershipOwned ? text(get("stripeSubscriptionStatus")) : null,
      cacheMismatch: (text(profile.authId) !== null && !profileOwned)
        || (Boolean(get("stripeMembershipAuthId")) && !membershipOwned),
    };
  } catch {
    // 数据库异常只返回固定提示，避免底层错误把原始内容带进页面或日志。
    return { ...base, kind: "unreadable", message: "Cursor 数据库暂时不可读或格式不兼容，请稍后刷新" };
  } finally { db?.close(); }
}
