import http, { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type ProxyConfig = {
  host: string;
  port: number;
  upstream: URL;
  logDir: string;
  logSecrets: boolean;
};

type RequestLog = {
  id: string;
  timestamp: string;
  method: string;
  path: string;
  upstreamUrl: string;
  headers: Record<string, string | string[] | undefined>;
  bodyBytes: number;
  bodyFile: string;
};

type ResponseLog = {
  id: string;
  timestamp: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  bodyBytes: number;
  bodyFile: string;
  durationMs: number;
};

type RawUpstreamResponse = {
  statusCode: number;
  statusMessage: string;
  headers: IncomingHttpHeaders;
  stream: IncomingMessage;
};

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
]);

let requestSeq = 0;

function parseArgs(argv: string[]): Partial<ProxyConfig> {
  const parsed: Partial<ProxyConfig> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    const readValue = () => {
      if (!next) throw new Error(`${arg} requires a value`);
      i++;
      return next;
    };

    if (arg === "--host") parsed.host = readValue();
    else if (arg === "--port") parsed.port = Number(readValue());
    else if (arg === "--upstream") parsed.upstream = new URL(readValue());
    else if (arg === "--log-dir") parsed.logDir = readValue();
    else if (arg === "--log-secrets") parsed.logSecrets = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function readConfig(): ProxyConfig {
  const args = parseArgs(process.argv.slice(2));
  const upstreamRaw = args.upstream?.toString() ??
    process.env.CHATCCC_LITELLM_PROXY_UPSTREAM ??
    "https://litellm.hypergryph.net";

  const portRaw = args.port ?? Number(process.env.CHATCCC_LITELLM_PROXY_PORT ?? "18081");
  if (!Number.isInteger(portRaw) || portRaw <= 0 || portRaw > 65535) {
    throw new Error(`Invalid port: ${portRaw}`);
  }

  return {
    host: args.host ?? process.env.CHATCCC_LITELLM_PROXY_HOST ?? "127.0.0.1",
    port: portRaw,
    upstream: new URL(upstreamRaw),
    logDir: args.logDir ?? process.env.CHATCCC_LITELLM_PROXY_LOG_DIR ??
      join(homedir(), ".chatccc", "logs", "litellm-proxy"),
    logSecrets: args.logSecrets ?? process.env.CHATCCC_LITELLM_PROXY_LOG_SECRETS === "1",
  };
}

function printHelp(): void {
  console.log(`Usage: npm run claude-proxy -- [options]

Options:
  --host <host>          Listen host, default 127.0.0.1
  --port <port>          Listen port, default 18081
  --upstream <url>       Upstream LiteLLM base URL, default https://litellm.hypergryph.net
  --log-dir <path>       Log directory, default %USERPROFILE%/.chatccc/logs/litellm-proxy
  --log-secrets          Log sensitive headers instead of redacting them

Equivalent env vars:
  CHATCCC_LITELLM_PROXY_HOST
  CHATCCC_LITELLM_PROXY_PORT
  CHATCCC_LITELLM_PROXY_UPSTREAM
  CHATCCC_LITELLM_PROXY_LOG_DIR
  CHATCCC_LITELLM_PROXY_LOG_SECRETS=1
`);
}

function nextRequestId(): string {
  const stamp = new Date().toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  requestSeq = (requestSeq + 1) % 1_000_000;
  return `${stamp}-${String(requestSeq).padStart(6, "0")}`;
}

function dayDir(baseDir: string): string {
  return join(baseDir, new Date().toISOString().slice(0, 10));
}

function toUpstreamUrl(reqUrl: string | undefined, upstream: URL): URL {
  const path = reqUrl && reqUrl.startsWith("/") ? reqUrl : "/";
  return new URL(path, upstream);
}

function isHopByHopHeader(name: string): boolean {
  return HOP_BY_HOP_HEADERS.has(name.toLowerCase());
}

function copyRequestHeaders(headers: IncomingHttpHeaders, bodyLength: number): Record<string, string | string[]> {
  const next: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === "host" || lower === "content-length" || isHopByHopHeader(lower)) continue;
    if (Array.isArray(value)) {
      next[name] = value;
    } else if (typeof value === "string") {
      next[name] = value;
    }
  }
  if (bodyLength > 0) next["content-length"] = String(bodyLength);
  return next;
}

function safeHeaders<T extends Record<string, string | string[] | undefined>>(
  headers: T,
  logSecrets: boolean,
): T {
  if (logSecrets) return headers;
  const redacted = { ...headers };
  for (const key of Object.keys(redacted)) {
    if (SENSITIVE_HEADERS.has(key.toLowerCase())) {
      redacted[key as keyof T] = "[REDACTED]" as T[keyof T];
    }
  }
  return redacted;
}

function responseHeaders(headers: IncomingHttpHeaders, logSecrets: boolean): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    result[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) && !logSecrets
      ? "[REDACTED]"
      : Array.isArray(value) ? value.join(", ") : value;
  }
  return result;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function appendJsonl(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, JSON.stringify(value) + "\n", "utf-8");
}

