import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { homedir } from "node:os";

import { resolveDefaultAgentTool } from "./config.ts";
import { readUtf8JsonBody } from "./agent-rpc-body.ts";
import { delegateAgentTask } from "./agent-delegate-task.ts";
import type { PlatformAdapter } from "./platform-adapter.ts";
import { applySharedPrefix } from "./shared-prefix.ts";
import {
  beginSafeMaintenanceTrackedWork,
  isSafeMaintenanceAdmissionClosed,
} from "./safe-maintenance.ts";

export const AGENT_DELEGATE_TASK_PATH = "/api/agent/delegate-task";

const MAX_REQUEST_BYTES = 128 * 1024;
const VALID_TOOLS = new Set(["claude", "cursor", "codex", "ccc", "dsh"]);

interface AgentDelegateTaskPayload {
  tool?: unknown;
  cwd?: unknown;
  prompt?: unknown;
  text?: unknown;
  message?: unknown;
  open_id?: unknown;
  open_ids?: unknown;
  openIds?: unknown;
  chat_name?: unknown;
}

function jsonReply(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeOpenIds(payload: AgentDelegateTaskPayload): string[] {
  const explicitOpenId = stringValue(payload.open_id);
  if (explicitOpenId) return [explicitOpenId];

  const rawOpenIds = Array.isArray(payload.open_ids) ? payload.open_ids : payload.openIds;
  if (!Array.isArray(rawOpenIds)) return [];
  return rawOpenIds
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function promptFromPayload(payload: AgentDelegateTaskPayload): string {
  return stringValue(payload.prompt) || stringValue(payload.text) || stringValue(payload.message);
}

function validateTool(rawTool: unknown): string {
  const tool = stringValue(rawTool).toLowerCase() || resolveDefaultAgentTool();
  if (!VALID_TOOLS.has(tool)) throw new Error(`unsupported tool: ${tool}`);
  return tool;
}

function validateCwd(rawCwd: unknown): string {
  const cwd = stringValue(rawCwd);
  if (!cwd) return homedir();
  return resolve(cwd);
}

export async function handleAgentDelegateTaskRequest(
  req: IncomingMessage,
  res: ServerResponse,
  platform: PlatformAdapter,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== AGENT_DELEGATE_TASK_PATH) return false;

  if (req.method !== "POST") {
    jsonReply(res, 405, { ok: false, error: "Method not allowed" });
    return true;
  }

  if (platform.kind !== "feishu") {
    jsonReply(res, 409, { ok: false, error: "This endpoint currently only supports Feishu." });
    return true;
  }

  let payload: AgentDelegateTaskPayload;
  try {
    payload = await readUtf8JsonBody(req, MAX_REQUEST_BYTES);
  } catch (err) {
    jsonReply(res, 400, { ok: false, error: (err as Error).message || "Invalid JSON" });
    return true;
  }

  let tool: string;
  let cwd: string;
  let promptText: string;
  let promptNamePrefix: string;
  let openIds: string[];
  try {
    tool = validateTool(payload.tool);
    cwd = validateCwd(payload.cwd);
    const rawPrompt = promptFromPayload(payload);
    const sharedPrefix = applySharedPrefix(rawPrompt);
    promptText = sharedPrefix.text;
    promptNamePrefix = sharedPrefix.body || rawPrompt;
    openIds = normalizeOpenIds(payload);
    if (openIds.length === 0) throw new Error("open_id or openIds must include at least one user");
  } catch (err) {
    jsonReply(res, 400, { ok: false, error: (err as Error).message });
    return true;
  }

  try {
    if (isSafeMaintenanceAdmissionClosed()) {
      jsonReply(res, 409, { ok: false, error: "ChatCCC 正在等待安全维护，暂不接受新的委派任务。" });
      return true;
    }
    const release = beginSafeMaintenanceTrackedWork("agent-delegate-task");
    try {
    const result = await delegateAgentTask({
      platform,
      tool,
      cwd,
      promptText,
      openIds,
      chatNamePrefix: stringValue(payload.chat_name) || promptNamePrefix.slice(0, 10),
    });
    jsonReply(res, 200, {
      ok: true,
      chat_id: result.chatId,
      session_id: result.sessionId,
      tool: result.tool,
      cwd: result.cwd,
    });
    } finally {
      release();
    }
  } catch (err) {
    jsonReply(res, 500, { ok: false, error: (err as Error).message });
  }
  return true;
}

export function buildAgentDelegateTaskCapabilityPrompt(input: { url: string; cwd?: string; openId?: string }): string {
  const lines = [
    "[ChatCCC local capability: new session]",
    "You can create a separate Feishu ChatCCC agent session (a new group) and optionally assign its first task by calling this local endpoint.",
    "",
    `POST ${input.url}`,
    "Content-Type: application/json; charset=utf-8",
    "",
    'Body: {"tool":"claude|cursor|codex|ccc|dsh","cwd":"absolute working directory","open_id":"initiator open_id","prompt":"optional first task"}',
    "",
    "Rules:",
    "- Use this when the user asks to start a new conversation/session, optionally in a specific directory.",
    "- Pass open_id exactly as provided to you; the new group will only include that requester.",
    "- Pass cwd as an absolute local path. When the user does not name a directory, use your current working directory.",
    "- tool is optional; omit it to use the default agent, or pass one of claude/cursor/codex/ccc/dsh when the user names a tool.",
    "- prompt is optional; omit it to just create the session without sending a first task.",
    "- The prompt is sent through the normal ChatCCC prompt path, so project prompt injection and IM skills still apply.",
    "- Request body must be UTF-8 encoded JSON bytes. Do not call Feishu Open Platform directly.",
    "[/ChatCCC local capability: new session]",
  ];
  if (input.cwd) lines.splice(2, 0, `Current working directory: ${input.cwd}`);
  if (input.openId) lines.splice(2, 0, `Initiator open_id: ${input.openId}`);
  return lines.join("\n");
}
