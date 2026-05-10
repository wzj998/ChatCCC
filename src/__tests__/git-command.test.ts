import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runGitCommand,
  formatGitResult,
  gitResultHeaderTemplate,
  type GitCommandResult,
} from "../git-command.ts";

// ---------------------------------------------------------------------------
// 通过自定义 spawn 桩测试纯逻辑（流处理 / 超时 / 截断 / 退出码）
// ---------------------------------------------------------------------------

interface StubSpawnOptions {
  stdout?: string[];
  stderr?: string[];
  exitCode?: number | null;
  /** 数据推送 / close 事件相对于 spawn 的延迟（ms） */
  emitDelayMs?: number;
  /** 模拟 spawn 同步抛出（如可执行文件不存在） */
  throwOnStart?: Error;
  /** 模拟 child.on("error") 异步触发（如 ENOENT） */
  emitErrorAfterMs?: number;
  emitErrorMessage?: string;
  /** 是否永远不结束（用来测超时） */
  hang?: boolean;
}

function makeStubSpawn(opts: StubSpawnOptions): any {
  return ((..._args: unknown[]) => {
    if (opts.throwOnStart) throw opts.throwOnStart;

    const child = new EventEmitter() as EventEmitter & {
      stdout: Readable;
      stderr: Readable;
      kill: (sig?: string) => void;
    };
    child.stdout = new Readable({ read() {} });
    child.stderr = new Readable({ read() {} });

    let killed = false;
    child.kill = (_sig?: string) => {
      killed = true;
      child.stdout.push(null);
      child.stderr.push(null);
      setImmediate(() => child.emit("close", null));
    };

    const delay = opts.emitDelayMs ?? 5;
    setTimeout(() => {
      if (killed) return;
      for (const c of opts.stdout ?? []) child.stdout.push(Buffer.from(c));
      child.stdout.push(null);
      for (const c of opts.stderr ?? []) child.stderr.push(Buffer.from(c));
      child.stderr.push(null);
      if (opts.emitErrorAfterMs !== undefined) {
        setTimeout(
          () => child.emit("error", new Error(opts.emitErrorMessage ?? "stub error")),
          opts.emitErrorAfterMs,
        );
      }
      if (!opts.hang) {
        setTimeout(() => {
          if (!killed) child.emit("close", opts.exitCode ?? 0);
        }, 2);
      }
    }, delay);

    return child;
  }) as any;
}

