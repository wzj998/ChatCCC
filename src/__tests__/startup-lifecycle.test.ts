import { describe, expect, it, vi } from "vitest";

import {
  INTERNAL_RESTART_ENV_VAR,
  buildWebUiUrl,
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
    expect(createInternalRestartEnv({ PATH: "test-path", CUSTOM: "value" })).toEqual({
      PATH: "test-path",
      CUSTOM: "value",
      [INTERNAL_RESTART_ENV_VAR]: "1",
    });
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
