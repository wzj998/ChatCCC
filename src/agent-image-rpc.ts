import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, isAbsolute, resolve } from "node:path";
import { stat } from "node:fs/promises";

import { getTenantAccessToken, sendImageReply, sendTextReply } from "./feishu-platform.ts";
import { ts } from "./config.ts";
import { readUtf8JsonBody } from "./agent-rpc-body.ts";
import { getAdapterForTool } from "./session.ts";
import { getChatsForSession } from "./session-chat-binding.ts";
import { splitFeishuTargetChats } from "./agent-platform-routing.ts";

export const AGENT_SEND_IMAGE_PATH = "/api/agent/send-image";

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ALLOWED_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

function jsonReply(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function resolveAndValidateImagePath(cwd: string, rawPath: unknown): Promise<string> {
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    throw new Error("path must be a non-empty string");
  }

  const sessionRoot = resolve(cwd);
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

  // 获取 cwd 以校验路径
  let cwd: string;
  try {
    const { getSessionTool } = await import("./session.ts");
    const tool = await getSessionTool(sessionId);
    const adapter = getAdapterForTool(tool ?? "claude");
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

  let imagePath: string;
  try {
    imagePath = await resolveAndValidateImagePath(cwd, payload.path);
  } catch (err) {
    jsonReply(res, 400, { ok: false, error: (err as Error).message });
    return true;
  }

  // 发送到所有绑定该 session 的群
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
      error: "This endpoint only sends to Feishu chats. The bound chats are WeChat chats; use the WeChat image helper script instead.",
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
        await sendImageReply(token, cid, imagePath);
        if (caption) await sendTextReply(token, cid, caption);
        sentCount++;
      } catch (err) {
        console.error(`[${ts()}] [AGENT-IMAGE] send to ${cid} failed: ${(err as Error).message}`);
      }
    }
    console.log(`[${ts()}] [AGENT-IMAGE] sent image to ${sentCount}/${targetChatIds.length} Feishu chats, session=${sessionId} path=${imagePath} skippedUnsupported=${skippedUnsupported.length}`);
    jsonReply(res, 200, { ok: true, sentTo: sentCount, total: targetChatIds.length, skippedUnsupported });
  } catch (err) {
    console.error(`[${ts()}] [AGENT-IMAGE] send failed: ${(err as Error).message}`);
    jsonReply(res, 500, { ok: false, error: (err as Error).message });
  }
  return true;
}

// ---------------------------------------------------------------------------
// 兼容旧版 buildAgentImageCapabilityPrompt（供 im-skills 使用）
// ---------------------------------------------------------------------------

export function buildAgentImageCapabilityPrompt(input: {
  url: string;
  sessionId?: string;
  cwd?: string;
}): string {
  const lines = [
    "[ChatCCC local capability: send image]",
    "You can send an image to all chats bound to this session by calling this local endpoint.",
    "",
    `POST ${input.url}`,
    "Content-Type: application/json; charset=utf-8",
    "",
    `Body: {"session_id":"${input.sessionId ?? "YOUR_SESSION_ID"}","path":"absolute image file path","caption":"optional caption"}`,
    "",
    "Rules:",
    "- Save or choose a local image file first, then call the endpoint.",
    "- Use an absolute local file path. Do not call Feishu Open Platform directly.",
    "- Request body must be UTF-8 encoded JSON bytes; caption supports Unicode text, including Chinese.",
    "- Only call this endpoint when the user asked for an image or when an image is useful to the answer.",
    "[/ChatCCC local capability: send image]",
  ];
  if (input.cwd) {
    lines.splice(2, 0, `Current working directory: ${input.cwd}`);
  }
  return lines.join("\n");
}
