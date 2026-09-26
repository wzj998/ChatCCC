import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { PROJECT_ROOT, USER_DATA_DIR } from "./config.ts";
import { resolveNpmInvocation } from "./engines/engine-manager.ts";
import { appendStartupTrace } from "./shared.ts";

export const SELF_UPDATE_HELPER_READY_MESSAGE = "chatccc:self-update-helper-ready";
export const SELF_UPDATE_RESULT_ENV_VAR = "CHATCCC_SELF_UPDATE_RESULT";
export const SELF_UPDATE_ERROR_ENV_VAR = "CHATCCC_SELF_UPDATE_ERROR";

export interface SelfUpdateJob {
  schemaVersion: 1;
  parentPid: number;
  packageRoot: string;
  previousVersion: string;
  restartCwd: string;
  npmCommand: string;
  npmArgsPrefix: string[];
  runtimeCommand: string;
  runtimeEntry: string;
  resultFile: string;
  safeMaintenanceFile?: string;
  maxInstallAttempts?: number;
  parentExitTimeoutMs?: number;
  cleanupPaths?: string[];
}

export interface SpawnSelfUpdateHelperOptions {
  projectRoot?: string;
  userDataDir?: string;
  helperSourcePath?: string;
  parentPid?: number;
  npmInvocation?: { command: string; argsPrefix: string[] };
  spawnImpl?: typeof spawn;
  trace?: typeof appendStartupTrace;
}

type UpdateChildHandle = Pick<ChildProcess, "pid" | "exitCode" | "signalCode">
  & Partial<Pick<ChildProcess, "on" | "off" | "disconnect" | "connected" | "kill">>;

type HelperOutcome =
  | { kind: "ready" }
  | { kind: "exit" }
  | { kind: "error"; error: Error };

interface HelperMonitor {
  promise: Promise<HelperOutcome>;
  cancel(): void;
}

const helperMonitors = new WeakMap<object, HelperMonitor>();

function monitorSelfUpdateHelper(
  child: UpdateChildHandle,
  expectedParentPid: number,
): HelperMonitor {
  const existing = helperMonitors.get(child);
  if (existing) return existing;
  if (typeof child.on !== "function") {
    const unavailable: HelperMonitor = {
      promise: Promise.resolve({ kind: "exit" }),
      cancel() {},
    };
    helperMonitors.set(child, unavailable);
    return unavailable;
  }

  const addListener = child.on.bind(child) as (
    event: string,
    listener: (...args: any[]) => void,
  ) => unknown;
  const removeListener = typeof child.off === "function"
    ? child.off.bind(child) as (event: string, listener: (...args: any[]) => void) => unknown
    : undefined;
  let settlePromise: (outcome: HelperOutcome) => void = () => {};
  let settled = false;
  const cleanup = () => {
    removeListener?.("message", onMessage);
    removeListener?.("exit", onExit);
    removeListener?.("error", onError);
  };
  const settle = (outcome: HelperOutcome) => {
    if (settled) return;
    settled = true;
    cleanup();
    settlePromise(outcome);
  };
  const onMessage = (message: unknown) => {
    const ready = message as { type?: unknown; pid?: unknown; parentPid?: unknown } | null;
    if (!ready || ready.type !== SELF_UPDATE_HELPER_READY_MESSAGE) return;
    if (ready.parentPid !== expectedParentPid) return;
    if (typeof ready.pid === "number" && child.pid !== undefined && ready.pid !== child.pid) return;
    settle({ kind: "ready" });
  };
  const onExit = () => settle({ kind: "exit" });
  const onError = (error: Error) => settle({ kind: "error", error });
  const promise = new Promise<HelperOutcome>((resolvePromise) => {
    settlePromise = resolvePromise;
  });
  const monitor = { promise, cancel: cleanup };
  helperMonitors.set(child, monitor);
  addListener("message", onMessage);
  addListener("exit", onExit);
  addListener("error", onError);
  if (child.exitCode !== null || child.signalCode !== null) settle({ kind: "exit" });
  return monitor;
}

/**
 * 将更新器复制到 ~/.chatccc 后再启动。更新器本身和 cwd 都不位于 npm 包目录，
 * 因而主进程退出后 npm 可以在 Windows 上重命名或替换全局安装目录。
 */
