import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, isAbsolute, resolve } from "node:path";
import { stat } from "node:fs/promises";

import { getTenantAccessToken, sendImageReply, sendTextReply } from "./feishu-api.ts";
import { ts } from "./config.ts";
import { logTrace } from "./trace.ts";

export const AGENT_SEND_IMAGE_PATH = "/api/agent/send-image";

const DEFAULT_GRANT_TTL_MS = 30 * 60 * 1000;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ALLOWED_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

export interface AgentImageGrant {
  token: string;
  url: string;
  chatId: string;
  sessionId: string;
  cwd: string;
  expiresAt: number;
  traceId: string;
}

interface CreateAgentImageGrantInput {
  chatId: string;
  sessionId: string;
  cwd: string;
  port: number;
  traceId?: string;
  nowMs?: number;
  ttlMs?: number;
}

const imageGrants = new Map<string, AgentImageGrant>();

function createToken(): string {
  return randomBytes(24).toString("base64url");
}

export function createAgentImageGrant(input: CreateAgentImageGrantInput): AgentImageGrant {
  const now = input.nowMs ?? Date.now();
  const token = createToken();
  const grant: AgentImageGrant = {
    token,
    url: `http://127.0.0.1:${input.port}${AGENT_SEND_IMAGE_PATH}`,
    chatId: input.chatId,
    sessionId: input.sessionId,
    cwd: input.cwd,
    expiresAt: now + (input.ttlMs ?? DEFAULT_GRANT_TTL_MS),
    traceId: input.traceId ?? "",
  };
  imageGrants.set(token, grant);
  if (grant.traceId) logTrace(grant.traceId, "IMAGE_GRANT_CREATED", { sessionId: grant.sessionId, ttlMs: input.ttlMs ?? DEFAULT_GRANT_TTL_MS });
  return grant;
}

export function revokeAgentImageGrant(token: string): void {
  const grant = imageGrants.get(token);
  if (grant?.traceId) logTrace(grant.traceId, "IMAGE_GRANT_REVOKED", {});
  imageGrants.delete(token);
}

export function getAgentImageGrantFromAuthorization(
  authorization: string | undefined,
  nowMs = Date.now(),
): AgentImageGrant | null {
  const match = (authorization ?? "").match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const grant = imageGrants.get(match[1]);
  if (!grant) return null;
  if (grant.expiresAt <= nowMs) {
    imageGrants.delete(match[1]);
    return null;
  }
  return grant;
}

export function buildAgentImageCapabilityPrompt(input: {
  url: string;
  token: string;
  cwd?: string;
}): string {
  const lines = [
    "[ChatCCC local capability: send image]",
    "You can send an image to the current Feishu chat in real time by calling this local endpoint.",
    "",
    `POST ${input.url}`,
    `Authorization: Bearer ${input.token}`,
    "Content-Type: application/json",
    "",
    'Body: {"path":"absolute image file path","caption":"optional caption"}',
    "",
    "Rules:",
    "- Save or choose a local image file first, then call the endpoint.",
    "- Use an absolute local file path. Do not call Feishu Open Platform directly.",
    "- Only call this endpoint when the user asked for an image or when an image is useful to the answer.",
    "[/ChatCCC local capability: send image]",
  ];
  if (input.cwd) {
    lines.splice(2, 0, `Current working directory: ${input.cwd}`);
  }
  return lines.join("\n");
}

function jsonReply(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function readLimitedBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      body += chunk.toString("utf8");
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function resolveAndValidateImagePath(grant: AgentImageGrant, rawPath: unknown): Promise<string> {
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    throw new Error("path must be a non-empty string");
  }

  const sessionRoot = resolve(grant.cwd);
  const imagePath = isAbsolute(rawPath)
    ? resolve(rawPath)
    : resolve(sessionRoot, rawPath);

  const ext = extname(imagePath).toLowerCase();
  if (!ALLOWED_IMAGE_EXTS.has(ext)) {
    throw new Error(`unsupported image extension: ${ext || "(none)"}`);
  }

  const st = await stat(imagePath);
  if (!st.isFile()) throw new Error("image path is not a file");
  if (st.size <= 0) throw new Error("image file is empty");
  if (st.size > MAX_IMAGE_BYTES) throw new Error("image file is larger than 10MB");
  return imagePath;
}

export async function handleAgentImageRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== AGENT_SEND_IMAGE_PATH) return false;

  if (req.method !== "POST") {
    jsonReply(res, 405, { ok: false, error: "Method not allowed" });
    return true;
  }

  const grant = getAgentImageGrantFromAuthorization(req.headers.authorization);
  if (!grant) {
    jsonReply(res, 401, { ok: false, error: "Invalid or expired image-send token" });
    return true;
  }
  const tid = grant.traceId;

  let payload: { path?: unknown; caption?: unknown };
  try {
    payload = JSON.parse(await readLimitedBody(req));
  } catch (err) {
    if (tid) logTrace(tid, "IMAGE_REQ", { outcome: "invalid_json", error: (err as Error).message });
    jsonReply(res, 400, { ok: false, error: (err as Error).message || "Invalid JSON" });
    return true;
  }

  let imagePath: string;
  try {
    imagePath = await resolveAndValidateImagePath(grant, payload.path);
  } catch (err) {
    if (tid) logTrace(tid, "IMAGE_REQ", { outcome: "invalid_path", path: String(payload.path), error: (err as Error).message });
    jsonReply(res, 400, { ok: false, error: (err as Error).message });
    return true;
  }

  try {
    const token = await getTenantAccessToken();
    const caption = typeof payload.caption === "string" ? payload.caption.trim() : "";
    await sendImageReply(token, grant.chatId, imagePath);
    if (caption) await sendTextReply(token, grant.chatId, caption);
    if (tid) logTrace(tid, "IMAGE_REQ", { outcome: "sent", path: imagePath, hasCaption: !!caption });
    console.log(`[${ts()}] [AGENT-IMAGE] sent image chat=${grant.chatId} session=${grant.sessionId} path=${imagePath}`);
    jsonReply(res, 200, { ok: true });
  } catch (err) {
    if (tid) logTrace(tid, "IMAGE_REQ", { outcome: "send_failed", path: imagePath!, error: (err as Error).message });
    console.error(`[${ts()}] [AGENT-IMAGE] send failed: ${(err as Error).message}`);
    jsonReply(res, 500, { ok: false, error: (err as Error).message });
  }
  return true;
}
