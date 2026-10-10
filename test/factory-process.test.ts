import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { macFactoryProcess } from "../src/core/factory-process";

// 只结束本测试自己起的 sleep 进程，不碰真实的 droid
const children: ChildProcess[] = [];

function startSleep(ignoreTerm: boolean): ChildProcess {
  // exec 后忽略 SIGTERM 的设置会保留下来
  const script = ignoreTerm ? 'trap "" TERM; exec sleep 60' : "exec sleep 60";
  const child = spawn("/bin/sh", ["-c", script], { stdio: "ignore" });
  children.push(child);
  return child;
}

afterEach(() => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
  }
});

describe("killProcesses", () => {
  it("SIGTERM 能结束的进程直接结束", async () => {
    const child = startSleep(false);
    const survivors = await macFactoryProcess.killProcesses(
      [child.pid!],
      5_000,
    );
    expect(survivors).toEqual([]);
  });

  it("忽略 SIGTERM 的进程超时后用 SIGKILL 结束", async () => {
    const child = startSleep(true);
    // 等 sh 执行完 trap 再发信号
    await new Promise((resolve) => setTimeout(resolve, 300));
    const survivors = await macFactoryProcess.killProcesses(
      [child.pid!],
      500,
    );
    expect(survivors).toEqual([]);
    expect(child.signalCode ?? (await onceExit(child))).toBe("SIGKILL");
  });
});

function onceExit(child: ChildProcess): Promise<NodeJS.Signals | null> {
  return new Promise((resolve) => child.once("exit", (_, signal) => resolve(signal)));
}
