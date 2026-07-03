import type { IncomingMessage, ServerResponse } from "node:http";

import { reloadRuntimeConfig, type RuntimeReloadResult } from "./runtime-reload.ts";

export const AGENT_RELOAD_CONFIG_PATH = "/api/agent/reload-config";

type ReloadRuntimeConfig = (source: string) => RuntimeReloadResult | Promise<RuntimeReloadResult>;

function jsonReply(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

export async function handleAgentReloadConfigRequest(
  req: IncomingMessage,
  res: ServerResponse,
  reload: ReloadRuntimeConfig = reloadRuntimeConfig,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== AGENT_RELOAD_CONFIG_PATH) return false;

  if (req.method !== "POST") {
    jsonReply(res, 405, { ok: false, error: "Method not allowed" });
    return true;
  }

  try {
    const result = await reload("agent-reload-api");
    jsonReply(res, 200, { ok: true, ...result });
  } catch (err) {
    jsonReply(res, 500, { ok: false, error: (err as Error).message });
  }
  return true;
}
