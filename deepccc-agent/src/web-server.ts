import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEEPCCC_HOME,
  loadConfig,
  saveConfigPatch,
  type DeepCccConfig,
  type DeepCccConfigPatch,
} from "./config.js";
import type { PermissionAnswer } from "./permissions.js";
import { killProcessTree } from "./proc-tree-kill.js";
import { DeepCccWebRuntime, type WebRuntimeConfig, type WebRuntimeEvent } from "./web-runtime.js";
import { DEEPCCC_WEB_PAGE } from "./web-page.js";

const MAX_BODY_BYTES = 512 * 1024;
const HOST = "127.0.0.1";

export interface PublicDeepCccConfig {
  provider: "openai" | "anthropic";
  baseURL: string;
  model: string;
  subModel: string;
  effort: string;
  maxOutputTokens?: number;
  streaming: boolean;
  contextWindow: number;
  web: { port: number; openOnStart: boolean };
  apiKeyConfigured: boolean;
  apiKeyMask: string;
  defaultCwd?: string;
}

export interface DeepCccWebRequestHandlerOptions {
  runtime: Pick<DeepCccWebRuntime,
    "listSessions" | "createSession" | "getSession" | "updateSession" | "deleteSession" |
    "sendMessage" | "stopSession" | "resolveApproval" | "subscribe"
  >;
  getPublicConfig: () => PublicDeepCccConfig;
  saveConfig: (patch: DeepCccConfigPatch) => Promise<PublicDeepCccConfig> | PublicDeepCccConfig;
  defaultCwd: string;
  instance?: DeepCccWebInstance & { shutdown: () => void };
}

export interface StartDeepCccWebOptions {
  port?: number;
  openBrowser?: boolean;
  defaultCwd?: string;
  reuseExisting?: boolean;
  stateFile?: string;
}

export interface DeepCccWebHandle {
  url: string;
  port: number;
  reused: boolean;
  close(): Promise<void>;
}

export interface DeepCccWebInstance {
  pid: number;
  port: number;
  startedAt: string;
  token: string;
}

export interface LaunchDeepCccWebProcessOptions extends StartDeepCccWebOptions {}

let defaultHandle: DeepCccWebHandle | null = null;
export const DEEPCCC_WEB_STATE_FILE = join(DEEPCCC_HOME, "web", "server.json");

function runtimeConfig(): WebRuntimeConfig {
  const config = loadConfig();
  return {
    provider: config.provider,
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    model: config.model,
    subModel: config.subModel,
    effort: config.effort,
    maxOutputTokens: config.maxOutputTokens,
    contextWindow: config.contextWindow,
    streaming: config.streaming,
  };
}

export function toPublicConfig(config: DeepCccConfig, defaultCwd = process.cwd()): PublicDeepCccConfig {
  return {
    provider: config.provider,
    baseURL: config.baseURL,
    model: config.model,
    subModel: config.subModel,
    effort: config.effort,
    ...(config.maxOutputTokens ? { maxOutputTokens: config.maxOutputTokens } : {}),
    streaming: config.streaming,
    contextWindow: config.contextWindow,
    web: config.web,
    apiKeyConfigured: !!config.apiKey,
    apiKeyMask: maskSecret(config.apiKey),
    defaultCwd,
  };
}

