import { spawn, type ChildProcess } from "node:child_process";

const DEFAULT_SERVICE_HEALTH_INTERVAL_MS = 10_000;

interface RefTimer {
  ref?: () => unknown;
}

export interface ServiceLifecycleServer {
  listening: boolean;
  address: () => unknown;
  ref: () => unknown;
}

interface ServiceLifecycleGuardOptions {
  intervalMs?: number;
  setIntervalImpl?: (callback: () => void, delayMs: number) => RefTimer;
  clearIntervalImpl?: (timer: RefTimer) => void;
  tracer?: (message: string, extra?: Record<string, unknown>) => void;
  getActiveResourcesInfo?: () => string[];
}

export interface ServiceLifecycleGuard {
  start: () => void;
  attachServer: (
    server: ServiceLifecycleServer,
    recoverServer?: () => void | Promise<void>,
  ) => void;
  checkNow: () => Promise<void>;
  handleBeforeExit: (code: number) => void;
  beginShutdown: (reason: string) => void;
}

/**
 * 为 ChatCCC 这种常驻服务建立一个明确的进程生命周期锚点。
 *
 * 正常情况下，正在 listen 的 HTTP Server 自己就足以维持事件循环；额外的
 * referenced timer 是最后一道保险，避免某个依赖升级或异常 close/unref 让进程在
 * 没有信号、异常或退出码的情况下静默消失。定时检查同时会重新 ref Server，并在
 * Server 确实停止监听时串行触发恢复，避免只把一个失去服务能力的僵尸进程留下来。
 */
export function createServiceLifecycleGuard(
  options: ServiceLifecycleGuardOptions = {},
): ServiceLifecycleGuard {
  const intervalMs = options.intervalMs ?? DEFAULT_SERVICE_HEALTH_INTERVAL_MS;
  const setIntervalImpl = options.setIntervalImpl
    ?? ((callback, delayMs) => setInterval(callback, delayMs));
  const clearIntervalImpl = options.clearIntervalImpl
    ?? ((timer) => clearInterval(timer as NodeJS.Timeout));
  const tracer = options.tracer ?? (() => {});
  const getActiveResourcesInfo = options.getActiveResourcesInfo
    ?? (() => process.getActiveResourcesInfo());

  let timer: RefTimer | null = null;
  let server: ServiceLifecycleServer | null = null;
  let recoverServer: (() => void | Promise<void>) | undefined;
  let recoveryPromise: Promise<void> | null = null;
  let shuttingDown = false;

  const trace = (message: string, extra?: Record<string, unknown>): void => {
    try { tracer(message, extra); } catch { /* 诊断路径不能反过来打断服务 */ }
  };

  const serverAddress = (): unknown => {
    try { return server?.address() ?? null; } catch { return null; }
  };

  const activeResources = (): string[] => {
    try { return getActiveResourcesInfo(); } catch { return []; }
  };

  const diagnostics = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    ...extra,
    uptimeSeconds: Math.floor(process.uptime()),
    activeResources: activeResources(),
    serverAttached: server !== null,
    serverListening: server?.listening ?? false,
    serverAddress: serverAddress(),
  });

  const start = (): void => {
    if (shuttingDown || timer) return;
    timer = setIntervalImpl(() => { void checkNow(); }, intervalMs);
    // Node 的 Timeout 默认就是 ref 状态；显式 ref 让常驻服务契约不会依赖默认值。
    try { timer.ref?.(); } catch { /* ignore */ }
    trace("service-lifecycle: guard started", { intervalMs });
  };

  const checkNow = async (): Promise<void> => {
    if (shuttingDown || !server) return;
    if (server.listening) {
      try { server.ref(); } catch (err) {
        trace("service-lifecycle: HTTP server ref failed", diagnostics({
          error: (err as Error).message,
        }));
      }
      return;
    }

    if (recoveryPromise) return recoveryPromise;
    trace("service-lifecycle: HTTP server inactive", diagnostics());
    if (!recoverServer) return;

    recoveryPromise = Promise.resolve()
      .then(() => recoverServer?.())
      .then(() => {
        if (server?.listening) {
          try { server.ref(); } catch { /* 下一轮健康检查会再次尝试 */ }
          trace("service-lifecycle: HTTP server recovered", diagnostics());
        } else {
          trace("service-lifecycle: HTTP recovery completed without listening", diagnostics());
        }
      })
      .catch((err: unknown) => {
        trace("service-lifecycle: HTTP server recovery failed", diagnostics({
          error: err instanceof Error ? err.message : String(err),
        }));
      })
      .finally(() => {
        recoveryPromise = null;
      });
    return recoveryPromise;
  };

  const attachServer = (
    nextServer: ServiceLifecycleServer,
    nextRecoverServer?: () => void | Promise<void>,
  ): void => {
    server = nextServer;
    recoverServer = nextRecoverServer;
    if (server.listening) {
      try { server.ref(); } catch { /* 下一轮健康检查会记录 */ }
    }
    trace("service-lifecycle: HTTP server attached", diagnostics());
  };

  const handleBeforeExit = (code: number): void => {
    if (shuttingDown) return;
    trace("service-lifecycle: unexpected beforeExit", diagnostics({ code }));
    start();
    void checkNow();
  };

  const beginShutdown = (reason: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (timer) {
      try { clearIntervalImpl(timer); } catch { /* process 即将退出 */ }
      timer = null;
    }
    trace("service-lifecycle: shutdown requested", { reason });
  };

  return { start, attachServer, checkNow, handleBeforeExit, beginShutdown };
}

