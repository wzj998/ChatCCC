// =============================================================================
// codex-app-server.ts — Codex CLI app-server 进程管理 + JSON-RPC 客户端
// =============================================================================
// Codex CLI 的 app-server 模式：一个常驻进程托管多个 thread（会话），每个
// thread 内可有一个活跃 turn。相比 `codex exec` 一次性子进程，app-server 支持：
//   - turn/steer   : 运行中向当前 turn 注入新消息（协作式让位，对齐 ccc）
//   - turn/interrupt : 打断当前 turn（不影响同进程内其他 thread）
//   - thread/resume  : 按 thread_id 从磁盘恢复持久化线程
//
// 本文件提供：
//   - JsonRpcClient         : WebSocket JSON-RPC 客户端
//   - CodexAppServerManager : 单例常驻进程生命周期（懒启动 + 跨平台收尸）
//
// 协议字段名以 `codex app-server generate-ts` 导出的官方绑定为准：
//   - thread/start 用 `sandbox: "danger-full-access"`（字符串枚举）
//   - turn/start   用 `sandboxPolicy: { type: "dangerFullAccess" }`（对象）
// =============================================================================

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import WebSocket from "ws";
import { killProcessTree } from "./proc-tree-kill.ts";

// ---------------------------------------------------------------------------
// 精简协议类型（仅声明 adapter 用到的字段，其余运行时透传）
// ---------------------------------------------------------------------------

export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexApprovalPolicy = "untrusted" | "on-request" | "never";
export type CodexTurnStatus = "completed" | "interrupted" | "failed" | "inProgress";

export interface CodexUserInputText {
  type: "text";
  text: string;
  text_elements: unknown[];
}

export interface CodexSandboxPolicy {
  type: "dangerFullAccess" | "readOnly" | "workspaceWrite" | "externalSandbox";
  networkAccess?: boolean;
  [key: string]: unknown;
}

export interface CodexThread {
  id: string;
  [key: string]: unknown;
}

export interface CodexTurn {
  id: string;
  status: CodexTurnStatus;
  error?: { message?: string } | null;
  [key: string]: unknown;
}

/** 服务端推送的通知（无 id） */
export interface CodexNotification {
  method: string;
  params: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// AsyncQueue — 把 WebSocket 通知流转换成 async iterable
// ---------------------------------------------------------------------------

export class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: Array<(item: T | null) => void> = [];
  private ended = false;

  push(item: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter(item);
    else this.items.push(item);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter(null);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    const queue = this;
    return {
      async next(): Promise<IteratorResult<T>> {
        if (queue.items.length > 0) {
          return { value: queue.items.shift()!, done: false };
        }
        if (queue.ended) {
          return { value: undefined as unknown as T, done: true };
        }
        const value = await new Promise<T | null>((resolve) => {
          queue.waiters.push(resolve);
        });
        if (value === null) {
          return { value: undefined as unknown as T, done: true };
        }
        return { value, done: false };
      },
    };
  }
}

