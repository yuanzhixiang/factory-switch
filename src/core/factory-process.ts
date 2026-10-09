import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** 控制 Factory 桌面版进程 */
export interface FactoryProcess {
  /** 桌面版或它的后台 daemon 是否还在运行 */
  isRunning(): Promise<boolean>;
  /** 请求正常退出并等它彻底退出，超时返回 false */
  quit(timeoutMs: number): Promise<boolean>;
  open(): Promise<void>;
  /** 桌面版之外还在运行的 droid 进程（通常是终端里开的命令行） */
  listOtherDroidProcesses(): Promise<string[]>;
}

// 两次检查进程之间的间隔
const POLL_INTERVAL_MS = 500;

/** 列出所有进程的 pid 和可执行文件路径 */
async function listProcesses(): Promise<{ pid: number; command: string }[]> {
  const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid=,command="], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const space = line.indexOf(" ");
      return {
        pid: Number(line.slice(0, space)),
        command: line.slice(space + 1),
      };
    });
}

/** 判断一行进程命令是不是 Factory 桌面版主进程或它的 daemon */
function isFactoryCommand(command: string): boolean {
  return (
    command.startsWith("/Applications/Factory.app/Contents/MacOS/Factory") ||
    command.includes("Factory.app/Contents/Resources/bin/droid daemon")
  );
}

/** 判断一行进程命令的可执行文件是不是 droid */
function isDroidCommand(command: string): boolean {
  const executable = command.split(" ")[0] ?? "";
  return path.basename(executable) === "droid";
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const macFactoryProcess: FactoryProcess = {
  async isRunning() {
    const processes = await listProcesses();
    return processes.some((p) => isFactoryCommand(p.command));
  },

  async quit(timeoutMs) {
    // 没在运行就不发 AppleScript，否则 tell application 会把它拉起来
    if (!(await this.isRunning())) {
      return true;
    }
    await execFileAsync("/usr/bin/osascript", [
      "-e",
      'tell application "Factory" to quit',
    ]).catch(() => undefined);
    // 主进程和 daemon 都退出才算完，daemon 也会刷新 token
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await this.isRunning())) {
        return true;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    return false;
  },

  async open() {
    await execFileAsync("/usr/bin/open", ["-a", "Factory"]);
  },

  async listOtherDroidProcesses() {
    const processes = await listProcesses();
    return processes
      .filter((p) => isDroidCommand(p.command) && !isFactoryCommand(p.command))
      .map((p) => `${p.pid} ${p.command.slice(0, 120)}`);
  },
};