export function spawnSelfUpdateHelper(
  options: SpawnSelfUpdateHelperOptions = {},
): ChildProcess {
  const projectRoot = options.projectRoot ?? PROJECT_ROOT;
  const userDataDir = options.userDataDir ?? USER_DATA_DIR;
  const helperSourcePath = options.helperSourcePath
    ?? join(projectRoot, "scripts", "self-update-helper.mjs");
  const parentPid = options.parentPid ?? process.pid;
  const npmInvocation = options.npmInvocation ?? resolveNpmInvocation();
  const spawnImpl = options.spawnImpl ?? spawn;
  const trace = options.trace ?? appendStartupTrace;
  const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")) as {
    name?: unknown;
    version?: unknown;
  };
  if (packageJson.name !== "chatccc" || typeof packageJson.version !== "string") {
    throw new Error("当前安装目录缺少有效的 chatccc package.json。");
  }

  const updateDir = join(userDataDir, "update");
  const logDir = join(userDataDir, "logs");
  mkdirSync(updateDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  const id = `${Date.now()}-${randomUUID()}`;
  const helperPath = join(updateDir, `self-update-helper-${id}.mjs`);
  const jobPath = join(updateDir, `self-update-job-${id}.json`);
  const resultFile = join(updateDir, `self-update-result-${id}.json`);
  copyFileSync(helperSourcePath, helperPath);

  const job: SelfUpdateJob = {
    schemaVersion: 1,
    parentPid,
    packageRoot: projectRoot,
    previousVersion: packageJson.version,
    restartCwd: userDataDir || homedir(),
    npmCommand: npmInvocation.command,
    npmArgsPrefix: [...npmInvocation.argsPrefix],
    runtimeCommand: process.execPath,
    runtimeEntry: join(projectRoot, "dist", "src", "index.js"),
    resultFile,
    safeMaintenanceFile: join(userDataDir, "state", "safe-maintenance.json"),
    cleanupPaths: [jobPath, helperPath],
  };
  writeFileSync(jobPath, JSON.stringify(job, null, 2), "utf8");

  const logPath = join(logDir, "update-watcher.log");
  const logFd = openSync(logPath, "a");
  const stdio: StdioOptions = ["ignore", logFd, logFd, "ipc"];
  trace("update: external helper spawn", {
    helperPath,
    jobPath,
    packageRoot: projectRoot,
    cwd: userDataDir,
  });
  try {
    const child = spawnImpl(process.execPath, [helperPath, jobPath], {
      cwd: userDataDir,
      detached: true,
      stdio,
      shell: false,
      windowsHide: true,
      env: process.env,
    });
    monitorSelfUpdateHelper(child, parentPid);
    return child;
  } finally {
    closeSync(logFd);
  }
}

/**
 * 只有外置更新器确认已读入任务后，主进程才可退出。若更新器早退或超时，
 * 保留当前服务并终止更新器，避免服务空窗。
 */
export async function waitForSelfUpdateHelperReady(
  child: UpdateChildHandle,
  timeoutMs = 5_000,
  trace: typeof appendStartupTrace = appendStartupTrace,
): Promise<boolean> {
  const monitor = helperMonitors.get(child) ?? monitorSelfUpdateHelper(child, process.pid);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<HelperOutcome>((resolvePromise) => {
    timer = setTimeout(() => resolvePromise({ kind: "exit" }), timeoutMs);
    timer.unref?.();
  });
  const outcome = await Promise.race([monitor.promise, timeout]);
  if (timer) clearTimeout(timer);
  monitor.cancel();

  if (outcome.kind === "ready") {
    if (child.connected && typeof child.disconnect === "function") {
      try { child.disconnect(); } catch { /* helper may disconnect first */ }
    }
    trace("update: external helper ready", { childPid: child.pid });
    return true;
  }
  if (typeof child.kill === "function") {
    try { child.kill(); } catch { /* best effort */ }
  }
  trace("update: external helper unavailable", {
    childPid: child.pid,
    outcome: outcome.kind,
    error: outcome.kind === "error" ? outcome.error.message : undefined,
  });
  return false;
}

