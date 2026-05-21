// =============================================================================
// proc-tree-kill.test.ts — 进程树强杀工具单测护栏
// =============================================================================
// 目的：覆盖 codex/cursor adapter 之前 proc.kill() 在 Windows + shell:true 下
//      只杀第一层 cmd.exe 壳、留下 node + 真二进制成"幽灵"的 bug。
// 测试构造一棵三层进程树（祖父 cmd/sh → 父 node → 子 sleep 进程），
// 用 killProcessTree 杀掉祖父 PID，断言整棵树都不存在了。
// =============================================================================

import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { writeFileSync, unlinkSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { killProcessTree } from "../adapters/proc-tree-kill.ts";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("killProcessTree", () => {
  it("kills a 3-level process tree (shell wrapper + node child + node grandchild)", async () => {
    // 用临时脚本模拟 codex CLI 的真实拓扑：
    //   layer-1: shell (cmd.exe / sh) — 因为 spawn 用了 shell:true
    //     layer-2: node 进程 — 模拟 `node codex.js` 入口
    //       layer-3: 又一个 node 进程 — 模拟真正干活的 codex.exe 子进程
    const tmp = mkdtempSync(join(tmpdir(), "chatccc-proctree-"));
    const childScript = join(tmp, "child.mjs");
    const pidFile = join(tmp, "grand.pid");
    const isWin = process.platform === "win32";

    writeFileSync(
      childScript,
      [
        `import { spawn } from "node:child_process";`,
        `import { writeFileSync } from "node:fs";`,
        // 启动孙进程：再开一个 node，跑一个 10 分钟的 setTimeout 占位
        `const grand = spawn(process.execPath, ["-e", "setTimeout(()=>{},600000)"], { stdio: "ignore", detached: false });`,
        `writeFileSync(${JSON.stringify(pidFile)}, String(grand.pid));`,
        // 父进程自己也挂住别退出
        `setTimeout(()=>{}, 600000);`,
      ].join("\n"),
      "utf8",
    );

    // 启动祖父：复现 codex-adapter 用 shell:true 的方式
    // 路径必须加引号，否则 cmd.exe 把空格当分隔符
    const proc = spawn(`"${process.execPath}" "${childScript}"`, {
      stdio: "ignore",
      shell: true,
      windowsHide: true,
      detached: !isWin,
    });

    expect(proc.pid).toBeGreaterThan(0);

    // 等待孙进程 pid 被写出来（pidFile 出现表示中间 node 已成功 spawn 孙子）
    let grandPid = 0;
    for (let i = 0; i < 100; i++) {
      if (existsSync(pidFile)) {
        const s = readFileSync(pidFile, "utf8").trim();
        if (s && /^\d+$/.test(s)) {
          grandPid = parseInt(s, 10);
          break;
        }
      }
      await sleep(100);
    }
    expect(grandPid).toBeGreaterThan(0);
    expect(isAlive(grandPid)).toBe(true);

    // 杀祖父（在 shell:true 时 proc.pid 就是 cmd.exe / sh 那一层）。
    // 关键断言：如果 killProcessTree 没有 /T 递归，grandPid 会留下来。
    await killProcessTree(proc.pid!);

    for (let i = 0; i < 50; i++) {
      if (!isAlive(grandPid)) break;
      await sleep(100);
    }

    expect(isAlive(grandPid)).toBe(false);
    expect(isAlive(proc.pid!)).toBe(false);

    try {
      unlinkSync(childScript);
      if (existsSync(pidFile)) unlinkSync(pidFile);
    } catch {
      // 忽略清理失败
    }
  }, 30000);

  it("does not throw when pid does not exist", async () => {
    await expect(killProcessTree(999999)).resolves.toBeUndefined();
  });

  it("does not throw when pid is undefined", async () => {
    await expect(killProcessTree(undefined)).resolves.toBeUndefined();
  });
});
