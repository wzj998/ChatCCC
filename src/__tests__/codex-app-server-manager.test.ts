import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

vi.mock("../adapters/proc-tree-kill.ts", () => ({
  killProcessTree: vi.fn(async () => true),
}));

import { CodexAppServerManager } from "../adapters/codex-app-server.ts";

class FakeProc extends EventEmitter {
  stderr = new EventEmitter();
  pid = 4242;
  kill = vi.fn();
}

describe("CodexAppServerManager", () => {
  let procs: FakeProc[];

  beforeEach(() => {
    procs = [];
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => {
      const proc = new FakeProc();
      procs.push(proc);
      return proc;
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reuses the running app-server port", async () => {
    const manager = new CodexAppServerManager();
    const first = await manager.ensureStarted("codex");
    const second = await manager.ensureStarted("codex");

    expect(second).toBe(first);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("respawns after the app-server process exits instead of returning the dead port", async () => {
    const manager = new CodexAppServerManager();
    await manager.ensureStarted("codex");

    procs[0].emit("close", 1);
    await manager.ensureStarted("codex");

    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("retries after a failed start", async () => {
    const manager = new CodexAppServerManager();
    spawnMock.mockImplementationOnce(() => {
      throw new Error("spawn boom");
    });

    await expect(manager.ensureStarted("codex")).rejects.toThrow("spawn boom");
    await manager.ensureStarted("codex");

    expect(spawnMock).toHaveBeenCalledTimes(2);
  });
});