export function createDeepCccWebRequestHandler(options: DeepCccWebRequestHandlerOptions) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${HOST}`);
    const path = url.pathname;
    const method = req.method ?? "GET";
    try {
      if (method === "GET" && (path === "/" || path === "/index.html")) {
        return textReply(res, 200, DEEPCCC_WEB_PAGE, "text/html; charset=utf-8");
      }
      if (method === "GET" && path === "/api/health") {
        return jsonReply(res, 200, {
          ok: true,
          service: "deepccc-web",
          ...(options.instance ? {
            pid: options.instance.pid,
            port: options.instance.port,
            startedAt: options.instance.startedAt,
            instanceToken: options.instance.token,
          } : {}),
        });
      }
      if (method === "POST" && path === "/api/shutdown") {
        if (!options.instance || req.headers["x-deepccc-instance-token"] !== options.instance.token) {
          throw new WebHttpError(403, "DeepCCC Web shutdown token mismatch");
        }
        jsonReply(res, 202, { ok: true, shuttingDown: true });
        setTimeout(options.instance.shutdown, 0).unref?.();
        return;
      }
      if (method === "GET" && path === "/api/config") {
        return jsonReply(res, 200, { ok: true, config: { ...options.getPublicConfig(), defaultCwd: options.defaultCwd } });
      }
      if (method === "PUT" && path === "/api/config") {
        const body = await readJson<DeepCccConfigPatch>(req);
        const config = await options.saveConfig(body);
        return jsonReply(res, 200, { ok: true, config: { ...config, defaultCwd: options.defaultCwd } });
      }
      if (method === "GET" && path === "/api/sessions") {
        return jsonReply(res, 200, { ok: true, sessions: await options.runtime.listSessions() });
      }
      if (method === "POST" && path === "/api/sessions") {
        const body = await readJson<{ cwd?: string; title?: string; model?: string; subModel?: string; effort?: string }>(req);
        const cwd = body.cwd?.trim() || options.defaultCwd;
        await assertDirectory(cwd);
        const session = await options.runtime.createSession({ ...body, cwd });
        return jsonReply(res, 201, { ok: true, session });
      }
      const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)$/);
      if (sessionMatch && method === "GET") {
        return jsonReply(res, 200, { ok: true, session: await options.runtime.getSession(decodeURIComponent(sessionMatch[1])) });
      }
      if (sessionMatch && method === "PATCH") {
        const body = await readJson<Record<string, unknown>>(req);
        const session = await options.runtime.updateSession(decodeURIComponent(sessionMatch[1]), {
          ...(typeof body.title === "string" ? { title: body.title } : {}),
          ...(typeof body.model === "string" ? { model: body.model } : {}),
          ...(typeof body.subModel === "string" ? { subModel: body.subModel } : {}),
          ...(typeof body.effort === "string" ? { effort: body.effort } : {}),
        });
        return jsonReply(res, 200, { ok: true, session });
      }
      if (sessionMatch && method === "DELETE") {
        const deleted = await options.runtime.deleteSession(decodeURIComponent(sessionMatch[1]));
        return jsonReply(res, deleted ? 200 : 404, { ok: deleted });
      }
      const messagesMatch = path.match(/^\/api\/sessions\/([^/]+)\/messages$/);
      if (messagesMatch && method === "POST") {
        const body = await readJson<{ text?: string }>(req);
        const result = await options.runtime.sendMessage(decodeURIComponent(messagesMatch[1]), body.text ?? "");
        return jsonReply(res, 202, { ok: true, ...result });
      }
      const stopMatch = path.match(/^\/api\/sessions\/([^/]+)\/stop$/);
      if (stopMatch && method === "POST") {
        return jsonReply(res, 200, { ok: true, stopped: await options.runtime.stopSession(decodeURIComponent(stopMatch[1])) });
      }
      const eventsMatch = path.match(/^\/api\/sessions\/([^/]+)\/events$/);
      if (eventsMatch && method === "GET") {
        return openEventStream(req, res, decodeURIComponent(eventsMatch[1]), options.runtime);
      }
      const approvalMatch = path.match(/^\/api\/approvals\/([^/]+)$/);
      if (approvalMatch && method === "POST") {
        const body = await readJson<{ answer?: PermissionAnswer }>(req);
        if (!body.answer || !["allow", "allow-session", "allow-always", "deny"].includes(body.answer)) {
          throw new WebHttpError(400, "Invalid approval answer");
        }
        const resolved = await options.runtime.resolveApproval(decodeURIComponent(approvalMatch[1]), body.answer);
        return jsonReply(res, resolved ? 200 : 404, { ok: resolved });
      }
      if (path.startsWith("/api/")) return jsonReply(res, 404, { ok: false, error: "Not found" });
      if (method === "GET") return textReply(res, 200, DEEPCCC_WEB_PAGE, "text/html; charset=utf-8");
      return jsonReply(res, 404, { ok: false, error: "Not found" });
    } catch (err) {
      const status = err instanceof WebHttpError ? err.status : 500;
      jsonReply(res, status, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  };
}

export async function startDeepCccWebServer(options: StartDeepCccWebOptions = {}): Promise<DeepCccWebHandle> {
  const config = loadConfig();
  const port = options.port ?? config.web.port;
  const url = `http://${HOST}:${port}/`;
  if (defaultHandle?.port === port) {
    if (options.reuseExisting) {
      if (options.openBrowser !== false) openBrowser(url);
      return defaultHandle;
    }
    await defaultHandle.close();
  }
  const stateFile = options.stateFile ?? DEEPCCC_WEB_STATE_FILE;
  const existing = await inspectDeepCccWebServer(port);
  if (existing && options.reuseExisting) {
    const reused: DeepCccWebHandle = { url, port, reused: true, close: async () => {} };
    if (options.openBrowser !== false) openBrowser(url);
    return reused;
  }
  if (existing) await stopOwnedDeepCccWebServer(existing, stateFile);
  const runtime = new DeepCccWebRuntime({ loadConfig: runtimeConfig });
  const defaultCwd = options.defaultCwd ?? process.cwd();
  const instance: DeepCccWebInstance = {
    pid: process.pid,
    port,
    startedAt: new Date().toISOString(),
    token: randomUUID(),
  };
  let closeServer = () => {};
  const handler = createDeepCccWebRequestHandler({
    runtime,
    defaultCwd,
    getPublicConfig: () => toPublicConfig(loadConfig(), defaultCwd),
    saveConfig: (patch) => toPublicConfig(saveConfigPatch(patch), defaultCwd),
    instance: { ...instance, shutdown: () => closeServer() },
  });
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once("error", onError);
    server.listen(port, HOST, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const handle: DeepCccWebHandle = {
    url,
    port,
    reused: false,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) return reject(err);
        removeOwnedState(stateFile, instance.token);
        if (defaultHandle?.port === port) defaultHandle = null;
        resolve();
      });
      // SSE and keep-alive sockets would otherwise keep a replaced standalone
      // process alive after it has released the listening port.
      server.closeAllConnections?.();
    }),
  };
  closeServer = () => { void handle.close(); };
  defaultHandle = handle;
  writeOwnedState(stateFile, instance);
  if (options.openBrowser ?? config.web.openOnStart) openBrowser(url);
  return handle;
}

