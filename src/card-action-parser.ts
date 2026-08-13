// ---------------------------------------------------------------------------
// Card action helper: parse button click into text command
// ---------------------------------------------------------------------------

import { buildUpdateCommandId, extractFeishuEventId } from "./update-command-guard.ts";

export interface CardActionResult {
  text: string;
  chatId: string;
  openId: string;
  commandId?: string;
}

/**
 * 卡片按钮 value → 文本命令的映射表。
 *
 * 新增 help / progress 卡片按钮时，必须同步在此登记，否则点击会被
 * parseCardAction 判定为未知 cmd 并静默丢弃（按钮无任何响应）。
 */
export const CARD_ACTION_CMD_MAP: Record<string, string> = {
  stop: "/stop",
  cancel: "/cancel",
  new: "/new",
  "new claude": "/new claude",
  "new cursor": "/new cursor",
  "new codex": "/new codex",
  "new ccc": "/new ccc",
  restart: "/restart",
  update: "/update",
  state: "/state",
  cd: "/cd",
  sessions: "/sessions",
  forget: "/forget",
};

/** 把按钮 cmd 映射为文本命令；未登记返回空字符串。 */
export function cardActionToCommand(cmd: string): string {
  return CARD_ACTION_CMD_MAP[cmd] ?? "";
}

export function parseCardAction(data: unknown): CardActionResult | null {
  const raw = (data as Record<string, unknown>)?.event ?? data;
  const action = (raw as Record<string, unknown>)?.action as { value?: unknown } | undefined;
  if (!action?.value) return null;

  let cmd: string | undefined;
  if (typeof action.value === "object" && action.value !== null) {
    cmd = (action.value as Record<string, string>).action;
  } else if (typeof action.value === "string") {
    try {
      let v: unknown = JSON.parse(action.value);
      if (typeof v === "string") v = JSON.parse(v);
      cmd = (v as { cmd?: string; action?: string }).cmd ?? (v as { action?: string }).action;
    } catch { return null; }
  }
  if (!cmd) return null;

  let text = cardActionToCommand(cmd);
  if (cmd === "cd" && typeof action.value === "object" && action.value !== null) {
    const path = (action.value as Record<string, string>).path;
    if (path) text = `/cd ${path}`;
  }
  // cmd 本身就是以 / 开头的完整指令时，直接使用（如 /model <name> 动态按钮）
  if (!text && cmd.startsWith("/")) text = cmd;
  if (!text) return null;

  const chatId =
    ((raw as Record<string, unknown>).open_chat_id as string) ??
    ((raw as Record<string, unknown>).context as Record<string, unknown>)?.open_chat_id as string ??
    ((raw as Record<string, unknown>).message as Record<string, unknown>)?.chat_id as string ??
    "";
  const openId =
    ((raw as Record<string, unknown>).operator as Record<string, unknown>)?.open_id as string ??
    "";

  return {
    text,
    chatId,
    openId,
    commandId: buildUpdateCommandId("card", extractFeishuEventId(data)),
  };
}
