import { EventEmitter } from "node:events";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi, afterEach } from "vitest";

import {
  buildRestartSpawnSpec,
  decideRestartParentExit,
  spawnRestartChild,
  RESTART_CHILD_READY_MS,
} from "../orchestrator.ts";
import { INTERNAL_RESTART_ENV_VAR } from "../startup-lifecycle.ts";

describe("buildRestartSpawnSpec", () => {
  it("spawns node directly with the local tsx CLI (never via npx/npm)", () => {
    const spec = buildRestartSpawnSpec("F:/proj");
    expect(spec.command).toBe(process.execPath);
    expect(spec.args[0]).toBe(join("F:/proj", "node_modules", "tsx", "dist", "cli.mjs"));
    expect(spec.args[1]).toBe("src/index.ts");
    expect([spec.command, ...spec.args].join(" ")).not.toMatch(/npx|npm/i);
  });

  it("accepts the default project root", () => {
    const spec = buildRestartSpawnSpec();
    expect(spec.command).toBe(process.execPath);
    expect(spec.args[0]).toContain("tsx");
  });
});

describe("spawnRestartChild", () => {
  class FakeChild extends EventEmitter {
    pid = 12345;
    exitCode: number | null = null;
    signalCode: number | string | null = null;
    unref = vi.fn();
    stderr = new EventEmitter();
  }

  let tmpDirs: string[] = [];
  afterEach(async () => {
    for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
    tmpDirs = [];
  });

  async function tmpLogDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "chatccc-restart-"));
    tmpDirs.push(dir);
    return dir;
  }

  it("spawns without a shell, redirects stderr to a restart log file, and marks the internal restart env", async () => {
    const logDir = await tmpLogDir();
    const fake = new FakeChild();
    const spawnImpl = vi.fn(() => fake as never);
    const trace = vi.fn();

    const child = spawnRestartChild({ projectRoot: "F:/proj", spawnImpl, trace, restartLogDir: logDir });

    expect(child).toBe(fake);
    expect(spawnImpl).toHaveBeenCalledWith(
      process.execPath,
      [join("F:/proj", "node_modules", "tsx", "dist", "cli.mjs"), "src/index.ts"],
      expect.objectContaining({
        detached: true,
        env: expect.objectContaining({ [INTERNAL_RESTART_ENV_VAR]: "1" }),
        // 不使用 shell：避免 npm/npx 的 PATH 注入问题
        shell: false,
      }),
    );
    // spawnImpl 收到的 command/args 中不得出现 npx/npm（env 里的 npm_* 变量不算）
    const firstCall = spawnImpl.mock.calls[0] as unknown as [string, string[]];
    const [cmd, args] = firstCall;
    expect([cmd, ...args].join(" ")).not.toMatch(/npx|npm/i);

    // stderr 指向磁盘日志文件（fd），而不是 pipe：pipe 读端随父进程退出关闭后，
    // 子进程写 stderr 会 EPIPE 崩溃（飞书 SDK console.warn 崩溃根因）。
    const callArgs = spawnImpl.mock.calls[0] as unknown as Array<unknown>;
    const stdio = (callArgs[2] as { stdio: unknown[] }).stdio;
    expect(stdio[0]).toBe("ignore");
    expect(stdio[1]).toBe("ignore");
    expect(typeof stdio[2]).toBe("number");
    expect(stdio[2] as number).toBeGreaterThan(2);

    const files = await readdir(logDir);
    expect(files.some((f) => f.startsWith("restart-") && f.endsWith(".log"))).toBe(true);
  });

  it("records child exit code/signal in trace without pipe capture", async () => {
    const logDir = await tmpLogDir();
    const fake = new FakeChild();
    const spawnImpl = vi.fn(() => fake as never);
    const trace = vi.fn();

    spawnRestartChild({ projectRoot: "F:/proj", spawnImpl, trace, restartLogDir: logDir });

    fake.exitCode = 1;
    fake.emit("exit", 1, null);

    const exitCall = trace.mock.calls.find(([name]) => name === "restart: child exit");
    expect(exitCall).toBeTruthy();
    expect(exitCall![1]).toEqual(expect.objectContaining({
      childPid: 12345,
      code: 1,
      signal: null,
    }));
    // 不再用 pipe 收集 stderr，trace 里不再有 stderr 字段
    expect(exitCall![1]).not.toHaveProperty("stderr");
  });

  it("falls back to pipe capture when the stderr log file cannot be opened", async () => {
    const dir = await tmpLogDir();
    // 用普通文件顶替目录：mkdir/open 日志文件必然失败
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "x");
    const fake = new FakeChild();
    const spawnImpl = vi.fn(() => fake as never);
    const trace = vi.fn();

    spawnRestartChild({ projectRoot: "F:/proj", spawnImpl, trace, restartLogDir: blocker });

    const callArgs = spawnImpl.mock.calls[0] as unknown as Array<unknown>;
    expect((callArgs[2] as { stdio: unknown[] }).stdio[2]).toBe("pipe");
    const failCall = trace.mock.calls.find(
      ([name]) => name === "restart: stderr log open failed, falling back to pipe",
    );
    expect(failCall).toBeTruthy();
    expect(typeof (failCall![1] as { error: unknown }).error).toBe("string");
  });

  it("inherits the full terminal stdio when launched from a TTY (visible window logs, no EPIPE)", async () => {
    const logDir = await tmpLogDir();
    const fake = new FakeChild();
    const spawnImpl = vi.fn(() => fake as never);
    const trace = vi.fn();

    spawnRestartChild({
      projectRoot: "F:/proj",
      spawnImpl,
      trace,
      restartLogDir: logDir,
      isTty: () => true,
    });

    const callArgs = spawnImpl.mock.calls[0] as unknown as Array<unknown>;
    const stdio = (callArgs[2] as { stdio: unknown[] }).stdio;
    // 全部 inherit（含 stdin）：避免 detached + stdin=ignore 在 Windows 上
    // 弹新控制台/丢失控制台关联，日志必须留在用户当前窗口
    expect(stdio).toEqual(["inherit", "inherit", "inherit"]);
    // TTY 场景 stderr 走终端，不再生成 restart-*.log 文件
    const files = await readdir(logDir);
    expect(files.filter((f) => f.startsWith("restart-") && f.endsWith(".log"))).toHaveLength(0);
    // 运行时自检 trace：记录 isTty 判定与最终 stdio
    const spawnCall = trace.mock.calls.find(([name]) => name === "restart: spawn child");
    expect(spawnCall).toBeTruthy();
    expect(spawnCall![1]).toEqual({
      isTty: true,
      stdio: JSON.stringify(["inherit", "inherit", "inherit"]),
    });
  });

  it("still redirects stderr to a file when explicitly not a TTY", async () => {
    const logDir = await tmpLogDir();
    const fake = new FakeChild();
    const spawnImpl = vi.fn(() => fake as never);
    const trace = vi.fn();

    spawnRestartChild({
      projectRoot: "F:/proj",
      spawnImpl,
      trace,
      restartLogDir: logDir,
      isTty: () => false,
    });

    const callArgs = spawnImpl.mock.calls[0] as unknown as Array<unknown>;
    const stdio = (callArgs[2] as { stdio: unknown[] }).stdio;
    expect(stdio[0]).toBe("ignore");
    expect(stdio[1]).toBe("ignore");
    expect(typeof stdio[2]).toBe("number");
    expect(stdio[2] as number).toBeGreaterThan(2);
    const files = await readdir(logDir);
    expect(files.some((f) => f.startsWith("restart-") && f.endsWith(".log"))).toBe(true);
  });
});