export async function launchDeepCccWebProcess(options: LaunchDeepCccWebProcessOptions = {}): Promise<{ url: string; port: number; reused: boolean }> {
  const config = loadConfig();
  const port = options.port ?? config.web.port;
  const url = `http://${HOST}:${port}/`;
  if (options.reuseExisting && await inspectDeepCccWebServer(port)) {
    if (options.openBrowser !== false) openBrowser(url);
    return { url, port, reused: true };
  }
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const compiledEntry = join(moduleDir, "web-entry.js");
  const args = [
    ...(options.reuseExisting ? ["--reuse-existing"] : []),
    "--port", String(port),
    ...(options.openBrowser === false ? ["--no-open"] : []),
  ];
  const require = createRequire(import.meta.url);
  const commandArgs = existsSync(compiledEntry)
    ? [compiledEntry, ...args]
    : [require.resolve("tsx/cli"), join(moduleDir, "web-entry.ts"), ...args];
  const child = spawn(process.execPath, commandArgs, {
    cwd: options.defaultCwd ?? process.cwd(),
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (await inspectDeepCccWebServer(port)) return { url, port, reused: false };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`DeepCCC Web did not become ready on port ${port}`);
}

function openEventStream(
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
  runtime: Pick<DeepCccWebRuntime, "subscribe">,
): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(": connected\n\n");
  const send = (event: WebRuntimeEvent) => res.write(`id: ${event.eventId}\ndata: ${JSON.stringify(event)}\n\n`);
  const unsubscribe = runtime.subscribe(sessionId, send);
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15_000);
  heartbeat.unref?.();
  req.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new WebHttpError(413, "Request body is too large");
    chunks.push(buffer);
  }
  if (!chunks.length) return {} as T;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    throw new WebHttpError(400, "Invalid JSON body");
  }
}