describe("runGitCommand (with stub spawn)", () => {
  it("collects stdout and reports exit code 0", async () => {
    const result = await runGitCommand("status", "/some/dir", {
      spawnImpl: makeStubSpawn({ stdout: ["On branch main\n", "nothing to commit\n"], exitCode: 0 }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("On branch main\nnothing to commit\n");
    expect(result.stderr).toBe("");
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.spawnError).toBeUndefined();
  });

  it("collects stderr and non-zero exit code", async () => {
    const result = await runGitCommand("notacommand", "/some/dir", {
      spawnImpl: makeStubSpawn({
        stderr: ["git: 'notacommand' is not a git command\n"],
        exitCode: 1,
      }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("not a git command");
  });

  it("truncates stdout when exceeding maxBytes", async () => {
    const big = "x".repeat(5000);
    const result = await runGitCommand("log", "/some/dir", {
      maxBytes: 1024,
      spawnImpl: makeStubSpawn({ stdout: [big], exitCode: 0 }),
    });
    expect(result.truncated).toBe(true);
    // 截断后 stdout 长度 ≤ 1024
    expect(Buffer.byteLength(result.stdout, "utf-8")).toBeLessThanOrEqual(1024);
  });

  it("truncates stderr when exceeding maxBytes", async () => {
    const big = "e".repeat(3000);
    const result = await runGitCommand("log", "/some/dir", {
      maxBytes: 512,
      spawnImpl: makeStubSpawn({ stderr: [big], exitCode: 1 }),
    });
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stderr, "utf-8")).toBeLessThanOrEqual(512);
  });

  it("times out hung command and sets timedOut=true with exitCode=null", async () => {
    const result = await runGitCommand("log", "/some/dir", {
      timeoutMs: 30,
      spawnImpl: makeStubSpawn({ hang: true, stdout: ["partial output\n"] }),
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    // 超时前已收集的 partial output 应保留
    expect(result.stdout).toContain("partial output");
  });

  it("captures spawn synchronous throw as spawnError", async () => {
    const result = await runGitCommand("status", "/some/dir", {
      spawnImpl: makeStubSpawn({ throwOnStart: new Error("ENOENT git") }),
    });
    expect(result.spawnError).toBe("ENOENT git");
    expect(result.exitCode).toBeNull();
  });

  it("records durationMs as a non-negative number", async () => {
    const result = await runGitCommand("status", "/some/dir", {
      spawnImpl: makeStubSpawn({ stdout: ["ok\n"], exitCode: 0, emitDelayMs: 10 }),
    });
    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// formatGitResult —— 渲染逻辑
// ---------------------------------------------------------------------------

describe("formatGitResult", () => {
  const baseResult = (overrides: Partial<GitCommandResult> = {}): GitCommandResult => ({
    exitCode: 0,
    stdout: "",
    stderr: "",
    durationMs: 12,
    truncated: false,
    timedOut: false,
    ...overrides,
  });

  it("includes the rendered command, cwd and exit code header", () => {
    const out = formatGitResult("status", "/repo", baseResult({ stdout: "ok\n" }));
    expect(out).toContain("git status");
    expect(out).toContain("/repo");
    expect(out).toContain("退出码: `0`");
  });

  it("renders stdout in a fenced block when present", () => {
    const out = formatGitResult("status", "/repo", baseResult({ stdout: "On branch dev" }));
    expect(out).toContain("**stdout:**");
    expect(out).toContain("On branch dev");
    expect(out.match(/```/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("renders stderr block when present", () => {
    const out = formatGitResult(
      "push",
      "/repo",
      baseResult({ exitCode: 1, stderr: "fatal: remote rejected" }),
    );
    expect(out).toContain("**stderr:**");
    expect(out).toContain("fatal: remote rejected");
    expect(out).toContain("退出码: `1`");
  });

  it("hints empty output when both streams are blank", () => {
    const out = formatGitResult("status", "/repo", baseResult({ stdout: "", stderr: "" }));
    expect(out).toContain("(命令无输出)");
  });

  it("annotates timedOut, truncated and spawnError flags", () => {
    const out = formatGitResult(
      "log",
      "/repo",
      baseResult({ exitCode: null, timedOut: true, truncated: true, spawnError: "ENOENT" }),
    );
    expect(out).toContain("超时");
    expect(out).toContain("截断");
    expect(out).toContain("ENOENT");
    expect(out).toContain("退出码: `(无)`");
  });

  it("truncates very long stdout via truncateContent", () => {
    const long = Array.from({ length: 500 }, (_, i) => `line${i + 1}`).join("\n");
    const out = formatGitResult("log", "/repo", baseResult({ stdout: long }), {
      maxLines: 5,
      maxChars: 1000,
    });
    expect(out).toContain("...");
    // 只保留前 1 行 + "..." + 后 4 行
    expect(out).toContain("line1");
    expect(out).toContain("line500");
    expect(out).not.toContain("line250");
  });
});

// ---------------------------------------------------------------------------
// gitResultHeaderTemplate
// ---------------------------------------------------------------------------

describe("gitResultHeaderTemplate", () => {
  const r = (overrides: Partial<GitCommandResult>): GitCommandResult => ({
    exitCode: 0,
    stdout: "",
    stderr: "",
    durationMs: 0,
    truncated: false,
    timedOut: false,
    ...overrides,
  });

  it("returns green when exitCode=0", () => {
    expect(gitResultHeaderTemplate(r({ exitCode: 0 }))).toBe("green");
  });

  it("returns red when exitCode≠0", () => {
    expect(gitResultHeaderTemplate(r({ exitCode: 1 }))).toBe("red");
    expect(gitResultHeaderTemplate(r({ exitCode: 128 }))).toBe("red");
  });

  it("returns yellow when timedOut", () => {
    expect(gitResultHeaderTemplate(r({ exitCode: null, timedOut: true }))).toBe("yellow");
  });

  it("returns yellow when spawnError set", () => {
    expect(gitResultHeaderTemplate(r({ exitCode: null, spawnError: "x" }))).toBe("yellow");
  });
});

// ---------------------------------------------------------------------------
// 集成 smoke test：真正调起 `git --version` 在临时目录
// （前置条件：开发机已安装 git）
// ---------------------------------------------------------------------------

describe("runGitCommand integration (real git)", () => {
  it("`git --version` runs successfully in a tmp dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chatccc-git-test-"));
    try {
      const result = await runGitCommand("--version", dir, { timeoutMs: 15_000 });
      // git 不在 PATH 时会得到 spawnError 或非 0 退出，这里整体期望成功
      expect(result.spawnError).toBeUndefined();
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toLowerCase()).toContain("git version");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("`git status` outside repo reports non-zero exit code with helpful stderr", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chatccc-git-test-"));
    try {
      const result = await runGitCommand("status", dir, { timeoutMs: 15_000 });
      expect(result.spawnError).toBeUndefined();
      // not a git repo → exitCode ≠ 0
      expect(result.exitCode).not.toBe(0);
      const combined = (result.stdout + result.stderr).toLowerCase();
      expect(combined).toMatch(/not a git repository|fatal/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
