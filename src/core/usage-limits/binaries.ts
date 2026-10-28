// 找 claude、codex 等命令行工具。从 Finder 打开的应用拿不到 shell 里的 PATH，
// 所以先用登录 shell 读一次 PATH，再加上常见安装目录。
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let shellPath: Promise<string> | null = null;

/** 登录 shell 的 PATH，最多等 5 秒，失败就用当前进程的 PATH */
function loginShellPath(): Promise<string> {
  shellPath ??= new Promise((resolve) => {
    const shell = process.env.SHELL || "/bin/zsh";
    execFile(
      shell,
      ["-ilc", 'printf "__PATH__%s__PATH__" "$PATH"'],
      { timeout: 5_000, env: process.env },
      (error, stdout) => {
        const match = /__PATH__(.*)__PATH__/.exec(stdout ?? "");
        resolve(!error && match?.[1] ? match[1] : (process.env.PATH ?? ""));
      },
    );
  });
  return shellPath;
}

/** 子进程用的 PATH：登录 shell 的 PATH 加常见安装目录 */
export async function toolPath(): Promise<string> {
  const home = os.homedir();
  const extra = [
    path.join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(home, ".bun", "bin"),
  ];
  const entries = [...(await loginShellPath()).split(":"), ...extra].filter(Boolean);
  return [...new Set(entries)].join(":");
}

/** 在 PATH 里找可执行文件，找不到返回 null */
export async function findBinary(name: string): Promise<string | null> {
  for (const dir of (await toolPath()).split(":")) {
    const candidate = path.join(dir, name);
    try {
      await fs.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // 继续找下一个目录
    }
  }
  return null;
}