async function logRequest(
  config: ProxyConfig,
  id: string,
  req: IncomingMessage,
  upstreamUrl: URL,
  body: Buffer,
  bodyFile: string,
): Promise<void> {
  const log: RequestLog = {
    id,
    timestamp: new Date().toISOString(),
    method: req.method ?? "GET",
    path: req.url ?? "/",
    upstreamUrl: upstreamUrl.toString(),
    headers: safeHeaders(req.headers, config.logSecrets),
    bodyBytes: body.byteLength,
    bodyFile,
  };
  await writeFile(bodyFile, body);
  await appendJsonl(join(dayDir(config.logDir), "events.jsonl"), { event: "request", ...log });
}

async function logResponse(
  config: ProxyConfig,
  log: ResponseLog,
): Promise<void> {
  await appendJsonl(join(dayDir(config.logDir), "events.jsonl"), { event: "response", ...log });
}

function requestUpstream(
  upstreamUrl: URL,
  req: IncomingMessage,
  body: Buffer,
  abortSignal: AbortSignal,
): Promise<RawUpstreamResponse> {
  return new Promise((resolve, reject) => {
    const transport = upstreamUrl.protocol === "https:" ? https : http;
    const upstreamReq = transport.request({
      protocol: upstreamUrl.protocol,
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port || undefined,
      method: req.method,
      path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
      headers: copyRequestHeaders(req.headers, body.byteLength),
    }, (upstreamRes) => {
      resolve({
        statusCode: upstreamRes.statusCode ?? 502,
        statusMessage: upstreamRes.statusMessage ?? "",
        headers: upstreamRes.headers,
        stream: upstreamRes,
      });
    });

    upstreamReq.on("error", reject);
    abortSignal.addEventListener("abort", () => upstreamReq.destroy(new Error("client aborted")), { once: true });

    if (body.byteLength > 0) upstreamReq.write(body);
    upstreamReq.end();
  });
}

function setResponseHeaders(res: ServerResponse, headers: IncomingHttpHeaders): void {
  for (const [key, value] of Object.entries(headers)) {
    if (!value || isHopByHopHeader(key)) continue;
    res.setHeader(key, value);
  }
}

async function writeError(res: ServerResponse, status: number, error: string): Promise<void> {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error }));
}

async function handleProxyRequest(config: ProxyConfig, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const started = Date.now();
  const id = nextRequestId();
  const dir = dayDir(config.logDir);
  await mkdir(dir, { recursive: true });

  const upstreamUrl = toUpstreamUrl(req.url, config.upstream);
  const requestBody = await readBody(req);
  const requestBodyFile = join(dir, `${id}.request.body`);
  const responseBodyFile = join(dir, `${id}.response.body`);
  await logRequest(config, id, req, upstreamUrl, requestBody, requestBodyFile);

  const abortController = new AbortController();
  req.on("aborted", () => abortController.abort());

  let upstreamResponse: RawUpstreamResponse;
  try {
    upstreamResponse = await requestUpstream(upstreamUrl, req, requestBody, abortController.signal);
  } catch (err) {
    await appendJsonl(join(dir, "events.jsonl"), {
      event: "error",
      id,
      timestamp: new Date().toISOString(),
      message: (err as Error).message,
      durationMs: Date.now() - started,
    });
    await writeError(res, 502, `Proxy upstream request failed: ${(err as Error).message}`);
    return;
  }

  res.statusCode = upstreamResponse.statusCode;
  res.statusMessage = upstreamResponse.statusMessage;
  setResponseHeaders(res, upstreamResponse.headers);

  let responseBytes = 0;
  const out = createWriteStream(responseBodyFile);
  try {
    for await (const chunk of upstreamResponse.stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      responseBytes += buf.byteLength;
      out.write(buf);
      if (!res.write(buf)) {
        await new Promise<void>((resolve) => res.once("drain", resolve));
      }
    }
  } catch (err) {
    await appendJsonl(join(dir, "events.jsonl"), {
      event: "stream_error",
      id,
      timestamp: new Date().toISOString(),
      message: (err as Error).message,
      durationMs: Date.now() - started,
    });
  } finally {
    out.end();
    res.end();
  }

  await logResponse(config, {
    id,
    timestamp: new Date().toISOString(),
    status: upstreamResponse.statusCode,
    statusText: upstreamResponse.statusMessage,
    headers: responseHeaders(upstreamResponse.headers, config.logSecrets),
    bodyBytes: responseBytes,
    bodyFile: responseBodyFile,
    durationMs: Date.now() - started,
  });
}

async function main(): Promise<void> {
  const config = readConfig();
  await mkdir(config.logDir, { recursive: true });

  const server = createServer((req, res) => {
    void handleProxyRequest(config, req, res).catch(async (err) => {
      console.error(`[litellm-proxy] unhandled request error: ${(err as Error).stack ?? (err as Error).message}`);
      await writeError(res, 500, `Proxy internal error: ${(err as Error).message}`);
    });
  });

  server.listen(config.port, config.host, () => {
    console.log(`[litellm-proxy] listening on http://${config.host}:${config.port}`);
    console.log(`[litellm-proxy] upstream ${config.upstream.toString()}`);
    console.log(`[litellm-proxy] logs ${config.logDir}`);
  });
}

void main().catch((err) => {
  console.error(`[litellm-proxy] failed to start: ${(err as Error).message}`);
  process.exit(1);
});
