import { execSync } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { WebSocketServer, WebSocket } from "ws";

// ---------------------------------------------------------------------------
// 杀死进程
// ---------------------------------------------------------------------------

export function killByPid(pid: string | number): void {
  const pidNum = typeof pid === "string" ? parseInt(pid, 10) : pid;
  try {
    process.kill(pidNum, "SIGTERM");
  } catch {
    // 不存在，忽略
  }
  try {
    execSync(`taskkill /PID ${pidNum} /F /T`, { encoding: "utf8", stdio: "pipe" });
  } catch {
    // taskkill 失败通常意味着进程已不在
  }
}

// ---------------------------------------------------------------------------
// 清理指定端口上的旧进程 + 杀所有本项目的 node/tsx 残留进程
// ---------------------------------------------------------------------------

export function killAllProjectProcesses(port?: number): void {
  // PowerShell 找出所有跑本项目脚本的 node/tsx 进程
  try {
    const psCmd =
      `Get-CimInstance Win32_Process -Filter 'name=''node.exe'' or name=''tsx.exe''' | ` +
      `Where-Object { $_.CommandLine -like '*FeishuClauder*' -and $_.ProcessId -ne ${process.pid} -and $_.ProcessId -ne ${process.ppid} } | ` +
      `Select-Object -ExpandProperty ProcessId`;
    const out = execSync(`powershell -NoProfile -Command "${psCmd}"`, {
      encoding: "utf8",
      timeout: 10000,
    });
    for (const pid of out.trim().split(/\s+/)) {
      if (pid && pid !== String(process.pid)) {
        console.log(`[KILL] Killing project process PID ${pid}...`);
        killByPid(pid);
      }
    }
  } catch {
    // 回退到 wmic
    try {
      const out = execSync(
        'wmic process where "name=\'node.exe\' or name=\'tsx.exe\'" get processid,commandline /format:csv',
        { encoding: "utf8", timeout: 5000 }
      );
      const lines = out.trim().split("\n");
      for (const line of lines) {
        if (!line.includes("FeishuClauder") || line.includes(process.pid!.toString()) || line.includes(process.ppid!.toString())) continue;
        const fields = line.split(",");
        const pid = fields[1]?.trim();
        if (pid && /^\d+$/.test(pid)) {
          console.log(`[KILL] Killing project process PID ${pid}...`);
          killByPid(pid);
        }
      }
    } catch {
      // 都不行，不阻塞启动
    }
  }

  // 端口补刀
  if (port !== undefined) {
    try {
      const portOut = execSync(`netstat -ano | findstr :${port}`, { encoding: "utf8" });
      for (const line of portOut.trim().split("\n")) {
        const m = line.match(/(\d+)\s*$/);
        if (m && m[1] !== process.pid!.toString() && m[1] !== process.ppid!.toString()) {
          console.log(`[KILL] Killing process on port ${port} PID ${m[1]}...`);
          killByPid(m[1]);
        }
      }
    } catch {
      // 端口无人占用
    }
  }
}

// ---------------------------------------------------------------------------
// 单实例保证：PID 文件互斥 + 激进杀残余进程
// ---------------------------------------------------------------------------

export function cleanupPidFile(pidFile: string): void {
  try {
    if (existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() === String(process.pid)) {
      unlinkSync(pidFile);
    }
  } catch { /* ok */ }
}

export function ensureSingleInstance(pidFile: string, port?: number): void {
  if (existsSync(pidFile)) {
    const oldPid = readFileSync(pidFile, "utf8").trim();
    if (oldPid && oldPid !== String(process.pid)) {
      console.log(`[INSTANCE] Killing old PID from file: ${oldPid}...`);
      killByPid(oldPid);
    }
  }

  killAllProjectProcesses(port);

  mkdirSync(join(pidFile, ".."), { recursive: true });
  writeFileSync(pidFile, String(process.pid));
  console.log(`[INSTANCE] Registered PID ${process.pid}`);

  // 进程退出时自动清理 PID 文件；SIGINT/SIGTERM 由各 main() 自行接管
  process.on("exit", () => cleanupPidFile(pidFile));
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
