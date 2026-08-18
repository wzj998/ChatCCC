import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { stat } from "node:fs/promises";

import {
  loadConfig,
  saveConfigPatch,
  type DeepCccConfig,
  type DeepCccConfigPatch,
} from "./config.js";
import type { PermissionAnswer } from "./permissions.js";
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
}

export interface StartDeepCccWebOptions {
  port?: number;
  openBrowser?: boolean;
  defaultCwd?: string;
}

export interface DeepCccWebHandle {
  url: string;
  port: number;
  reused: boolean;
  close(): Promise<void>;
}

let defaultHandle: DeepCccWebHandle | null = null;

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
        return jsonReply(res, 200, { ok: true, service: "deepccc-web" });
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
    if (options.openBrowser !== false) openBrowser(url);
    return defaultHandle;
  }
  if (await isExistingDeepCccServer(port)) {
    const reused: DeepCccWebHandle = { url, port, reused: true, close: async () => {} };
    if (options.openBrowser !== false) openBrowser(url);
    return reused;
  }
  const runtime = new DeepCccWebRuntime({ loadConfig: runtimeConfig });
  const defaultCwd = options.defaultCwd ?? process.cwd();
  const handler = createDeepCccWebRequestHandler({
    runtime,
    defaultCwd,
    getPublicConfig: () => toPublicConfig(loadConfig(), defaultCwd),
    saveConfig: (patch) => toPublicConfig(saveConfigPatch(patch), defaultCwd),
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
    close: () => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
  };
  defaultHandle = handle;
  if (options.openBrowser ?? config.web.openOnStart) openBrowser(url);
  return handle;
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

async function isExistingDeepCccServer(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://${HOST}:${port}/api/health`, { signal: AbortSignal.timeout(800) });
    return response.ok && (await response.json() as { service?: string }).service === "deepccc-web";
  } catch {
    return false;
  }
}

function openBrowser(url: string): void {
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}