async function assertDirectory(path: string): Promise<void> {
  try {
    if (!(await stat(path)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new WebHttpError(400, `工作目录不存在：${path}`);
  }
}

function maskSecret(value: string): string {
  if (!value) return "";
  const suffix = value.slice(-4);
  return `${value.slice(0, Math.min(3, Math.max(0, value.length - 4)))}••••${suffix}`;
}

function jsonReply(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

function textReply(res: ServerResponse, status: number, value: string, contentType: string): void {
  res.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
  res.end(value);
}

class WebHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export async function inspectDeepCccWebServer(port: number): Promise<(DeepCccWebInstance & { service: "deepccc-web" }) | null> {
  try {
    const response = await fetch(`http://${HOST}:${port}/api/health`, { signal: AbortSignal.timeout(800) });
    if (!response.ok) return null;
    const health = await response.json() as Record<string, unknown>;
    if (health.service !== "deepccc-web") return null;
    return {
      service: "deepccc-web",
      pid: typeof health.pid === "number" ? health.pid : 0,
      port: typeof health.port === "number" ? health.port : port,
      startedAt: typeof health.startedAt === "string" ? health.startedAt : "",
      token: typeof health.instanceToken === "string" ? health.instanceToken : "",
    };
  } catch {
    return null;
  }
}

async function stopOwnedDeepCccWebServer(existing: DeepCccWebInstance, stateFile: string): Promise<void> {
  const owned = readOwnedState(stateFile);
  if (!owned || !sameInstance(owned, existing)) {
    throw new Error(`Port ${existing.port} is occupied by an unverified DeepCCC Web instance; use --reuse-existing or stop it manually`);
  }
  try {
    await fetch(`http://${HOST}:${existing.port}/api/shutdown`, {
      method: "POST",
      headers: { "x-deepccc-instance-token": existing.token },
      signal: AbortSignal.timeout(1_500),
    });
  } catch { /* fall through to verified force-kill */ }
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (!await inspectDeepCccWebServer(existing.port)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const current = await inspectDeepCccWebServer(existing.port);
  if (current && sameInstance(owned, current)) await killProcessTree(owned.pid);
  const finalDeadline = Date.now() + 3_000;
  while (Date.now() < finalDeadline) {
    if (!await inspectDeepCccWebServer(existing.port)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Verified DeepCCC Web process ${owned.pid} did not release port ${existing.port}`);
}

function sameInstance(left: DeepCccWebInstance, right: DeepCccWebInstance): boolean {
  return left.pid > 0 && left.pid === right.pid && left.port === right.port && !!left.token && left.token === right.token && left.startedAt === right.startedAt;
}

function readOwnedState(path: string): DeepCccWebInstance | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<DeepCccWebInstance>;
    if (typeof value.pid !== "number" || typeof value.port !== "number" || typeof value.startedAt !== "string" || typeof value.token !== "string") return null;
    return value as DeepCccWebInstance;
  } catch { return null; }
}

function writeOwnedState(path: string, instance: DeepCccWebInstance): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(instance, null, 2)}\n`, "utf8");
  renameSync(temp, path);
}

function removeOwnedState(path: string, token: string): void {
  if (readOwnedState(path)?.token !== token) return;
  try { unlinkSync(path); } catch { /* already removed */ }
}

function openBrowser(url: string): void {
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}
