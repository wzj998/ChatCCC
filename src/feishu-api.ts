import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  APP_ID,
  APP_SECRET,
  BASE_URL,
  CHAT_LOGS_DIR,
  PROJECT_ROOT,
  SESSION_DESC_PREFIX,
  ts,
} from "./config.ts";
import { buildButtons } from "./cards.ts";

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export async function getTenantAccessToken(): Promise<string> {
  const resp = await fetch(`${BASE_URL}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const data = (await resp.json()) as { code: number; msg?: string; tenant_access_token: string };
  if (data.code !== 0) throw new Error(`Failed to get token: ${data.msg}`);
  return data.tenant_access_token;
}

// ---------------------------------------------------------------------------
// Group chat CRUD
// ---------------------------------------------------------------------------

export async function createGroupChat(
  token: string,
  name: string,
  userIds: string[]
): Promise<string> {
  const resp = await fetch(`${BASE_URL}/im/v1/chats`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, description: "Creating...", user_id_list: userIds }),
  });
  const data = (await resp.json()) as {
    code: number; msg?: string; data?: { chat_id?: string };
  };
  if (data.code !== 0) throw new Error(`[${data.code}] ${data.msg}`);
  return data.data!.chat_id!;
}

export async function updateChatInfo(
  token: string,
  chatId: string,
  name: string,
  description: string
): Promise<void> {
  const resp = await fetch(`${BASE_URL}/im/v1/chats/${chatId}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, description }),
  });
  const data = (await resp.json()) as { code: number; msg?: string };
  if (data.code !== 0) throw new Error(`[${data.code}] ${data.msg}`);
}

export async function getChatInfo(
  token: string,
  chatId: string
): Promise<{ name: string; description: string }> {
  const resp = await fetch(`${BASE_URL}/im/v1/chats/${chatId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = (await resp.json()) as {
    code: number; msg?: string; data?: { name?: string; description?: string };
  };
  if (data.code !== 0) throw new Error(`[${data.code}] ${data.msg}`);
  return {
    name: data.data?.name ?? "",
    description: data.data?.description ?? "",
  };
}

export function extractSessionId(description: string): string | null {
  const idx = description.indexOf(SESSION_DESC_PREFIX);
  if (idx === -1) return null;
  const after = description.slice(idx + SESSION_DESC_PREFIX.length).trim();
  const match = after.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

export async function sendTextReply(
  token: string,
  chatId: string,
  text: string
): Promise<void> {
  const card = JSON.stringify({
    config: { wide_screen_mode: true },
    elements: [{ tag: "markdown", content: text }],
  });
  await fetch(`${BASE_URL}/im/v1/messages?receive_id_type=chat_id`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: "interactive",
      content: card,
    }),
  });
}

export async function addReaction(
  token: string,
  messageId: string,
  emojiType = "Get"
): Promise<void> {
  await fetch(`${BASE_URL}/im/v1/messages/${messageId}/reactions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ reaction_type: { emoji_type: emojiType } }),
  });
}

export async function sendCardReply(
  token: string,
  chatId: string,
  title: string,
  content: string,
  template = "green"
): Promise<void> {
  const card = JSON.stringify({
    config: { wide_screen_mode: true },
    header: { template, title: { content: title, tag: "plain_text" } },
    elements: [{ tag: "div", text: { tag: "lark_md", content } }],
  });

  await fetch(`${BASE_URL}/im/v1/messages?receive_id_type=chat_id`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ receive_id: chatId, msg_type: "interactive", content: card }),
  });
}

// 重启后，向最后有发言的会话发送 "已重启" 卡片（基于 chat_logs 的文件修改时间）
export async function sendRestartCard(token: string): Promise<void> {
  try {
    const files = await readdir(CHAT_LOGS_DIR).catch(() => [] as string[]);
    if (files.length === 0) {
      console.log(`[${ts()}] [RESTART] No chat logs found, skipping notification`);
      return;
    }

    let latestChatId: string | null = null;
    let latestTime = 0;
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const filePath = join(CHAT_LOGS_DIR, f);
      const st = await stat(filePath).catch(() => null);
      if (!st) continue;
      if (st.mtimeMs > latestTime) {
        latestTime = st.mtimeMs;
        latestChatId = f.replace(".jsonl", "");
      }
    }

    if (!latestChatId) {
      console.log(`[${ts()}] [RESTART] Could not determine latest chat with messages`);
      return;
    }

    console.log(`[${ts()}] [RESTART] Latest active chat: ${latestChatId} (mtime=${new Date(latestTime).toISOString()})`);

    const restartCard = JSON.stringify({
      config: { wide_screen_mode: true },
      header: { template: "green", title: { content: "ChatCCC Started", tag: "plain_text" } },
      elements: [
        { tag: "div", text: { tag: "lark_md", content: "Bot 已启动完成，可以继续使用。\n\n发送 **/new** 创建新会话，或直接在已有会话群中发消息。" } },
        buildButtons([
          { text: "新建会话（/new）", value: JSON.stringify({ cmd: "new" }), type: "primary" },
          { text: "重启Chat CCC（/restart）", value: JSON.stringify({ cmd: "restart" }), type: "danger" },
          { text: "查看/切换工作路径（/cd）", value: JSON.stringify({ cmd: "cd" }), type: "default" },
        ]),
      ],
    });
    await fetch(`${BASE_URL}/im/v1/messages?receive_id_type=chat_id`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ receive_id: latestChatId, msg_type: "interactive", content: restartCard }),
    });
    console.log(`[${ts()}] [RESTART] Notification sent to chat ${latestChatId}`);
  } catch (err) {
    console.error(`[${ts()}] [RESTART] Failed to send notification: ${(err as Error).message}`);
  }
}

// 撤回消息，成功返回 true
export async function recallMessage(token: string, messageId: string): Promise<boolean> {
  const resp = await fetch(`${BASE_URL}/im/v1/messages/${messageId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = (await resp.json()) as { code: number };
  return data.code === 0;
}

// 更新卡片消息内容（PATCH 方式仅适用于 interactive 消息）
// 返回 true 表示更新成功，false 表示 API 返回了错误
export async function updateCardMessage(token: string, messageId: string, content: string): Promise<boolean> {
  const resp = await fetch(`${BASE_URL}/im/v1/messages/${messageId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content }),
  });
  const data = await resp.json().catch(() => ({})) as { code: number; msg?: string };
  if (data.code !== 0) {
    console.error(`[${ts()}] [PATCH] updateCardMessage FAIL: messageId=${messageId} code=${data.code} msg="${data.msg}"`);
    return false;
  }
  return true;
}