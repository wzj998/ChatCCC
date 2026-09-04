import { describe, expect, it, vi } from "vitest";

import {
  INTERNAL_RESTART_ENV_VAR,
  INTERNAL_RESTART_PARENT_PID_ENV_VAR,
  INTERNAL_RESTART_READY_MESSAGE,
  announceInternalRestartReady,
  buildWebUiUrl,
  createServiceLifecycleGuard,
  createInternalRestartEnv,
  openWebUiInDefaultBrowser,
  shouldAutoOpenWebUi,
} from "../startup-lifecycle.ts";

describe("ChatCCC startup lifecycle", () => {
  it("opens the Web UI by default for a direct start", () => {
    expect(shouldAutoOpenWebUi({ env: {} })).toBe(true);
    expect(shouldAutoOpenWebUi({ env: {}, openOnStart: true })).toBe(true);
  });

  it("respects the persisted openOnStart preference", () => {
    expect(shouldAutoOpenWebUi({ env: {}, openOnStart: false })).toBe(false);
  });

  it("never opens the Web UI for an internal restart", () => {
    expect(shouldAutoOpenWebUi({
      env: { [INTERNAL_RESTART_ENV_VAR]: "1" },
      openOnStart: true,
    })).toBe(false);
  });

  it("marks internal restart children without losing the inherited environment", () => {
    expect(createInternalRestartEnv({ PATH: "test-path", CUSTOM: "value" }, 4321)).toEqual({
      PATH: "test-path",
      CUSTOM: "value",
      [INTERNAL_RESTART_ENV_VAR]: "1",
      [INTERNAL_RESTART_PARENT_PID_ENV_VAR]: "4321",
    });
  });

  it("announces readiness over IPC only for an internal restart", async () => {
    const send = vi.fn((_message: unknown, callback: (error: Error | null) => void) => {
      callback(null);
      return true;
    });

    await expect(announceInternalRestartReady({
      env: {
        [INTERNAL_RESTART_ENV_VAR]: "1",
        [INTERNAL_RESTART_PARENT_PID_ENV_VAR]: "4321",
      },
      pid: 9876,
      send,
    })).resolves.toBe(true);
    expect(send).toHaveBeenCalledWith(
      { type: INTERNAL_RESTART_READY_MESSAGE, pid: 9876, parentPid: 4321 },
      expect.any(Function),
    );
    await expect(announceInternalRestartReady({ env: {}, pid: 9876, send })).resolves.toBe(false);
    expect(send).toHaveBeenCalledOnce();
  });

  it("uses localhost and the configured port for the Web UI URL", () => {
    expect(buildWebUiUrl(18080)).toBe("http://localhost:18080/");
    expect(buildWebUiUrl(18081)).toBe("http://localhost:18081/");
  });

  it("opens the configured URL in the Windows default browser", () => {
    const child = {
      on: vi.fn().mockReturnThis(),
      unref: vi.fn(),
    };
    const spawnImpl = vi.fn(() => child as never);

    expect(openWebUiInDefaultBrowser(18081, {
      platform: "win32",
      spawnImpl,
    })).toBe(true);
    expect(spawnImpl).toHaveBeenCalledWith(
      "cmd.exe",
      ["/c", "start", "", "http://localhost:18081/"],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      },
    );
    expect(child.on).toHaveBeenCalledWith("error", expect.any(Function));
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("opens the configured URL with xdg-open on a Linux desktop", () => {
    const child = {
      on: vi.fn().mockReturnThis(),
      unref: vi.fn(),
    };
    const spawnImpl = vi.fn(() => child as never);

    expect(openWebUiInDefaultBrowser(18080, {
      platform: "linux",
      env: { DISPLAY: ":0" },
      spawnImpl,
    })).toBe(true);
    expect(spawnImpl).toHaveBeenCalledWith(
      "xdg-open",
      ["http://localhost:18080/"],
      { detached: true, stdio: "ignore" },
    );
  });

  it("skips xdg-open and prints an SSH tunnel hint on headless Linux", () => {
    const spawnImpl = vi.fn();
    const onInfo = vi.fn();

    expect(openWebUiInDefaultBrowser(18080, {
      platform: "linux",
      env: {},
      spawnImpl,
      onInfo,
    })).toBe(false);
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(onInfo).toHaveBeenCalledWith(expect.stringContaining("ssh -L 18080:127.0.0.1:18080"));
    expect(onInfo).toHaveBeenCalledWith(expect.stringContaining("http://localhost:18080/"));
  });
});

describe("ChatCCC service lifecycle guard", () => {
  function createHarness() {
    let intervalCallback: (() => void) | undefined;
    const timer = { ref: vi.fn() };
    const setIntervalImpl = vi.fn((callback: () => void) => {
      intervalCallback = callback;
      return timer;
    });
    const clearIntervalImpl = vi.fn();
    const tracer = vi.fn();
    const server = {
      listening: true,
      address: vi.fn(() => ({ address: "127.0.0.1", port: 18080 })),
      ref: vi.fn(),
    };
    const recoverServer = vi.fn(async () => {
      server.listening = true;
    });
    const guard = createServiceLifecycleGuard({
      intervalMs: 10_000,
      setIntervalImpl,
      clearIntervalImpl,
      tracer,
      getActiveResourcesInfo: () => ["TCPServerWrap", "Timeout"],
    });

    return {
      clearIntervalImpl,
      getIntervalCallback: () => intervalCallback,
      guard,
      recoverServer,
      server,
      setIntervalImpl,
      timer,
      tracer,
    };
  }

  it("starts exactly one referenced keep-alive timer", () => {
    const h = createHarness();

    h.guard.start();
    h.guard.start();

    expect(h.setIntervalImpl).toHaveBeenCalledOnce();
    expect(h.setIntervalImpl).toHaveBeenCalledWith(expect.any(Function), 10_000);
    expect(h.timer.ref).toHaveBeenCalledOnce();
  });

  it("keeps a listening HTTP server referenced", async () => {
    const h = createHarness();
    h.guard.attachServer(h.server, h.recoverServer);
    h.guard.start();

    await h.guard.checkNow();

    expect(h.server.ref).toHaveBeenCalled();
    expect(h.recoverServer).not.toHaveBeenCalled();
  });

  it("coalesces concurrent recovery when the HTTP server is not listening", async () => {
    const h = createHarness();
    h.server.listening = false;
    let finishRecovery: (() => void) | undefined;
    h.recoverServer.mockImplementation(() => new Promise<void>((resolve) => {
      finishRecovery = () => {
        h.server.listening = true;
        resolve();
      };
    }));
    h.guard.attachServer(h.server, h.recoverServer);
    h.guard.start();

    const first = h.guard.checkNow();
    const second = h.guard.checkNow();
    await Promise.resolve();
    expect(h.recoverServer).toHaveBeenCalledOnce();

    finishRecovery?.();
    await Promise.all([first, second]);
    expect(h.tracer).toHaveBeenCalledWith(
      "service-lifecycle: HTTP server recovered",
      expect.objectContaining({ serverListening: true }),
    );
  });

  it("re-arms on unexpected beforeExit and records public diagnostics", async () => {
    const h = createHarness();
    h.guard.attachServer(h.server, h.recoverServer);

    h.guard.handleBeforeExit(0);
    await h.guard.checkNow();

    expect(h.setIntervalImpl).toHaveBeenCalledOnce();
    expect(h.server.ref).toHaveBeenCalled();
    expect(h.tracer).toHaveBeenCalledWith(
      "service-lifecycle: unexpected beforeExit",
      expect.objectContaining({
        code: 0,
        activeResources: ["TCPServerWrap", "Timeout"],
        serverListening: true,
      }),
    );
  });

  it("stays stopped after an intentional shutdown", () => {
    const h = createHarness();
    h.guard.start();

    h.guard.beginShutdown("SIGTERM");
    h.guard.handleBeforeExit(0);

    expect(h.clearIntervalImpl).toHaveBeenCalledWith(h.timer);
    expect(h.setIntervalImpl).toHaveBeenCalledOnce();
    expect(h.tracer).toHaveBeenCalledWith(
      "service-lifecycle: shutdown requested",
      { reason: "SIGTERM" },
    );
  });

  it("the timer callback runs a health check", async () => {
    const h = createHarness();
    h.guard.attachServer(h.server, h.recoverServer);
    h.guard.start();

    h.getIntervalCallback()?.();
    await Promise.resolve();

    expect(h.server.ref).toHaveBeenCalled();
  });
});
