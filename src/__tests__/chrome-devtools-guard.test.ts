import { describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";

import {
  ensureChromeCdpRunning,
  isChromeCdpHealthy,
  probeChromeCdp,
  resolveChromeExecutable,
  resolveChromeUserDataDir,
} from "../chrome-devtools-guard.ts";

describe("Chrome CDP guard", () => {
  it("treats /json/version with Browser as healthy", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ Browser: "Chrome/144.0.0.0" }), { status: 200 }),
    ) as unknown as typeof fetch;

    await expect(isChromeCdpHealthy(15166, { fetchImpl })).resolves.toBe(true);
  });

  it("does not spawn Chrome when the CDP endpoint is already healthy", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:15166/devtools/browser/1" }), { status: 200 }),
    ) as unknown as typeof fetch;
    const spawnImpl = vi.fn() as unknown as typeof spawn;

    await expect(
      ensureChromeCdpRunning(
        { enabled: true, port: 15166, chromePath: "C:/Chrome/chrome.exe" },
        { fetchImpl, spawnImpl },
      ),
    ).resolves.toEqual({ ok: true, started: false, port: 15166 });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("spawns Chrome with a dedicated profile when the endpoint is unhealthy", async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValue(new Response(JSON.stringify({ Browser: "Chrome/144.0.0.0" }), { status: 200 })) as unknown as typeof fetch;
    const unref = vi.fn();
    const spawnImpl = vi.fn(() => ({ unref })) as unknown as typeof spawn;
    const mkdirSyncImpl = vi.fn();

    await expect(
      ensureChromeCdpRunning(
        { enabled: true, port: 15166, chromePath: "C:/Chrome/chrome.exe" },
        {
          fetchImpl,
          spawnImpl,
          mkdirSyncImpl: mkdirSyncImpl as never,
          existsSyncImpl: vi.fn(() => true),
          env: { LOCALAPPDATA: "C:/Users/me/AppData/Local" },
        },
      ),
    ).resolves.toEqual({ ok: true, started: true, port: 15166 });

    expect(mkdirSyncImpl).toHaveBeenCalledWith("C:\\Users\\me\\AppData\\Local\\chatccc\\chrome-cdp-15166", { recursive: true });
    expect(spawnImpl).toHaveBeenCalledWith(
      "C:/Chrome/chrome.exe",
      expect.arrayContaining([
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=15166",
        "--user-data-dir=C:\\Users\\me\\AppData\\Local\\chatccc\\chrome-cdp-15166",
        "--new-window",
        "about:blank",
      ]),
      expect.objectContaining({ detached: true, stdio: "ignore", windowsHide: true }),
    );
    expect(unref).toHaveBeenCalled();
  });

  it("does not spawn Chrome when the port is occupied by a non-CDP service", async () => {
    const fetchImpl = vi.fn(async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
    const spawnImpl = vi.fn() as unknown as typeof spawn;

    await expect(probeChromeCdp(15166, { fetchImpl })).resolves.toBe("occupied");
    await expect(
      ensureChromeCdpRunning(
        { enabled: true, port: 15166, chromePath: "C:/Chrome/chrome.exe" },
        { fetchImpl, spawnImpl },
      ),
    ).resolves.toMatchObject({
      ok: false,
      started: false,
      port: 15166,
      error: expect.stringContaining("not a healthy Chrome CDP endpoint"),
    });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("reports a clear error when Chrome cannot be found", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;

    await expect(
      ensureChromeCdpRunning(
        { enabled: true, port: 15166, chromePath: "" },
        {
          fetchImpl,
          existsSyncImpl: vi.fn(() => false),
          platform: "win32",
          env: {},
        },
      ),
    ).resolves.toMatchObject({
      ok: false,
      started: false,
      port: 15166,
      error: expect.stringContaining("Cannot find chrome executable"),
    });
  });

  it("resolves explicit and default Chrome paths", () => {
    expect(resolveChromeExecutable("C:/Chrome/chrome.exe", { existsSyncImpl: vi.fn(() => true) })).toBe("C:/Chrome/chrome.exe");
    expect(resolveChromeExecutable("", {
      existsSyncImpl: vi.fn((p: unknown) => String(p).endsWith("Google\\Chrome\\Application\\chrome.exe")),
      platform: "win32",
      env: { ProgramFiles: "C:/Program Files" },
    })).toBe("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
  });

  it("uses LocalAppData for the Chrome CDP user data directory", () => {
    expect(resolveChromeUserDataDir(15166, { LOCALAPPDATA: "C:/Users/me/AppData/Local" }))
      .toBe("C:\\Users\\me\\AppData\\Local\\chatccc\\chrome-cdp-15166");
  });
});
