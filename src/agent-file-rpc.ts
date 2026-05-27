import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, isAbsolute, resolve } from "node:path";
import { stat } from "node:fs/promises";

import { getTenantAccessToken, sendFileReply, sendTextReply } from "./feishu-platform.ts";
import { ts, resolveDefaultAgentTool } from "./config.ts";
import { readUtf8JsonBody } from "./agent-rpc-body.ts";
import { getAdapterForTool } from "./session.ts";
import { getChatsForSession } from "./session-chat-binding.ts";
import { splitFeishuTargetChats } from "./agent-platform-routing.ts";

export const AGENT_SEND_FILE_PATH = "/api/agent/send-file";

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const ALLOWED_FILE_EXTS = new Set([
  ".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv",
  ".mp3", ".wav", ".ogg", ".aac", ".m4a",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".csv", ".ppt", ".pptx",
  ".txt", ".zip", ".tar", ".gz",
]);

function jsonReply(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function resolveAndValidateFilePath(cwd: string, rawPath: unknown): Promise<string> {
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    throw new Error("path must be a non-empty string");
  }

  const sessionRoot = resolve(cwd);
  const filePath = isAbsolute(rawPath)
    ? resolve(rawPath)
    : resolve(sessionRoot, rawPath);

  const ext = extname(filePath).toLowerCase();
  if (!ALLOWED_FILE_EXTS.has(ext)) {
    throw new Error(`unsupported file extension: ${ext || "(none)"}`);
  }

  const st = await stat(filePath);
  if (!st.isFile()) throw new Error("file path is not a file");
  if (st.size <= 0) throw new Error("file is empty");
  if (st.size > MAX_FILE_BYTES) throw new Error("file is larger than 100MB");
  return filePath;
}

export async function handleAgentFileRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== AGENT_SEND_FILE_PATH) return false;

  if (req.method !== "POST") {
    jsonReply(res, 405, { ok: false, error: "Method not allowed" });
    return true;
  }

  let payload: { session_id?: unknown; path?: unknown; caption?: unknown };
  try {
    payload = await readUtf8JsonBody(req, MAX_REQUEST_BYTES);
  } catch (err) {
    jsonReply(res, 400, { ok: false, error: (err as Error).message || "Invalid JSON" });
    return true;
  }

  const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";
  if (!sessionId) {
    jsonReply(res, 400, { ok: false, error: "Missing session_id" });
    return true;
  }

  let cwd: string;
  try {
    const { getSessionTool } = await import("./session.ts");
    const tool = await getSessionTool(sessionId);
    const adapter = getAdapterForTool(tool ?? resolveDefaultAgentTool());
    const info = await adapter.getSessionInfo(sessionId);
    if (!info?.cwd) {
      jsonReply(res, 400, { ok: false, error: "Cannot determine cwd for session" });
      return true;
    }
    cwd = info.cwd;
  } catch (err) {
    jsonReply(res, 500, { ok: false, error: `Failed to get session info: ${(err as Error).message}` });
    return true;
  }

  let filePath: string;
  try {
    filePath = await resolveAndValidateFilePath(cwd, payload.path);
  } catch (err) {
    jsonReply(res, 400, { ok: false, error: (err as Error).message });
    return true;
  }

  const chatIds = getChatsForSession(sessionId);
  if (chatIds.length === 0) {
    jsonReply(res, 404, { ok: false, error: "No chats bound to this session" });
    return true;
  }

  const { getPlatformForChat } = await import("./session.ts");
  const { targetChatIds, skippedUnsupported } = splitFeishuTargetChats(
    chatIds,
    (cid) => getPlatformForChat(cid)?.kind,
  );
  if (targetChatIds.length === 0) {
    jsonReply(res, 409, {
      ok: false,
      error: "This endpoint only sends to Feishu chats. The bound chats are WeChat chats; use the WeChat file or video helper script instead.",
      skippedUnsupported,
    });
    return true;
  }

  try {
    const token = await getTenantAccessToken();
    const caption = typeof payload.caption === "string" ? payload.caption.trim() : "";
    let sentCount = 0;
    for (const cid of targetChatIds) {
      try {
        await sendFileReply(token, cid, filePath);
        if (caption) await sendTextReply(token, cid, caption);
        sentCount++;
      } catch (err) {
        console.error(`[${ts()}] [AGENT-FILE] send to ${cid} failed: ${(err as Error).message}`);
      }
    }
    console.log(`[${ts()}] [AGENT-FILE] sent file to ${sentCount}/${targetChatIds.length} Feishu chats, session=${sessionId} path=${filePath} skippedUnsupported=${skippedUnsupported.length}`);
    jsonReply(res, 200, { ok: true, sentTo: sentCount, total: targetChatIds.length, skippedUnsupported });
  } catch (err) {
    console.error(`[${ts()}] [AGENT-FILE] send failed: ${(err as Error).message}`);
    jsonReply(res, 500, { ok: false, error: (err as Error).message });
  }
  return true;
}

// ---------------------------------------------------------------------------
// 兼容旧版 buildAgentFileCapabilityPrompt（供 im-skills 使用）
// ---------------------------------------------------------------------------

export function buildAgentFileCapabilityPrompt(input: {
  url: string;
  sessionId?: string;
  cwd?: string;
}): string {
  const lines = [
    "[ChatCCC local capability: send file]",
    "You can send a file (video, audio, document, etc.) to all chats bound to this session by calling this local endpoint.",
    "",
    `POST ${input.url}`,
    "Content-Type: application/json; charset=utf-8",
    "",
    `Body: {"session_id":"${input.sessionId ?? "YOUR_SESSION_ID"}","path":"absolute file path","caption":"optional caption"}`,
    "",
    "Rules:",
    "- Save or choose a local file first, then call the endpoint.",
    "- Use an absolute local file path. Do not call Feishu Open Platform directly.",
    "- Request body must be UTF-8 encoded JSON bytes; caption supports Unicode text, including Chinese.",
    "- Only call this endpoint when the user asked for a file/video or when a file is useful to the answer.",
    "- Max file size: 100MB.",
    "[/ChatCCC local capability: send file]",
  ];
  if (input.cwd) {
    lines.splice(2, 0, `Current working directory: ${input.cwd}`);
  }
  return lines.join("\n");
}
