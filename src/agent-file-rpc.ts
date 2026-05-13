import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, isAbsolute, resolve } from "node:path";
import { stat } from "node:fs/promises";

import { getTenantAccessToken, sendFileReply, sendTextReply } from "./feishu-platform.ts";
import { ts } from "./config.ts";
import { logTrace } from "./trace.ts";
import { readUtf8JsonBody } from "./agent-rpc-body.ts";

export const AGENT_SEND_FILE_PATH = "/api/agent/send-file";

const DEFAULT_GRANT_TTL_MS = 30 * 60 * 1000;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const ALLOWED_FILE_EXTS = new Set([
  ".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv",
  ".mp3", ".wav", ".ogg", ".aac", ".m4a",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".csv", ".ppt", ".pptx",
  ".txt", ".zip", ".tar", ".gz",
]);

export interface AgentFileGrant {
  token: string;
  url: string;
  chatId: string;
  sessionId: string;
  cwd: string;
  expiresAt: number;
  traceId: string;
}

const fileGrants = new Map<string, AgentFileGrant>();

function createToken(): string {
  return randomBytes(24).toString("base64url");
}

export function createAgentFileGrant(input: {
  chatId: string;
  sessionId: string;
  cwd: string;
  port: number;
  traceId?: string;
  nowMs?: number;
  ttlMs?: number;
}): AgentFileGrant {
  const now = input.nowMs ?? Date.now();
  const token = createToken();
  const grant: AgentFileGrant = {
    token,
    url: `http://127.0.0.1:${input.port}${AGENT_SEND_FILE_PATH}`,
    chatId: input.chatId,
    sessionId: input.sessionId,
    cwd: input.cwd,
    expiresAt: now + (input.ttlMs ?? DEFAULT_GRANT_TTL_MS),
    traceId: input.traceId ?? "",
  };
  fileGrants.set(token, grant);
  if (grant.traceId) logTrace(grant.traceId, "FILE_GRANT_CREATED", { sessionId: grant.sessionId });
  return grant;
}

export function revokeAgentFileGrant(token: string): void {
  const grant = fileGrants.get(token);
  if (grant?.traceId) logTrace(grant.traceId, "FILE_GRANT_REVOKED", {});
  fileGrants.delete(token);
}

function getAgentFileGrantFromAuthorization(authorization: string | undefined, nowMs = Date.now()): AgentFileGrant | null {
  const match = (authorization ?? "").match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const grant = fileGrants.get(match[1]);
  if (!grant) return null;
  if (grant.expiresAt <= nowMs) { fileGrants.delete(match[1]); return null; }
  return grant;
}

export function buildAgentFileCapabilityPrompt(input: { url: string; token: string; cwd?: string }): string {
  const lines = [
    "[ChatCCC local capability: send file]",
    "You can send a file (video, audio, document, etc.) to the current Feishu chat in real time by calling this local endpoint.",
    "",
    `POST ${input.url}`,
    `Authorization: Bearer ${input.token}`,
    "Content-Type: application/json; charset=utf-8",
    "",
    'Body: {"path":"absolute file path","caption":"optional caption"}',
    "",
    "Rules:",
    "- Save or choose a local file first, then call the endpoint.",
    "- Use an absolute local file path. Do not call Feishu Open Platform directly.",
    "- Request body must be UTF-8 encoded JSON bytes; caption supports Unicode text, including Chinese.",
    "- Only call this endpoint when the user asked for a file/video or when a file is useful to the answer.",
    "- Max file size: 100MB.",
    "[/ChatCCC local capability: send file]",
  ];
  if (input.cwd) lines.splice(2, 0, `Current working directory: ${input.cwd}`);
  return lines.join("\n");
}

function jsonReply(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function resolveAndValidateFilePath(grant: AgentFileGrant, rawPath: unknown): Promise<string> {
  if (typeof rawPath !== "string" || rawPath.trim() === "") throw new Error("path must be a non-empty string");
  const sessionRoot = resolve(grant.cwd);
  const filePath = isAbsolute(rawPath) ? resolve(rawPath) : resolve(sessionRoot, rawPath);
  const ext = extname(filePath).toLowerCase();
  if (!ALLOWED_FILE_EXTS.has(ext)) throw new Error(`unsupported file extension: ${ext || "(none)"}`);
  const st = await stat(filePath);
  if (!st.isFile()) throw new Error("file path is not a file");
  if (st.size <= 0) throw new Error("file is empty");
  if (st.size > MAX_FILE_BYTES) throw new Error(`file is larger than ${MAX_FILE_BYTES / 1024 / 1024}MB`);
  return filePath;
}

export async function handleAgentFileRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== AGENT_SEND_FILE_PATH) return false;
  if (req.method !== "POST") { jsonReply(res, 405, { ok: false, error: "Method not allowed" }); return true; }

  const grant = getAgentFileGrantFromAuthorization(req.headers.authorization);
  if (!grant) { jsonReply(res, 401, { ok: false, error: "Invalid or expired file-send token" }); return true; }
  const tid = grant.traceId;

  let payload: { path?: unknown; caption?: unknown };
  try { payload = await readUtf8JsonBody(req, MAX_REQUEST_BYTES); } catch (err) {
    if (tid) logTrace(tid, "FILE_REQ", { outcome: "invalid_json", error: (err as Error).message });
    jsonReply(res, 400, { ok: false, error: (err as Error).message || "Invalid JSON" }); return true;
  }

  let filePath: string;
  try { filePath = await resolveAndValidateFilePath(grant, payload.path); } catch (err) {
    if (tid) logTrace(tid, "FILE_REQ", { outcome: "invalid_path", path: String(payload.path), error: (err as Error).message });
    jsonReply(res, 400, { ok: false, error: (err as Error).message }); return true;
  }

  try {
    const token = await getTenantAccessToken();
    const caption = typeof payload.caption === "string" ? payload.caption.trim() : "";
    await sendFileReply(token, grant.chatId, filePath);
    if (caption) await sendTextReply(token, grant.chatId, caption);
    if (tid) logTrace(tid, "FILE_REQ", { outcome: "sent", path: filePath, hasCaption: !!caption });
    console.log(`[${ts()}] [AGENT-FILE] sent file chat=${grant.chatId} session=${grant.sessionId} path=${filePath}`);
    jsonReply(res, 200, { ok: true });
  } catch (err) {
    if (tid) logTrace(tid, "FILE_REQ", { outcome: "send_failed", path: filePath!, error: (err as Error).message });
    console.error(`[${ts()}] [AGENT-FILE] send failed: ${(err as Error).message}`);
    jsonReply(res, 500, { ok: false, error: (err as Error).message });
  }
  return true;
}
