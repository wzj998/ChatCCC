import type { IncomingMessage, ServerResponse } from "node:http";

import { getChatGptSubscriptionStatus } from "./chatgpt-subscription.ts";

export const CHATGPT_SUBSCRIPTION_PATH = "/api/chatgpt/subscription";

function jsonReply(res: ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

export async function handleChatGptSubscriptionRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== CHATGPT_SUBSCRIPTION_PATH) return false;

  if (method !== "GET") {
    jsonReply(res, 405, { ok: false, code: "method_not_allowed", reason: "Use GET." });
    return true;
  }

  jsonReply(res, 200, await getChatGptSubscriptionStatus());
  return true;
}
