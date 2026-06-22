import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { appendStartupTrace } from "./shared.ts";
import { config, ts, USER_DATA_DIR, type ChromeDevtoolsConfig } from "./config.ts";

const CDP_HOST = "127.0.0.1";
const DEFAULT_CDP_PORT = 15166;
const HEALTH_TIMEOUT_MS = 3000;
const START_VERIFY_ATTEMPTS = 10;
const START_VERIFY_DELAY_MS = 500;
const GUARD_INTERVAL_MS = 60_000;

type FetchLike = typeof fetch;

export interface ChromeDevtoolsGuardDeps {
  fetchImpl?: FetchLike;
  spawnImpl?: typeof spawn;
  existsSyncImpl?: typeof existsSync;
  mkdirSyncImpl?: typeof mkdirSync;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}

export interface ChromeCdpEnsureResult {
  ok: boolean;
  started: boolean;
  port: number;
  error?: string;
}

export type ChromeCdpProbeStatus = "healthy" | "occupied" | "unreachable";

let guardTimer: ReturnType<typeof setInterval> | null = null;
let ensureInFlight: Promise<ChromeCdpEnsureResult> | null = null;

function normalizePort(value: unknown): number {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_CDP_PORT;
}

function chromeCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === "win32") {
    return [
      env.ProgramFiles ? join(env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe") : "",
      env["ProgramFiles(x86)"] ? join(env["ProgramFiles(x86)"]!, "Google", "Chrome", "Application", "chrome.exe") : "",
      env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe") : "",
    ].filter(Boolean);
  }

  if (platform === "darwin") {
    return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  }

  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
}

export function resolveChromeExecutable(
  chromePath: string | undefined,
  deps: Pick<ChromeDevtoolsGuardDeps, "existsSyncImpl" | "platform" | "env"> = {},
): string | null {
  const exists = deps.existsSyncImpl ?? existsSync;
  const explicit = chromePath?.trim();
  if (explicit) return exists(explicit) ? explicit : null;

  for (const candidate of chromeCandidates(deps.platform ?? process.platform, deps.env ?? process.env)) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

export function resolveChromeUserDataDir(port: number, env: NodeJS.ProcessEnv = process.env): string {
  const root = env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "chatccc") : join(USER_DATA_DIR, "chrome-cdp");
  return join(root, `chrome-cdp-${port}`);
}

async function fetchWithTimeout(url: string, fetchImpl: FetchLike, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function probeChromeCdp(
  port: number,
  deps: Pick<ChromeDevtoolsGuardDeps, "fetchImpl"> = {},
): Promise<ChromeCdpProbeStatus> {
  const normalizedPort = normalizePort(port);
  try {
    const response = await fetchWithTimeout(
      `http://${CDP_HOST}:${normalizedPort}/json/version`,
      deps.fetchImpl ?? fetch,
      HEALTH_TIMEOUT_MS,
    );
    if (!response.ok) return "occupied";
    const data = await response.json() as Record<string, unknown>;
    return typeof data.Browser === "string" || typeof data.webSocketDebuggerUrl === "string"
      ? "healthy"
      : "occupied";
  } catch {
    return "unreachable";
  }
}

export async function isChromeCdpHealthy(
  port: number,
  deps: Pick<ChromeDevtoolsGuardDeps, "fetchImpl"> = {},
): Promise<boolean> {
  return (await probeChromeCdp(port, deps)) === "healthy";
}

function startChromeForCdp(
  cfg: ChromeDevtoolsConfig,
  deps: ChromeDevtoolsGuardDeps = {},
): { ok: true; child: ChildProcess } | { ok: false; error: string } {
  const port = normalizePort(cfg.port);
  const chromeExe = resolveChromeExecutable(cfg.chromePath, deps);
  if (!chromeExe) {
    return { ok: false, error: "Cannot find chrome executable. Configure chromeDevtools.chromePath." };
  }

  const userDataDir = resolveChromeUserDataDir(port, deps.env ?? process.env);
  try {
    (deps.mkdirSyncImpl ?? mkdirSync)(userDataDir, { recursive: true });
  } catch (err) {
    return { ok: false, error: `Cannot create Chrome user data dir: ${(err as Error).message}` };
  }

  const args = [
    `--remote-debugging-address=${CDP_HOST}`,
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    "about:blank",
  ];

  try {
    const child = (deps.spawnImpl ?? spawn)(chromeExe, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return { ok: true, child };
  } catch (err) {
    return { ok: false, error: `Failed to start Chrome: ${(err as Error).message}` };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function ensureChromeCdpRunning(
  cfg: ChromeDevtoolsConfig = config.chromeDevtools,
  deps: ChromeDevtoolsGuardDeps = {},
): Promise<ChromeCdpEnsureResult> {
  const port = normalizePort(cfg.port);
  if (!cfg.enabled) return { ok: true, started: false, port };

  const probe = await probeChromeCdp(port, deps);
  if (probe === "healthy") {
    return { ok: true, started: false, port };
  }
  if (probe === "occupied") {
    return {
      ok: false,
      started: false,
      port,
      error: `Port ${port} is reachable but is not a healthy Chrome CDP endpoint.`,
    };
  }

  const started = startChromeForCdp({ ...cfg, port }, deps);
  if (!started.ok) return { ok: false, started: false, port, error: started.error };

  for (let i = 0; i < START_VERIFY_ATTEMPTS; i++) {
    await sleep(START_VERIFY_DELAY_MS);
    if (await isChromeCdpHealthy(port, deps)) {
      return { ok: true, started: true, port };
    }
  }

  return { ok: false, started: true, port, error: "Chrome started but CDP endpoint is not healthy yet." };
}

async function runGuardOnce(reason: string, deps: ChromeDevtoolsGuardDeps = {}): Promise<void> {
  if (ensureInFlight) return;
  const log = deps.log ?? ((message: string) => console.log(message));
  ensureInFlight = ensureChromeCdpRunning(config.chromeDevtools, deps);
  try {
    const result = await ensureInFlight;
    appendStartupTrace("chrome-devtools-guard: ensure result", {
      reason,
      enabled: config.chromeDevtools.enabled,
      port: result.port,
      ok: result.ok,
      started: result.started,
      error: result.error,
    });
    if (!config.chromeDevtools.enabled) return;
    if (result.ok && result.started) {
      log(`[${ts()}] [Chrome CDP] Started Chrome for http://${CDP_HOST}:${result.port}/json/version`);
    } else if (!result.ok) {
      log(`[${ts()}] [Chrome CDP] Guard failed: ${result.error}`);
    }
  } finally {
    ensureInFlight = null;
  }
}

export function startChromeDevtoolsGuard(deps: ChromeDevtoolsGuardDeps = {}): void {
  stopChromeDevtoolsGuard();
  if (!config.chromeDevtools.enabled) {
    appendStartupTrace("chrome-devtools-guard: disabled");
    return;
  }

  void runGuardOnce("startup", deps);
  guardTimer = setInterval(() => {
    void runGuardOnce("interval", deps);
  }, GUARD_INTERVAL_MS);
}

export function stopChromeDevtoolsGuard(): void {
  if (guardTimer) {
    clearInterval(guardTimer);
    guardTimer = null;
  }
}