/**
 * ChatCCC 自己拉起替代进程时使用的内部标记。
 *
 * 不能用“是否已有配置”判断是否打开控制台：首次配置和日常直接启动都应该
 * 打开，而 `/restart`、`/update` 和 Web UI 重启都不应该打扰用户。环境变量
 * 会自然穿过 cmd/bash/npx 这几层启动器，因此也适用于 Windows 与 Linux。
 */
export const INTERNAL_RESTART_ENV_VAR = "CHATCCC_INTERNAL_RESTART";
export const INTERNAL_RESTART_PARENT_PID_ENV_VAR = "CHATCCC_RESTART_PARENT_PID";
export const INTERNAL_RESTART_READY_MESSAGE = "chatccc:restart-handoff-ready";

type Environment = Record<string, string | undefined>;

export function createInternalRestartEnv(
  inherited: Environment = process.env,
  parentPid: number = process.pid,
): NodeJS.ProcessEnv {
  return {
    ...inherited,
    [INTERNAL_RESTART_ENV_VAR]: "1",
    [INTERNAL_RESTART_PARENT_PID_ENV_VAR]: String(parentPid),
  };
}

type RestartIpcSend = (
  message: { type: typeof INTERNAL_RESTART_READY_MESSAGE; pid: number; parentPid: number },
  callback: (error: Error | null) => void,
) => boolean;

interface AnnounceInternalRestartReadyOptions {
  env?: Environment;
  pid?: number;
  send?: RestartIpcSend;
  timeoutMs?: number;
}

/**
 * Tell the current parent that the replacement runtime loaded successfully and
 * is ready to wait for the listening port. Older parents do not provide IPC;
 * returning false preserves the port-wait fallback used during an upgrade from
 * a pre-handoff ChatCCC version.
 */
export async function announceInternalRestartReady(
  options: AnnounceInternalRestartReadyOptions = {},
): Promise<boolean> {
  const env = options.env ?? process.env;
  if (env[INTERNAL_RESTART_ENV_VAR] !== "1") return false;
  const send = options.send ?? (typeof process.send === "function"
    ? process.send.bind(process) as RestartIpcSend
    : undefined);
  if (!send) return false;

  const pid = options.pid ?? process.pid;
  const parentPid = Number(env[INTERNAL_RESTART_PARENT_PID_ENV_VAR]);
  if (!Number.isInteger(parentPid) || parentPid <= 0) return false;
  const timeoutMs = options.timeoutMs ?? 2_000;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    try {
      send({ type: INTERNAL_RESTART_READY_MESSAGE, pid, parentPid }, (error) => finish(!error));
    } catch {
      finish(false);
    }
  });
}

/** 用户直接启动时打开；ChatCCC 内部重启产生的替代进程不打开。 */
interface AutoOpenWebUiOptions {
  env?: Environment;
  openOnStart?: boolean;
}

export function shouldAutoOpenWebUi(options: AutoOpenWebUiOptions = {}): boolean {
  const env = options.env ?? process.env;
  return options.openOnStart !== false && env[INTERNAL_RESTART_ENV_VAR] !== "1";
}

/** Web UI 始终使用 localhost，并跟随实际配置端口。 */
export function buildWebUiUrl(port: number): string {
  return `http://localhost:${port}/`;
}

interface OpenBrowserDeps {
  platform?: NodeJS.Platform;
  env?: Environment;
  spawnImpl?: typeof spawn;
  onError?: (message: string) => void;
  onInfo?: (message: string) => void;
}

/**
 * 调用操作系统默认浏览器打开 Web UI，与 Chrome CDP 守护功能完全独立。
 * 返回值仅表示打开请求是否成功发起；浏览器是否复用标签页由系统浏览器决定。
 */
export function openWebUiInDefaultBrowser(
  port: number,
  deps: OpenBrowserDeps = {},
): boolean {
  const url = buildWebUiUrl(port);
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const spawnImpl = deps.spawnImpl ?? spawn;
  const onError = deps.onError ?? ((message: string) => console.error(message));
  const onInfo = deps.onInfo ?? ((message: string) => console.log(message));

  // Linux 服务器通常没有图形会话。此时调用 xdg-open 只会制造噪音；
  // 直接给出可复制的 SSH 隧道命令，让用户从自己的电脑访问本地 Web UI。
  if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    onInfo(
      `[WEB-UI] 未检测到 Linux 图形桌面，跳过自动打开浏览器。` +
      `可在本机执行 ssh -L ${port}:127.0.0.1:${port} <user>@<server>，` +
      `然后访问 ${url}`,
    );
    return false;
  }

  try {
    let child: ChildProcess;
    if (platform === "win32") {
      // `start` 会把第一个带引号的参数当窗口标题，空字符串是必要占位符。
      child = spawnImpl("cmd.exe", ["/c", "start", "", url], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
    } else if (platform === "darwin") {
      child = spawnImpl("open", [url], { detached: true, stdio: "ignore" });
    } else {
      child = spawnImpl("xdg-open", [url], { detached: true, stdio: "ignore" });
    }
    child.on("error", (err) => {
      onError(`[WEB-UI] 自动打开浏览器失败: ${err.message}`);
    });
    child.unref();
    return true;
  } catch (err) {
    onError(`[WEB-UI] 自动打开浏览器失败: ${(err as Error).message}`);
    return false;
  }
}
