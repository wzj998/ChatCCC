import type { IncomingMessage, ServerResponse } from "node:http";

import type { AgentImageGrant } from "./agent-image-rpc.ts";
import type { AgentFileGrant } from "./agent-file-rpc.ts";
import { ts } from "./config.ts";

export const AGENT_SESSION_GRANTS_PATH = "/api/agent/session-grants";

interface SessionGrantsEntry {
  image: AgentImageGrant;
  file: AgentFileGrant;
}

const sessionGrants = new Map<string, SessionGrantsEntry>();

export function setSessionGrants(
  sessionId: string,
  imageGrant: AgentImageGrant,
  fileGrant: AgentFileGrant,
): void {
  sessionGrants.set(sessionId, { image: imageGrant, file: fileGrant });
}

export function clearSessionGrants(sessionId: string): void {
  sessionGrants.delete(sessionId);
}

function jsonReply(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

export async function handleAgentGrantsRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== AGENT_SESSION_GRANTS_PATH) return false;

  if (req.method !== "GET") {
    jsonReply(res, 405, { ok: false, error: "Method not allowed" });
    return true;
  }

  const sid = url.searchParams.get("sid");
  if (!sid) {
    jsonReply(res, 400, { ok: false, error: "Missing sid parameter" });
    return true;
  }

  const entry = sessionGrants.get(sid);
  if (!entry) {
    jsonReply(res, 404, { ok: false, error: "No active grants for this session" });
    return true;
  }

  const now = Date.now();
  if (entry.image.expiresAt <= now || entry.file.expiresAt <= now) {
    sessionGrants.delete(sid);
    jsonReply(res, 410, { ok: false, error: "Session grants expired" });
    return true;
  }

  console.log(`[${ts()}] [AGENT-GRANTS] query session=${sid}`);
  jsonReply(res, 200, {
    ok: true,
    image: { url: entry.image.url, token: entry.image.token },
    file: { url: entry.file.url, token: entry.file.token },
  });
  return true;
}