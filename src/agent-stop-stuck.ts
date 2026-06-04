import type { IncomingMessage, ServerResponse } from "node:http";

import { readUtf8JsonBody } from "./agent-rpc-body.ts";
import { activePrompts, getChatsForSession, cancelQueuedMessage } from "./session-chat-binding.ts";
import { getPlatformForChat } from "./session.ts";
import { readStreamState, writeStreamState } from "./stream-state.ts";
import { ts } from "./config.ts";

export const AGENT_STOP_STUCK_PATH = "/api/agent/stop-stuck-loop";

const MAX_REQUEST_BYTES = 8 * 1024;

/** 已处理过 stop-stuck-loop 的 session，防止 agent 循环中反复调用 */
const processedSessions = new Set<string>();

function jsonReply(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

/**
 * 从原始 body 字节中用正则尽力提取 session_id。
 * 兼容 JSON 编码异常（如 GBK 中文导致 JSON.parse 失败）的场景。
 */
function extractSessionIdFromRaw(buf: Buffer): string | null {
  // 匹配 "session_id":"<uuid>" 或 "session_id": "<uuid>"
  const match = buf.toString("latin1").match(/"session_id"\s*:\s*"([^"]+)"/);
  return match?.[1] ?? null;
}

export async function handleAgentStopStuckRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== AGENT_STOP_STUCK_PATH) return false;

  if (req.method !== "POST") {
    jsonReply(res, 405, { error: "Method not allowed, use POST" });
    return true;
  }

  let body: { session_id?: string; final_reply?: string };
  let rawBody: Buffer | null = null;
  try {
    body = await readUtf8JsonBody<{ session_id?: string; final_reply?: string }>(req, MAX_REQUEST_BYTES);
  } catch (err) {
    // JSON 解析失败时仍尝试从原始字节中提取 session_id 并强行停止
    // 宁可输出乱码，也不能让 agent 持续循环
    rawBody = (err as { rawBody?: Buffer }).rawBody as Buffer | undefined ?? null;
    if (!rawBody) {
      jsonReply(res, 400, { error: `Invalid request body: ${(err as Error).message}` });
      return true;
    }
    const fallbackId = extractSessionIdFromRaw(rawBody);
    if (!fallbackId) {
      jsonReply(res, 400, { error: `Invalid request body: ${(err as Error).message}` });
      return true;
    }
    body = { session_id: fallbackId };
  }

  const sessionId = typeof body?.session_id === "string" ? body.session_id.trim() : "";
  if (!sessionId) {
    jsonReply(res, 400, { error: "session_id is required" });
    return true;
  }

  const prompt = activePrompts.get(sessionId);
  if (!prompt) {
    // session 可能已被清理，清理去重记录
    processedSessions.delete(sessionId);
    jsonReply(res, 404, { error: "Session not found or not running" });
    return true;
  }

  // 去重：同一 session 只处理一次，防止 agent 循环中反复调用
  if (processedSessions.has(sessionId)) {
    jsonReply(res, 200, { ok: true, deduplicated: true });
    return true;
  }
  processedSessions.add(sessionId);

  // 先发"卡住"提示消息给所有绑定的群聊
  const chats = getChatsForSession(sessionId);
  for (const chatId of chats) {
    const platform = getPlatformForChat(chatId);
    if (platform) {
      await platform.sendText(chatId, "⚠️ Agent 检测到自己陷入了循环，正在结束生成…").catch(() => {});
    }
  }

  // 丢弃缓存队列中的消息
  cancelQueuedMessage(sessionId);

  const finalReply = typeof body?.final_reply === "string" ? body.final_reply.trim() : "";

  // fire-and-forget：立即把 stream-state 标为 done（而非 stopped），
  // 让 display loop 以"正常完成"而非"已停止"来渲染卡片和最终回复。
  // 不设 prompt.stopped = true，这样 runAgentSession 的 finally 也会写 "done"。
  void (async () => {
    try {
      const current = await readStreamState(sessionId);
      if (!current) return;
      if (current.status !== "running") return;
      await writeStreamState({
        ...current,
        status: "done",
        finalReply: finalReply ? current.finalReply + "\n\n" + finalReply : current.finalReply,
        updatedAt: Date.now(),
      });
    } catch (err) {
      console.warn(
        `[${ts()}] [STUCK-LOOP] writeStreamState(done) failed for ${sessionId}: ${(err as Error).message}`,
      );
    }
  })();

  // 先关闭底层 SDK session，终止 CLI 子进程，然后再 abort 清理 adapter 层
  prompt.closeSession?.();
  // 不设 stopped 标记 → finally block 写 "done" → 卡片正常结束
  prompt.controller.abort();

  console.log(`[${ts()}] [STUCK-LOOP] Session ${sessionId} aborted as done (agent detected stuck loop, final_reply=${finalReply ? "yes" : "no"})`);

  jsonReply(res, 200, { ok: true });
  return true;
}