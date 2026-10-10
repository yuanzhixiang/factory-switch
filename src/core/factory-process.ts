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
  /** 主进程和 daemon 之外的 droid 进程：终端里开的命令行，或桌面版退出后残留的会话进程 */
  listOtherDroidProcesses(): Promise<DroidProcess[]>;
  /** 先 SIGTERM，超时后 SIGKILL，返回仍然没退出的 pid */
  killProcesses(pids: number[], timeoutMs: number): Promise<number[]>;
}

export interface DroidProcess {
  pid: number;
  command: string;
}

// 两次检查进程之间的间隔
const POLL_INTERVAL_MS = 500;
// SIGKILL 之后等内核回收的时间
const KILL_GRACE_MS = 2_000;

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

/** 给一组进程发信号，已经退出的忽略 */
function signalAll(pids: number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error;
      }
    }
  }
}

/** 返回还活着的 pid；signal 0 只做存在性检查 */
function aliveOf(pids: number[]): number[] {
  return pids.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM 说明进程在但无权操作，也算活着
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  });
}

/** 轮询到 pids 全部退出或超时，返回剩下的 */
async function waitForExit(pids: number[], timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let alive = aliveOf(pids);
  while (alive.length > 0 && Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    alive = aliveOf(alive);
  }
  return alive;
}

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
      .map((p) => ({ pid: p.pid, command: p.command.slice(0, 120) }));
  },

  async killProcesses(pids, timeoutMs) {
    signalAll(pids, "SIGTERM");
    const stubborn = await waitForExit(pids, timeoutMs);
    if (stubborn.length === 0) {
      return [];
    }
    signalAll(stubborn, "SIGKILL");
    return waitForExit(stubborn, KILL_GRACE_MS);
  },
};