// ---------------------------------------------------------------------------
// JsonRpcClient — WebSocket JSON-RPC
// ---------------------------------------------------------------------------

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class JsonRpcClient {
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  onNotification: ((method: string, params: Record<string, unknown>) => void) | null = null;
  onServerRequest:
    | ((method: string, params: Record<string, unknown>, id: number) => void)
    | null = null;
  onClose: (() => void) | null = null;

  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (data) => this.handleMessage(data.toString()));
    ws.on("close", () => this.handleClose());
    ws.on("error", () => {
      /* 关闭路径统一走 close 事件 */
    });
  }

  static async connect(url: string): Promise<JsonRpcClient> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", (err) => reject(new Error(`codex app-server 连接失败: ${err.message}`)));
    });
    return new JsonRpcClient(ws);
  }

  private handleMessage(raw: string): void {
    let msg: {
      id?: number;
      method?: string;
      result?: unknown;
      error?: unknown;
      params?: Record<string, unknown>;
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // 响应（有 id、无 method）→ resolve 对应 pending 请求
    if (msg.id !== undefined && msg.method === undefined) {
      const pendingReq = this.pending.get(msg.id);
      if (pendingReq) {
        this.pending.delete(msg.id);
        clearTimeout(pendingReq.timer);
        if (msg.error !== undefined && msg.error !== null) {
          pendingReq.reject(new Error(JSON.stringify(msg.error)));
        } else {
          pendingReq.resolve(msg.result);
        }
      }
      return;
    }

    // 服务端请求（有 method + id）→ 需要客户端 respond
    if (msg.method !== undefined && msg.id !== undefined) {
      this.onServerRequest?.(msg.method, msg.params ?? {}, msg.id);
      return;
    }

    // 服务端通知（有 method、无 id）
    if (msg.method !== undefined) {
      this.onNotification?.(msg.method, msg.params ?? {});
    }
  }

  private handleClose(): void {
    const err = new Error("codex app-server 连接已关闭");
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.onClose?.();
  }

  request(method: string, params: Record<string, unknown>, timeoutMs = 120000): Promise<any> {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ method, id, params }));
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server 请求超时: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  respond(id: number, result: unknown): void {
    this.ws.send(JSON.stringify({ id, result }));
  }

  respondError(id: number, code: number, message: string): void {
    this.ws.send(JSON.stringify({ id, error: { code, message } }));
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// 端口选择 / 就绪等待（跨平台）
// ---------------------------------------------------------------------------

async function pickFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
  return port;
}

async function waitForReady(port: number, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/readyz`);
      if (r.ok) return;
    } catch {
      /* not ready yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("codex app-server 启动超时（readyz 未就绪）");
}

// ---------------------------------------------------------------------------
// CodexAppServerManager — 单例常驻进程生命周期
// ---------------------------------------------------------------------------

export class CodexAppServerManager {
  private static instance: CodexAppServerManager | null = null;

  private proc: ChildProcess | null = null;
  private port: number | null = null;
  private starting: Promise<number> | null = null;
  private cleanupRegistered = false;

  static get(): CodexAppServerManager {
    if (!CodexAppServerManager.instance) {
      CodexAppServerManager.instance = new CodexAppServerManager();
    }
    return CodexAppServerManager.instance;
  }

  ensureStarted(command: string): Promise<number> {
    if (this.port !== null) return Promise.resolve(this.port);
    if (this.starting) return this.starting;
    this.starting = this.start(command);
    return this.starting;
  }

  private async start(command: string): Promise<number> {
    const port = await pickFreePort();
    const proc = spawn(command, ["app-server", "--listen", `ws://127.0.0.1:${port}`], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      // Windows 下 npm 全局安装的 codex 是 .cmd shim，需经 shell 解析；
      // Unix 下直接 exec 二进制，避免 shell:true 的转义风险与 deprecation 警告。
      shell: process.platform === "win32",
    });
    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.once("error", (err) => {
      console.error(`[Codex app-server] spawn 失败: ${err.message}`);
    });
    proc.on("close", (code) => {
      if (this.proc === proc) {
        this.proc = null;
        this.port = null;
      }
      if (code !== 0 && stderr.trim()) {
        console.error(`[Codex app-server] 退出码=${code}: ${stderr.trim().slice(0, 2000)}`);
      }
    });

    try {
      await waitForReady(port);
    } catch (err) {
      void killProcessTree(proc.pid);
      throw err;
    }

    this.proc = proc;
    this.port = port;
    this.registerCleanup();
    return port;
  }

  /** 主进程退出时尽力收尸（Windows taskkill / Unix SIGTERM），避免孤儿常驻进程。 */
  private registerCleanup(): void {
    if (this.cleanupRegistered) return;
    this.cleanupRegistered = true;
    const cleanup = () => {
      const pid = this.proc?.pid;
      if (pid === undefined) return;
      try {
        if (process.platform === "win32") {
          spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
        } else {
          this.proc?.kill("SIGTERM");
        }
      } catch {
        /* best effort */
      }
    };
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }

  async shutdown(): Promise<void> {
    this.starting = null;
    const proc = this.proc;
    this.proc = null;
    this.port = null;
    if (proc) {
      await killProcessTree(proc.pid);
    }
  }
}
