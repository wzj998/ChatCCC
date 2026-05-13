import { execSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { WebSocketServer, WebSocket } from "ws";

import { printServiceDidNotStart } from "./exit-banner.ts";

/** 与 config.LOG_DIR 一致（避免 shared 依赖 config 造成循环引用） */
const BANNER_LOG_DIR = join(homedir(), ".chatccc", "logs");

const STARTUP_TRACE_FILE = join(BANNER_LOG_DIR, "startup-trace.log");

/**
 * 同步写入启动诊断日志（不依赖 console 劫持与 stream 缓冲）。
 * 用于单实例清理 / taskkill 等可能导致进程突然退出的场景，便于对照 index-*.log 排查。
 */
export function appendStartupTrace(message: string, extra?: Record<string, unknown>): void {
  try {
    mkdirSync(BANNER_LOG_DIR, { recursive: true });
    const suffix = extra !== undefined && Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : "";
    appendFileSync(
      STARTUP_TRACE_FILE,
      `[${new Date().toISOString()}] pid=${process.pid} ppid=${process.ppid} cwd=${process.cwd()} | ${message}${suffix}\n`,
      "utf-8"
    );
  } catch {
    // 诊断日志自身不得影响主流程
  }
}

// ---------------------------------------------------------------------------
// 进程树：当前进程及其所有祖先（用于避免 taskkill /T 误杀启动链）
// ---------------------------------------------------------------------------

/** 自当前 PID 沿父链上溯直到系统进程，包含自身 */
export function getProcessAncestorPidSet(): Set<number> {
  const ancestors = new Set<number>();
  let cur: number = process.pid;
  const maxHops = 48;
  for (let i = 0; i < maxHops; i++) {
    ancestors.add(cur);
    if (cur <= 4) break;
    let parent: number | undefined;
    if (process.platform === "win32") {
      try {
        const out = execSync(
          `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${cur}' -ErrorAction SilentlyContinue).ParentProcessId"`,
          { encoding: "utf8", timeout: 3000, stdio: "pipe", windowsHide: true }
        ).trim();
        parent = parseInt(out, 10);
      } catch {
        parent = undefined;
      }
    } else {
      try {
        const st = readFileSync(`/proc/${cur}/stat`, "utf8");
        const rp = st.lastIndexOf(")");
        const fields = st.slice(rp + 2).trim().split(/\s+/);
        parent = parseInt(fields[1] ?? "", 10);
      } catch {
        parent = undefined;
      }
    }
    if (parent === undefined || Number.isNaN(parent) || parent === cur) break;
    cur = parent;
  }
  return ancestors;
}

// ---------------------------------------------------------------------------
// 杀死进程
// ---------------------------------------------------------------------------

export function killByPid(pid: string | number): void {
  const pidNum = typeof pid === "string" ? parseInt(pid, 10) : pid;
  appendStartupTrace("killByPid: begin", { target: pidNum, self: process.pid, ppid: process.ppid });
  try {
    process.kill(pidNum, "SIGTERM");
  } catch {
    // 不存在，忽略
  }
  let taskkillOut = "";
  try {
    taskkillOut = execSync(`taskkill /PID ${pidNum} /F /T`, { encoding: "utf8", stdio: "pipe" });
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    const s = (x: Buffer | string | undefined) =>
      (typeof x === "string" ? x : x?.toString("utf8") ?? "").trim().slice(0, 500);
    appendStartupTrace("killByPid: taskkill threw (often 进程不存在)", {
      target: pidNum,
      status: err.status,
      stdout: s(err.stdout),
      stderr: s(err.stderr),
    });
    return;
  }
  appendStartupTrace("killByPid: taskkill ok", { target: pidNum, stdout: String(taskkillOut).trim().slice(0, 500) });
}

// ---------------------------------------------------------------------------
// 在绑定中继端口之前：结束占用该端口的 LISTENING/UDP 绑定进程（任意类型，非祖先链）
// ---------------------------------------------------------------------------

function collectListeningPidsOnPortWindows(port: number, netstatOut: string): number[] {
  const portToken = `:${port}`;
  const seen = new Set<number>();
  const out: number[] = [];
  for (const rawLine of netstatOut.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const upper = line.toUpperCase();
    if (upper.startsWith("TCP")) {
      if (!upper.includes("LISTENING")) continue;
      if (!line.includes(portToken)) continue;
    } else if (upper.startsWith("UDP")) {
      if (!line.includes(portToken)) continue;
    } else {
      continue;
    }
    const m = line.match(/(\d+)\s*$/);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (Number.isNaN(n) || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/** 在 createRelayServer 之前调用：清掉本机该端口上仍在监听的旧进程（不杀当前进程树祖先） */
export function freeRelayListenPort(port: number): void {
  const ancestors = getProcessAncestorPidSet();
  appendStartupTrace("freeRelayListenPort: begin", {
    port,
    ancestorPids: [...ancestors].sort((a, b) => a - b).join(","),
  });

  if (process.platform !== "win32") {
    appendStartupTrace("freeRelayListenPort: skip (non-Windows)", { port });
    return;
  }

  try {
    const portOut = execSync(`netstat -ano | findstr :${port}`, { encoding: "utf8", windowsHide: true });
    const pids = collectListeningPidsOnPortWindows(port, portOut);
    appendStartupTrace("freeRelayListenPort: listening PIDs", { port, pids: pids.join(",") || "(none)" });
    for (const pidNum of pids) {
      if (ancestors.has(pidNum)) continue;
      console.log(`[KILL] Free port ${port}: killing LISTENING/UDP holder PID ${pidNum}...`);
      appendStartupTrace("freeRelayListenPort: killByPid", { port, pid: pidNum });
      killByPid(pidNum);
    }
  } catch {
    appendStartupTrace("freeRelayListenPort: netstat/findstr (no rows or error)", { port });
  }
  appendStartupTrace("freeRelayListenPort: end", { port });
}

// ---------------------------------------------------------------------------
// 单实例保证：PID 文件互斥（端口占用在 freeRelayListenPort + 监听前处理）
// ---------------------------------------------------------------------------

export function cleanupPidFile(pidFile: string): void {
  try {
    if (existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() === String(process.pid)) {
      unlinkSync(pidFile);
    }
  } catch { /* ok */ }
}

export function ensureSingleInstance(pidFile: string): void {
  const ancestors = getProcessAncestorPidSet();
  appendStartupTrace("ensureSingleInstance: begin", { pidFile });
  if (existsSync(pidFile)) {
    const oldPid = readFileSync(pidFile, "utf8").trim();
    const oldPidNum = parseInt(oldPid, 10);
    if (oldPid && oldPid !== String(process.pid)) {
      if (!Number.isNaN(oldPidNum) && ancestors.has(oldPidNum)) {
        appendStartupTrace("ensureSingleInstance: skip killing pid from file (in ancestor chain)", { oldPid });
      } else {
        console.log(`[INSTANCE] Killing old PID from file: ${oldPid}...`);
        appendStartupTrace("ensureSingleInstance: killing pid from file", { oldPid });
        killByPid(oldPid);
      }
    } else {
      appendStartupTrace("ensureSingleInstance: pid file present, skip self", { oldPid, self: process.pid });
    }
  } else {
    appendStartupTrace("ensureSingleInstance: no pid file yet");
  }

  mkdirSync(join(pidFile, ".."), { recursive: true });
  writeFileSync(pidFile, String(process.pid));
  console.log(`[INSTANCE] Registered PID ${process.pid}`);
  appendStartupTrace("ensureSingleInstance: registered", { pid: process.pid });

  // 进程退出时自动清理 PID 文件；SIGINT/SIGTERM 由各 main() 自行接管
  process.on("exit", (code) => {
    appendStartupTrace("process exit handler", { code, pid: process.pid });
    cleanupPidFile(pidFile);
  });
}

// ---------------------------------------------------------------------------
// 崩溃黑匣子：进程级别异常 / 信号 / beforeExit 同步落盘
// ---------------------------------------------------------------------------
//
// 设计要点：
// 1) 全部经由 appendStartupTrace（appendFileSync 同步写盘），保证进程立即退出
//    时也能落盘。console.error 走的是 createWriteStream 异步缓冲，会丢日志。
// 2) 默认 onFatal 会主动 process.exit(1)。在 Node 20+ 注册了 unhandledRejection
//    handler 后，默认不再致命退出，会让进程卡在 broken state——主动 exit 让
//    现象更直观，方便重启与诊断。
// 3) handler 实现拆成 buildCrashLoggingHandlers（纯函数，无副作用，便于单测）
//    和 installCrashLogging（把 handler 挂到 process 上，返回 cleanup）。

const FATAL_STACK_MAX = 4000;

export interface CrashHandlersOptions {
  /** 用于写入诊断的同步函数，默认 appendStartupTrace */
  tracer?: (message: string, extra?: Record<string, unknown>) => void;
  /** 用于刷新文件日志缓冲，默认 noop */
  flush?: () => void;
  /** 致命异常发生后的处理，默认 console.error + process.exit(1) */
  onFatal?: (kind: "uncaughtException" | "unhandledRejection", err: Error) => void;
  /** 信号到来时的处理，默认 noop（清理动作由调用方自己注册其它 listener 完成） */
  onSignal?: (sig: NodeJS.Signals) => void;
  /** beforeExit 时的处理，默认 noop */
  onBeforeExit?: (code: number) => void;
}

export interface CrashLoggingHandlers {
  uncaughtException: (err: unknown) => void;
  unhandledRejection: (reason: unknown) => void;
  signalLogger: (sig: NodeJS.Signals) => void;
  beforeExit: (code: number) => void;
}

function coerceError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  if (typeof reason === "string") return new Error(reason);
  if (reason === undefined) return new Error("unhandled rejection with reason=undefined");
  if (reason === null) return new Error("unhandled rejection with reason=null");
  try {
    return new Error(JSON.stringify(reason));
  } catch {
    return new Error(String(reason));
  }
}

function truncateStack(stack: string | undefined): string {
  if (!stack) return "";
  return stack.length > FATAL_STACK_MAX
    ? `${stack.slice(0, FATAL_STACK_MAX)}...(truncated)`
    : stack;
}

function safeCall<T extends unknown[]>(fn: ((...args: T) => unknown) | undefined, ...args: T): void {
  if (!fn) return;
  try { fn(...args); } catch { /* swallow: 诊断路径不允许二次抛错 */ }
}

export function buildCrashLoggingHandlers(opts: CrashHandlersOptions = {}): CrashLoggingHandlers {
  const tracer = opts.tracer ?? appendStartupTrace;
  const flush = opts.flush;
  const onFatal = opts.onFatal ?? ((kind, err) => {
    try {
      // 这里仍然走 console.error，是为了让终端 / 文件日志都看得见；但同步 trace 是主线
      console.error(`[FATAL] ${kind}: ${err.message}\n${err.stack ?? ""}`);
    } catch { /* ignore */ }
    process.exit(1);
  });
  const onSignal = opts.onSignal;
  const onBeforeExit = opts.onBeforeExit;

  const handleFatal = (kind: "uncaughtException" | "unhandledRejection", reason: unknown): void => {
    const err = coerceError(reason);
    safeCall(tracer, `FATAL ${kind}`, {
      message: err.message,
      stack: truncateStack(err.stack),
    });
    safeCall(flush);
    onFatal(kind, err);
  };

  return {
    uncaughtException: (err) => handleFatal("uncaughtException", err),
    unhandledRejection: (reason) => handleFatal("unhandledRejection", reason),
    signalLogger: (sig) => {
      safeCall(tracer, "signal received", { signal: sig });
      safeCall(flush);
      safeCall(onSignal, sig);
    },
    beforeExit: (code) => {
      safeCall(tracer, "beforeExit", { code });
      safeCall(onBeforeExit, code);
    },
  };
}

export interface InstallCrashLoggingResult {
  handlers: CrashLoggingHandlers;
  cleanup: () => void;
}

/**
 * 把崩溃黑匣子 handler 装到 process 上，返回 cleanup。
 *
 * 注意：本函数只负责 trace + 默认 fatal 退出，**不**接管原有 SIGINT/SIGTERM 清理逻辑
 * （如 relayServer.close）。让调用方在 installCrashLogging 之后再 process.on('SIGINT', ...)
 * 注册自己的清理动作即可——Node EventEmitter 会按注册顺序调用所有 listener，trace 同步
 * 写盘后再走清理，结果稳定。
 */
export function installCrashLogging(opts: CrashHandlersOptions = {}): InstallCrashLoggingResult {
  const handlers = buildCrashLoggingHandlers(opts);

  const registrations: Array<{ event: string; fn: (...args: unknown[]) => void }> = [];
  const add = (event: string, fn: (...args: unknown[]) => void): void => {
    process.on(event as Parameters<typeof process.on>[0], fn);
    registrations.push({ event, fn });
  };

  add("uncaughtException", (err) => handlers.uncaughtException(err));
  add("unhandledRejection", (reason) => handlers.unhandledRejection(reason));
  add("beforeExit", (code) => handlers.beforeExit(code as number));

  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  if (process.platform === "win32") signals.push("SIGBREAK");
  for (const sig of signals) {
    add(sig, () => handlers.signalLogger(sig));
  }

  return {
    handlers,
    cleanup: () => {
      for (const { event, fn } of registrations) {
        process.off(event as Parameters<typeof process.off>[0], fn);
      }
      registrations.length = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// 文件日志：同时输出到控制台和日志文件
// ---------------------------------------------------------------------------

export function setupFileLogging(logDir: string, prefix: string): { logPath: string; flush: () => void } {
  mkdirSync(logDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const logPath = join(logDir, `${prefix}-${ts}.log`);
  writeFileSync(logPath, "", { flag: "a", encoding: "utf8" });
  const origConsoleLog = console.log.bind(console);
  const origConsoleError = console.error.bind(console);
  const formatArg = (arg: unknown): string => {
    if (typeof arg === "string") return arg;
    if (arg instanceof Error) return arg.stack ?? arg.message;
    return inspect(arg, { depth: 6, breakLength: Infinity, maxArrayLength: 200 });
  };
  const writeLine = (level: string, args: unknown[]) => {
    try {
      const line = args.map(formatArg).join(" ");
      appendFileSync(logPath, `[${new Date().toISOString()}] [${level}] ${line}\n`, "utf8");
    } catch (err) {
      try {
        appendStartupTrace("fileLog write failed", { level, error: err instanceof Error ? err.message : String(err) });
      } catch {
        // 日志系统自身不能影响主流程
      }
    }
  };
  console.log = (...args: unknown[]) => {
    writeLine("LOG", args);
    try {
      origConsoleLog(...args);
    } catch {
      // 控制台输出失败也不能拖垮服务
    }
  };
  console.error = (...args: unknown[]) => {
    writeLine("ERR", args);
    try {
      origConsoleError(...args);
    } catch {
      // 控制台输出失败也不能拖垮服务
    }
  };
  const flush = () => {
    try {
      appendFileSync(logPath, "", "utf8");
    } catch (err) {
      appendStartupTrace("fileLog flush failed", { error: err instanceof Error ? err.message : String(err) });
    }
  };
  origConsoleLog(`Log file: ${logPath}`);
  return { logPath, flush };
}

// ---------------------------------------------------------------------------
// 本地 WebSocket 中继服务器（同一端口、多客户端广播）
// ---------------------------------------------------------------------------

/**
 * 把 WS 中继挂到一个**已存在**的 httpServer 上（不负责 listen / close）。
 *
 * 之所以拆出来：setup → service「在线切换」复用同一个 httpServer，
 * 避免 close + recreate 在 Windows 下的端口释放竞态（EADDRINUSE 抖动）。
 *
 * 调用方负责 httpServer 的生命周期管理（listen / 错误处理 / close）。
 */
export function attachRelayWebSocket(httpServer: ReturnType<typeof createServer>): {
  broadcast: (data: unknown) => void;
  close: () => void;
} {
  const clients = new Set<WebSocket>();
  const wsServer = new WebSocketServer({ server: httpServer });

  wsServer.on("connection", (ws) => {
    console.log(`[RELAY] Client connected (total: ${clients.size + 1})`);
    clients.add(ws);
    ws.on("close", () => {
      clients.delete(ws);
      console.log(`[RELAY] Client disconnected (total: ${clients.size})`);
    });
    ws.on("error", () => { clients.delete(ws); });
  });

  const broadcast = (data: unknown): void => {
    const json = typeof data === "string" ? data : JSON.stringify(data);
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(json);
    }
  };

  // close 用于 setup-activate 失败回滚：解绑 WSServer 在 httpServer 上注册的
  // upgrade 监听并断开所有客户端，避免下次重试 attach 时重复挂载导致泄漏。
  // httpServer 本身不在这里关——它在 setup 模式下还要继续给前端服务。
  const close = (): void => {
    for (const ws of clients) {
      try { ws.terminate(); } catch { /* ok */ }
    }
    clients.clear();
    try { wsServer.close(); } catch { /* ok */ }
  };

  return { broadcast, close };
}

export function createRelayServer(port: number): {
  server: ReturnType<typeof createServer>;
  broadcast: (data: unknown) => void;
} {
  const httpServer = createServer();

  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    console.error(`[启动] 本地中继 WebSocket 监听失败：端口 ${port}（${err.code ?? "?"} — ${err.message}）`);
    console.error(
      "  处理建议: 关闭占用该端口的其它程序，或在 config.json 的 port 字段里改成其它未占用端口（如 18081）。"
    );
    printServiceDidNotStart(`本地中继端口 ${port} 无法监听（${err.code ?? "?"} — ${err.message}）`);
    process.exit(1);
  });

  const { broadcast } = attachRelayWebSocket(httpServer);

  httpServer.listen(port, "127.0.0.1", () => {
    console.log(`[RELAY] Local relay listening on ws://127.0.0.1:${port}`);
  });

  return { server: httpServer, broadcast };
}