describe("decideRestartParentExit", () => {
  it("returns false (parent stays alive) when the child dies during the window", async () => {
    const child = { exitCode: 1, signalCode: null, pid: 42 } as never;
    const trace = vi.fn();

    const shouldExit = await decideRestartParentExit(child, 200, 50, trace);

    expect(shouldExit).toBe(false);
    expect(trace).toHaveBeenCalledWith(
      "restart: child died during window, keeping parent",
      expect.objectContaining({ childPid: 42, exitCode: 1 }),
    );
  });

  it("returns true (parent exits) when the child stays alive through the window", async () => {
    const child = { exitCode: null, signalCode: null, pid: 42 } as never;
    const trace = vi.fn();

    const shouldExit = await decideRestartParentExit(child, 150, 30, trace);

    expect(shouldExit).toBe(true);
    expect(trace).toHaveBeenCalledWith(
      "restart: child alive after window, parent exiting",
      expect.objectContaining({ childPid: 42 }),
    );
  });

  it("surfaces a child that died with a signal", async () => {
    const child = { exitCode: null, signalCode: "SIGKILL", pid: 42 } as never;
    const trace = vi.fn();

    const shouldExit = await decideRestartParentExit(child, 100, 25, trace);

    expect(shouldExit).toBe(false);
    expect(trace).toHaveBeenCalledWith(
      "restart: child died during window, keeping parent",
      expect.objectContaining({ signalCode: "SIGKILL" }),
    );
  });

  it("exports a sane default readiness window", () => {
    expect(RESTART_CHILD_READY_MS).toBeGreaterThan(0);
    expect(RESTART_CHILD_READY_MS).toBeLessThan(60_000);
  });
});
