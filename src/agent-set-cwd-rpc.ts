import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { stat } from "node:fs/promises";

import { addRecentDir, setDefaultCwd } from "./config.ts";
import { readUtf8JsonBody } from "./agent-rpc-body.ts";
import { getChatsForSession } from "./session-chat-binding.ts";

export const AGENT_SET_CWD_PATH = "/api/agent/set-cwd";

const MAX_REQUEST_BYTES = 64 * 1024;

function jsonReply(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Agent 本地能力：设置后续新建会话的默认工作目录（等价于 /cd，不改变当前会话）。
 * 请求携带发起者当前 session_id，主进程据此反查 chatId，并持久化到该 chat 的
 * working_dir 文件，同时写入最近目录记录。
 */
export async function handleAgentSetCwdRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== AGENT_SET_CWD_PATH) return false;

  if (req.method !== "POST") {
    jsonReply(res, 405, { ok: false, error: "Method not allowed" });
    return true;
  }

  let payload: { session_id?: unknown; dir?: unknown; path?: unknown };
  try {
    payload = await readUtf8JsonBody(req, MAX_REQUEST_BYTES);
  } catch (err) {
    jsonReply(res, 400, { ok: false, error: (err as Error).message || "Invalid JSON" });
    return true;
  }

  const sessionId = stringValue(payload.session_id);
  if (!sessionId) {
    jsonReply(res, 400, { ok: false, error: "Missing session_id" });
    return true;
  }

  const rawDir = stringValue(payload.dir) || stringValue(payload.path);
  if (!rawDir) {
    jsonReply(res, 400, { ok: false, error: "dir must be a non-empty string" });
    return true;
  }

  const dir = resolve(rawDir);
  try {
    const st = await stat(dir);
    if (!st.isDirectory()) {
      jsonReply(res, 400, { ok: false, error: `path is not a directory: ${dir}` });
      return true;
    }
  } catch {
    jsonReply(res, 400, { ok: false, error: `directory does not exist: ${dir}` });
    return true;
  }

  const chatIds = getChatsForSession(sessionId);
  const chatId = chatIds[0];
  if (!chatId) {
    jsonReply(res, 404, { ok: false, error: "No chat bound to this session; cannot set working directory." });
    return true;
  }

  try {
    await setDefaultCwd(dir, chatId);
    await addRecentDir(dir);
    jsonReply(res, 200, { ok: true, dir, chat_id: chatId });
  } catch (err) {
    jsonReply(res, 500, { ok: false, error: (err as Error).message });
  }
  return true;
}
