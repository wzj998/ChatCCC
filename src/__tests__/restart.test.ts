import { EventEmitter } from "node:events";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

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

  it("spawns without a shell, captures stderr, and marks the internal restart env", () => {
    const fake = new FakeChild();
    const spawnImpl = vi.fn(() => fake as never);
    const trace = vi.fn();

    const child = spawnRestartChild({ projectRoot: "F:/proj", spawnImpl, trace });

    expect(child).toBe(fake);
    expect(spawnImpl).toHaveBeenCalledWith(
      process.execPath,
      [join("F:/proj", "node_modules", "tsx", "dist", "cli.mjs"), "src/index.ts"],
      expect.objectContaining({
        detached: true,
        stdio: ["ignore", "ignore", "pipe"],
        env: expect.objectContaining({ [INTERNAL_RESTART_ENV_VAR]: "1" }),
        // 不使用 shell：避免 npm/npx 的 PATH 注入问题
        shell: false,
      }),
    );
    // spawnImpl 收到的 command/args 中不得出现 npx/npm（env 里的 npm_* 变量不算）
    const firstCall = spawnImpl.mock.calls[0] as unknown as [string, string[]];
    const [cmd, args] = firstCall;
    expect([cmd, ...args].join(" ")).not.toMatch(/npx|npm/i);
  });

  it("writes captured stderr into the trace on child exit", () => {
    const fake = new FakeChild();
    const spawnImpl = vi.fn(() => fake as never);
    const trace = vi.fn();

    spawnRestartChild({ projectRoot: "F:/proj", spawnImpl, trace });

    fake.stderr.emit("data", Buffer.from("tsx error line 1\n"));
    fake.stderr.emit("data", Buffer.from("tsx error line 2\n"));
    fake.exitCode = 1;
    fake.emit("exit", 1, null);

    const exitCall = trace.mock.calls.find(([name]) => name === "restart: child exit");
    expect(exitCall).toBeTruthy();
    expect(exitCall![1]).toEqual(expect.objectContaining({
      childPid: 12345,
      code: 1,
      signal: null,
    }));
    expect(exitCall![1].stderr).toContain("tsx error line 1");
    expect(exitCall![1].stderr).toContain("tsx error line 2");
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
