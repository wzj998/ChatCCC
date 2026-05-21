// =============================================================================
// proc-tree-kill.ts — 跨平台进程树强杀工具
// =============================================================================
// 背景：codex / cursor adapter 通过 `spawn(cmd, args, { shell: true })` 启动 CLI
// 时，Node 拿到的 proc.pid 是最外层 cmd.exe（Windows）或 /bin/sh（其它）的
// PID。真正干活的是它再 spawn 出来的：
//
//     cmd.exe              ← proc.kill() 只能杀到这一层
//       └─ node codex.js   ← Codex CLI 入口
//            └─ codex.exe  ← 实际 Rust 二进制（继续烧 token）
//
// 单纯 proc.kill() 在 Windows 上等价于 TerminateProcess 顶层壳，孙子进程不会
// 收到任何信号、继续运行，导致用户 /stop 看似生效（adapter 标记 stopped）但
// 实际 codex 仍在后台跑、stream-state 一直停在 "running"。
//
// 解决方案：abort 时不要走 proc.kill()，而是用本工具按 pid 杀掉整棵进程树。
//   - Windows: `taskkill /pid <pid> /T /F`（/T = 递归子进程, /F = 强制）
//   - 其它：`process.kill(-pgid, "SIGTERM")` + 兜底 SIGKILL（adapter spawn 时
//           需配合 detached:true 让子进程拥有独立 process group）
// =============================================================================

import { spawn } from "node:child_process";

/** 异步杀掉以 pid 为根的整棵进程树。
 *
 * 设计目标：永不抛错、永不阻塞调用者。
 * - pid 不存在、参数缺失 → 静默返回
 * - 子进程 spawn 失败 → console.warn 但不 reject
 * - Windows 上 taskkill 异步执行，不阻塞 event loop
 *
 * 调用方约定：返回的 Promise 在 kill 命令发出后立即 resolve。
 * 真正的进程退出由 OS 异步完成，调用方如果需要确认"已死透"，应自己再轮询
 * `process.kill(pid, 0)`。
 */
export async function killProcessTree(pid: number | undefined): Promise<void> {
  if (pid == null || !Number.isFinite(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    await killWindowsTree(pid);
    return;
  }
  await killPosixTree(pid);
}

// ---------------------------------------------------------------------------
// Windows: taskkill /T /F
// ---------------------------------------------------------------------------

function killWindowsTree(pid: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let resolved = false;
    const done = () => {
      if (resolved) return;
      resolved = true;
      resolve();
    };
    try {
      const proc = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        // taskkill 本身很快（<200ms），不需要 detached
      });
      proc.once("error", (err) => {
        console.warn(`[killProcessTree] taskkill spawn error for pid=${pid}: ${(err as Error).message}`);
        done();
      });
      proc.once("close", () => { done(); });
      // 兜底超时：3 秒后强制 resolve，避免极端情况下 hang 住调用方
      setTimeout(done, 3000).unref();
    } catch (err) {
      console.warn(`[killProcessTree] taskkill failed for pid=${pid}: ${(err as Error).message}`);
      done();
    }
  });
}

// ---------------------------------------------------------------------------
// POSIX: 优先按 process group 杀，回退到按 pid 杀
// ---------------------------------------------------------------------------

async function killPosixTree(pid: number): Promise<void> {
  // 第一次尝试：按 process group 发 SIGTERM。要求 spawn 时 detached:true。
  trySignal(-pid, "SIGTERM");
  trySignal(pid, "SIGTERM");
  // 给进程 1 秒优雅退出机会
  await new Promise((r) => setTimeout(r, 1000));
  // 兜底：SIGKILL
  trySignal(-pid, "SIGKILL");
  trySignal(pid, "SIGKILL");
}

function trySignal(target: number, signal: NodeJS.Signals): void {
  try {
    process.kill(target, signal);
  } catch {
    // 进程已不存在或权限不足，忽略
  }
}
