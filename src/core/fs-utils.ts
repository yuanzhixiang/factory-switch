import fs from "node:fs/promises";
import path from "node:path";

/** 判断路径是否存在 */
export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/** 先写临时文件再改名，避免写到一半时被 Factory 读到残缺内容 */
export async function writeFileAtomic(
  target: string,
  content: string | Buffer,
  mode = 0o600,
): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.fsw-tmp-${process.pid}`;
  await fs.writeFile(temp, content, { mode });
  await fs.rename(temp, target);
}

/** 原子复制单个文件，权限固定为仅本人可读写 */
export async function copyFileAtomic(
  source: string,
  target: string,
): Promise<void> {
  await writeFileAtomic(target, await fs.readFile(source));
}

/** 把文件或目录移到备份目录下的同名相对路径；源不存在时什么都不做 */
export async function moveIntoBackup(
  source: string,
  backupRoot: string,
  relativePath: string,
): Promise<boolean> {
  if (!(await pathExists(source))) {
    return false;
  }
  const target = path.join(backupRoot, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.rename(source, target);
  return true;
}
