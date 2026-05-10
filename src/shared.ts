import { execSync } from "node:child_process";
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";

import { printServiceDidNotStart } from "./exit-banner.ts";

/** 与 config.LOG_DIR 一致（避免 shared 依赖 config 造成循环引用） */
const BANNER_LOG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "logs");

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
// 文件日志：同时输出到控制台和日志文件
// ---------------------------------------------------------------------------

export function setupFileLogging(logDir: string, prefix: string): { logPath: string; flush: () => void } {
  mkdirSync(logDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const logPath = join(logDir, `${prefix}-${ts}.log`);
  const logStream = createWriteStream(logPath, { flags: "a" });
  const origConsoleLog = console.log.bind(console);
  const origConsoleError = console.error.bind(console);
  let pending = false;
  const writeLine = (level: string, args: unknown[]) => {
    const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    pending = true;
    logStream.write(`[${new Date().toISOString()}] [${level}] ${line}\n`, () => { pending = false; });
  };
  console.log = (...args: unknown[]) => {
    writeLine("LOG", args);
    origConsoleLog(...args);
  };
  console.error = (...args: unknown[]) => {
    writeLine("ERR", args);
    origConsoleError(...args);
  };
  const flush = () => {
    if (pending) logStream.end();
  };
  origConsoleLog(`Log file: ${logPath}`);
  return { logPath, flush };
}

// ---------------------------------------------------------------------------
// 本地 WebSocket 中继服务器（同一端口、多客户端广播）
// ---------------------------------------------------------------------------

export function createRelayServer(port: number): {
  server: WebSocketServer;
  broadcast: (data: unknown) => void;
} {
  const clients = new Set<WebSocket>();
  const server = new WebSocketServer({ host: "127.0.0.1", port });

  server.on("error", (err: NodeJS.ErrnoException) => {
    console.error(`[启动] 本地中继 WebSocket 监听失败：端口 ${port}（${err.code ?? "?"} — ${err.message}）`);
    console.error(
      "  处理建议: 关闭占用该端口的其它程序，或在 .env 中设置 CHATCCC_PORT=其它未占用端口（如 18081）。"
    );
    printServiceDidNotStart(`本地中继端口 ${port} 无法监听（${err.code ?? "?"} — ${err.message}）`);
    process.exit(1);
  });

  server.on("connection", (ws) => {
    console.log(`[RELAY] Client connected (total: ${clients.size + 1})`);
    clients.add(ws);
    ws.on("close", () => {
      clients.delete(ws);
      console.log(`[RELAY] Client disconnected (total: ${clients.size})`);
    });
    ws.on("error", () => { clients.delete(ws); });
  });

  console.log(`[RELAY] Local relay listening on ws://127.0.0.1:${port}`);

  const broadcast = (data: unknown): void => {
    const json = typeof data === "string" ? data : JSON.stringify(data);
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(json);
    }
  };

  return { server, broadcast };
}
