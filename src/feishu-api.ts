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

// 不缓存 token：飞书会在某些情况下（多实例同 APP_ID 反复签发、控制台重置 secret、限流回收等）
// 让旧 token 在标称有效期内被服务端提前失效。一旦缓存命中失效 token，进程在 TTL 内
// 所有飞书调用会持续返回 99991663。每次现签可让"被服务端干掉"的 token 自然被新 token 覆盖。
export async function getTenantAccessToken(): Promise<string> {
  const resp = await fetch(`${BASE_URL}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const data = (await resp.json()) as { code: number; msg?: string; tenant_access_token: string };
  if (data.code !== 0) {
    throw new Error(`飞书返回 code=${data.code}，msg=${data.msg ?? "(无)"}（请核对 App ID / Secret 与应用发布状态）`);
  }
  return data.tenant_access_token;
}

// ---------------------------------------------------------------------------
// Permission verification (startup check)
// ---------------------------------------------------------------------------

interface PermissionDef {
  scope: string;
  description: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  body?: string; // JSON string, supports __TOKEN__ placeholder
}

/** 项目所需的所有飞书权限及对应的非破坏性测试请求 */
const REQUIRED_PERMISSIONS: PermissionDef[] = [
  {
    scope: "im:chat",
    description: "读取/创建/更新群聊（创建会话群、改名、读群信息）",
    method: "GET",
    path: "/im/v1/chats?page_size=1",
  },
  {
    scope: "im:message:send_as_bot",
    description: "以机器人身份发送消息（文本/卡片回复）",
    method: "POST",
    path: "/im/v1/messages?receive_id_type=chat_id",
    body: JSON.stringify({
      receive_id: "oc_000000000000000000000000",
      msg_type: "text",
      content: JSON.stringify({ text: "permcheck" }),
    }),
  },
  {
    scope: "im:message:reaction",
    description: "添加消息表情回应（Give a like）",
    method: "POST",
    path: "/im/v1/messages/om_000000000000000000000000/reactions",
    body: JSON.stringify({ reaction_type: { emoji_type: "Get" } }),
  },
  {
    scope: "im:message",
    description: "撤回/更新消息（关闭卡片、撤回卡片消息）",
    method: "PATCH",
    path: "/im/v1/messages/om_000000000000000000000000",
    body: JSON.stringify({ content: JSON.stringify({ elements: [{ tag: "markdown", content: " " }] }) }),
  },
];

interface PermissionResult {
  scope: string;
  description: string;
  ok: boolean;
  detail: string;
}

/** 对单个权限做非破坏性探针请求。返回 false 表示权限缺失。 */
async function probePermission(token: string, def: PermissionDef): Promise<PermissionResult> {
  const url = `${BASE_URL}${def.path}`;
  try {
    const resp = await fetch(url, {
      method: def.method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: def.body ?? undefined,
    });
    const data = (await resp.json()) as { code: number; msg?: string };
    if (data.code === 0) {
      return { scope: def.scope, description: def.description, ok: true, detail: "通过" };
    }
    const msg = (data.msg ?? "").toLowerCase();
    // 飞书权限缺失时 msg 通常含 "permission" / "scope" / "denied" / "unauthorized"
    // 权限 OK 但资源不存在时 msg 含 "not found" / "chat" / "message" / "不存在"
    const deniedKeywords = ["permission", "scope", "denied", "unauthorized", "无权限", "权限", "access denied"];
    const isDenied = deniedKeywords.some((kw) => msg.includes(kw));
    if (isDenied) {
      return { scope: def.scope, description: def.description, ok: false, detail: `权限缺失 → code=${data.code} msg=${data.msg}` };
    }
    // 资源不存在 = 通过了权限检查，只是目标资源不存在（预期内）
    return { scope: def.scope, description: def.description, ok: true, detail: `通过（资源不存在: code=${data.code} msg=${data.msg}）` };
  } catch (err) {
    return { scope: def.scope, description: def.description, ok: false, detail: `网络异常: ${(err as Error).message}` };
  }
}

/**
 * 验证所有必需权限。返回失败的权限列表。
 * 若全部通过返回空数组。
 */
export async function verifyAllPermissions(token: string): Promise<PermissionResult[]> {
  const results: PermissionResult[] = [];
  for (const def of REQUIRED_PERMISSIONS) {
    const r = await probePermission(token, def);
    results.push(r);
  }
  return results;
}

/** 输出权限验证结果到控制台和文件日志，并返回是否有失败 */
export function reportPermissionResults(
  results: PermissionResult[],
  log: (msg: string) => void
): boolean {
  const failed = results.filter((r) => !r.ok);
  const passed = results.filter((r) => r.ok);

  log(`\n${"-".repeat(60)}`);
  log(`[权限验证] 飞书应用权限检查完成: ${passed.length}/${results.length} 通过`);
  for (const r of passed) {
    log(`  [通过] ${r.scope} — ${r.description}`);
  }
  for (const r of failed) {
    log(`  [失败] ${r.scope} — ${r.description}`);
    log(`         原因: ${r.detail}`);
  }
  if (failed.length > 0) {
    log(`\n[权限验证] 以下权限未在飞书开放平台中配置:`);
    for (const r of failed) {
      log(`  - ${r.scope}: ${r.description}`);
    }
    log(`\n请到飞书开放平台 → 应用详情 → 权限管理 中开通上述权限后重试。`);
    log(`${"-".repeat(60)}\n`);
  } else {
    log(`${"-".repeat(60)}\n`);
  }
  return failed.length > 0;
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