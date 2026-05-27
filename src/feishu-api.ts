import { readdir, stat, readFile, mkdir, writeFile } from "node:fs/promises";
import { extname, resolve as resolvePath } from "node:path";
import { dirname, join } from "node:path";
import sharp from "sharp";

import {
  APP_ID,
  APP_SECRET,
  BASE_URL,
  CHAT_LOGS_DIR,
  PROJECT_ROOT,
  USER_DATA_DIR,
  CLAUDE_SESSION_PREFIX,
  CURSOR_SESSION_PREFIX,
  CODEX_SESSION_PREFIX,
  ts,
  resolveDefaultAgentTool,
  toolDisplayName,
} from "./config.ts";
import { applyPrivacy } from "./privacy.ts";
import { buildHelpCard } from "./cards.ts";

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
  {
    scope: "cardkit:card",
    description: "创建/更新群卡片（流式进度卡片、状态卡片等）",
    method: "POST",
    path: "/cardkit/v1/cards",
    body: JSON.stringify({
      schema: "2.0",
      config: { update_multi: true },
      header: { template: "blue", title: { tag: "plain_text", content: "permcheck" } },
      body: { direction: "vertical", elements: [{ tag: "markdown", content: " " }] },
    }),
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

export async function disbandChat(
  token: string,
  chatId: string
): Promise<void> {
  const resp = await fetch(`${BASE_URL}/im/v1/chats/${chatId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = (await resp.json()) as { code: number; msg?: string };
  if (data.code !== 0) throw new Error(`[${data.code}] ${data.msg}`);
}

export function extractSessionInfo(description: string): { sessionId: string; tool: string } | null {
  const PREFIXES: Array<{ prefix: string; tool: string }> = [
    { prefix: CLAUDE_SESSION_PREFIX, tool: "claude" },
    { prefix: CURSOR_SESSION_PREFIX, tool: "cursor" },
    { prefix: CODEX_SESSION_PREFIX, tool: "codex" },
  ];
  for (const { prefix, tool } of PREFIXES) {
    const idx = description.indexOf(prefix);
    if (idx === -1) continue;
    const after = description.slice(idx + prefix.length).trim();
    const match = after.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    if (match) return { sessionId: match[1], tool };
  }
  return null;
}

/** @deprecated 使用 extractSessionInfo 代替 */
export function extractSessionId(description: string): string | null {
  return extractSessionInfo(description)?.sessionId ?? null;
}

// ---------------------------------------------------------------------------
// Avatar
// ---------------------------------------------------------------------------

const AVATAR_DIR = resolvePath(PROJECT_ROOT, "images", "avatars");
const AVATAR_BADGE_DIR = resolvePath(AVATAR_DIR, "badges");
const AVATAR_KEY_CACHE_FILE = resolvePath(USER_DATA_DIR, "state", "avatar-image-keys.json");
const AVATAR_SOURCES: Record<string, string> = {
  new: resolvePath(AVATAR_DIR, "status_new.png"),
  busy: resolvePath(AVATAR_DIR, "status_busy.png"),
  idle: resolvePath(AVATAR_DIR, "status_idle.png"),
};
const AVATAR_BADGES: Record<string, string> = {
  claude: resolvePath(AVATAR_BADGE_DIR, "badge_claude.png"),
  cursor: resolvePath(AVATAR_BADGE_DIR, "badge_cursor.png"),
  codex: resolvePath(AVATAR_BADGE_DIR, "badge_codex.png"),
};
const AVATAR_SIZE = 256;
const BADGE_SIZE = 92;
const BADGE_MARGIN = 10;

const avatarKeyCache = new Map<string, string>();
let avatarKeyCacheLoaded = false;

function normalizeAvatarTool(tool: string): string {
  return AVATAR_BADGES[tool] ? tool : "claude";
}

function normalizeAvatarStatus(status: string): string {
  return AVATAR_SOURCES[status] ? status : "idle";
}

function avatarCacheKey(tool: string, status: string): string {
  return `${normalizeAvatarTool(tool)}:${normalizeAvatarStatus(status)}`;
}

async function loadAvatarKeyCache(): Promise<void> {
  if (avatarKeyCacheLoaded) return;
  avatarKeyCacheLoaded = true;
  try {
    const raw = await readFile(AVATAR_KEY_CACHE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value.trim()) avatarKeyCache.set(key, value);
    }
  } catch {
    // Missing or malformed cache should not block avatar updates.
  }
}

async function persistAvatarKeyCache(): Promise<void> {
  await mkdir(dirname(AVATAR_KEY_CACHE_FILE), { recursive: true });
  await writeFile(
    AVATAR_KEY_CACHE_FILE,
    JSON.stringify(Object.fromEntries(avatarKeyCache.entries()), null, 2),
    "utf-8",
  );
}

async function renderAvatar(tool: string, status: string): Promise<{ buffer: Buffer; contentType: string; filename: string }> {
  const normalizedTool = normalizeAvatarTool(tool);
  const normalizedStatus = normalizeAvatarStatus(status);
  const badge = await sharp(await readFile(AVATAR_BADGES[normalizedTool]))
    .resize(BADGE_SIZE, BADGE_SIZE, {
      fit: "contain",
      kernel: sharp.kernel.lanczos3,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  const jpeg = await sharp(await readFile(AVATAR_SOURCES[normalizedStatus]))
    .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: "cover", position: "center" })
    .composite([{
      input: badge,
      left: AVATAR_SIZE - BADGE_SIZE - BADGE_MARGIN,
      top: AVATAR_SIZE - BADGE_SIZE - BADGE_MARGIN,
    }])
    .flatten({ background: "#ffffff" })
    .removeAlpha()
    .jpeg({ quality: 95, progressive: false })
    .toBuffer();

  return {
    buffer: jpeg,
    contentType: "image/jpeg",
    filename: `avatar_${normalizedTool}_${normalizedStatus}.jpg`,
  };
}

async function uploadImage(token: string, tool: string, status: string): Promise<string> {
  const image = await renderAvatar(tool, status);
  const blob = new Blob([new Uint8Array(image.buffer)], { type: image.contentType });
  const form = new FormData();
  form.append("image_type", "avatar");
  form.append("image", blob, image.filename);

  // Group avatars need an im/v1 image_key uploaded with image_type=avatar.
  const resp = await fetch(`${BASE_URL}/im/v1/images`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const text = await resp.text();
  let data: { code: number; msg?: string; data?: { image_key?: string } };
  try { data = JSON.parse(text); } catch {
    throw new Error(`uploadImage non-JSON response: ${text.slice(0, 200)}`);
  }
  if (data.code !== 0) throw new Error(`[${data.code}] ${data.msg}`);
  return data.data!.image_key!;
}

async function getOrUploadAvatarKey(token: string, tool: string, status: string): Promise<string> {
  await loadAvatarKeyCache();
  const keyName = avatarCacheKey(tool, status);
  const cached = avatarKeyCache.get(keyName);
  if (cached) return cached;
  const key = await uploadImage(token, tool, status);
  avatarKeyCache.set(keyName, key);
  await persistAvatarKeyCache().catch((err) => {
    console.error(`[${ts()}] [AVATAR] persist cache FAIL: ${(err as Error).message}`);
  });
  console.log(`[${ts()}] [AVATAR] Uploaded "${status}" → image_key=${key}`);
  return key;
}

export async function setChatAvatar(token: string, chatId: string, tool: string, status: string): Promise<void> {
  try {
    const avatarKey = await getOrUploadAvatarKey(token, tool, status);
    const resp = await fetch(`${BASE_URL}/im/v1/chats/${chatId}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ avatar: avatarKey }),
    });
    const text = await resp.text();
    let data: { code: number; msg?: string };
    try { data = JSON.parse(text); } catch {
      if (resp.ok) return;
      throw new Error(`setChatAvatar non-JSON response (status=${resp.status}): ${text.slice(0, 200)}`);
    }
    if (data.code !== 0) throw new Error(`[${data.code}] ${data.msg}`);
  } catch (err) {
    console.error(`[${ts()}] [AVATAR] setChatAvatar FAIL: chatId=${chatId} tool=${tool} status=${status} ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Image download & cache
// ---------------------------------------------------------------------------

const IMAGE_DOWNLOAD_DIR = resolvePath(USER_DATA_DIR, "images", "downloads");
const IMAGE_CACHE_FILE = resolvePath(USER_DATA_DIR, "state", "image-cache.json");

const imageCache = new Map<string, string>();
let imageCacheLoaded = false;

async function loadImageCache(): Promise<void> {
  if (imageCacheLoaded) return;
  imageCacheLoaded = true;
  try {
    const raw = await readFile(IMAGE_CACHE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value.trim()) imageCache.set(key, value);
    }
  } catch { /* missing or malformed cache is not fatal */ }
}

async function persistImageCache(): Promise<void> {
  await mkdir(dirname(IMAGE_CACHE_FILE), { recursive: true });
  await writeFile(
    IMAGE_CACHE_FILE,
    JSON.stringify(Object.fromEntries(imageCache.entries()), null, 2),
    "utf-8",
  );
}

function extFromContentType(contentType: string | null): string {
  if (!contentType) return ".png";
  const mime = contentType.split(";")[0].trim().toLowerCase();
  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/bmp": ".bmp",
    "image/svg+xml": ".svg",
  };
  return map[mime] ?? ".png";
}

async function downloadImage(token: string, messageId: string, fileKey: string): Promise<string> {
  const resp = await fetch(`${BASE_URL}/im/v1/messages/${messageId}/resources/${fileKey}?type=image`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`downloadImage HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  const ext = extFromContentType(resp.headers.get("content-type"));
  const buffer = Buffer.from(await resp.arrayBuffer());
  await mkdir(IMAGE_DOWNLOAD_DIR, { recursive: true });
  const localPath = resolvePath(IMAGE_DOWNLOAD_DIR, `${fileKey}${ext}`);
  await writeFile(localPath, buffer);
  return localPath;
}

export async function getOrDownloadImage(token: string, messageId: string, fileKey: string): Promise<string> {
  await loadImageCache();
  const cached = imageCache.get(fileKey);
  if (cached) return cached;
  const localPath = await downloadImage(token, messageId, fileKey);
  imageCache.set(fileKey, localPath);
  await persistImageCache().catch((err) => {
    console.error(`[${ts()}] [IMAGE] persist cache FAIL: ${(err as Error).message}`);
  });
  console.log(`[${ts()}] [IMAGE] Downloaded ${fileKey} -> ${localPath}`);
  return localPath;
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

const DELAY_NOTICE_THRESHOLD_MS = 15 * 60 * 1000; // 15 分钟

/** 消息延迟超过阈值时生成提醒文本，否则返回 null */
export function formatDelayNotice(createTimeMs: number, messageText?: string, nowMs?: number): string | null {
  const now = nowMs ?? Date.now();
  const delayMs = now - createTimeMs;
  if (delayMs < DELAY_NOTICE_THRESHOLD_MS) return null;

  const sendDate = new Date(createTimeMs);
  const month = sendDate.getMonth() + 1;
  const day = sendDate.getDate();
  const hour = String(sendDate.getHours()).padStart(2, "0");
  const min = String(sendDate.getMinutes()).padStart(2, "0");
  const sendTimeStr = `${month}月${day}日 ${hour}:${min}`;

  const totalMinutes = Math.floor(delayMs / 60000);
  let delayStr: string;
  if (totalMinutes < 60) {
    delayStr = `${totalMinutes} 分钟`;
  } else {
    const hours = Math.floor(totalMinutes / 60);
    const mins = totalMinutes % 60;
    if (hours < 24) {
      delayStr = mins > 0 ? `${hours} 小时 ${mins} 分钟` : `${hours} 小时`;
    } else {
      const days = Math.floor(hours / 24);
      const remainHours = hours % 24;
      delayStr = remainHours > 0 ? `${days} 天 ${remainHours} 小时` : `${days} 天`;
    }
  }

  const contentLine = messageText ? `\n> 原始内容：${messageText.slice(0, 200)}` : "";
  return `> ⚠️ 延迟送达提醒：此消息于 ${sendTimeStr} 发送，因服务离线，延迟约 ${delayStr}后送达${contentLine}`;
}

/**
 * 检测文本中的 markdown 表格，用代码块包裹。
 *
 * 飞书 markdown 渲染对表格支持不稳定（列对齐易错乱），用代码块包裹可保证
 * 等宽字体显示、列对齐正确。只处理不在已有代码块内的表格。
 *
 * 检测规则：至少两行连续的 "|col|col|" 模式，其中必须包含一行分隔行
 * （如 |---|----|），避免将单行含 | 的普通文本误判为表格。
 */
function wrapMarkdownTables(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let inCodeBlock = false;
  let tableRows: string[] = [];
  let foundSeparator = false;

  const isTableRow = (line: string): boolean =>
    /^\s*\|.+\|/.test(line) && !isSeparatorRow(line);

  const isSeparatorRow = (line: string): boolean =>
    /^\s*\|[\s\-:]+\|/.test(line) && /-/.test(line);

  const flushTable = (): void => {
    if (foundSeparator && tableRows.length >= 2) {
      result.push("```");
      result.push(...tableRows);
      result.push("```");
    } else {
      result.push(...tableRows);
    }
    tableRows = [];
    foundSeparator = false;
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      flushTable();
      inCodeBlock = !inCodeBlock;
      result.push(line);
      continue;
    }

    if (inCodeBlock) {
      result.push(line);
      continue;
    }

    if (!foundSeparator) {
      if (isTableRow(line)) {
        tableRows.push(line);
      } else if (tableRows.length > 0 && isSeparatorRow(line)) {
        tableRows.push(line);
        foundSeparator = true;
      } else {
        if (tableRows.length > 0) {
          result.push(...tableRows);
          tableRows = [];
        }
        result.push(line);
      }
    } else {
      if (isTableRow(line)) {
        tableRows.push(line);
      } else {
        flushTable();
        result.push(line);
      }
    }
  }

  flushTable();
  return result.join("\n");
}

export async function sendTextReply(
  token: string,
  chatId: string,
  text: string
): Promise<boolean> {
  const safeText = applyPrivacy(text);
  const wrappedText = wrapMarkdownTables(safeText);
  const card = JSON.stringify({
    config: { wide_screen_mode: true },
    elements: [{ tag: "markdown", content: wrappedText }],
  });
  try {
    const resp = await fetch(`${BASE_URL}/im/v1/messages?receive_id_type=chat_id`, {
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
    const data = (await resp.json().catch(() => ({}))) as { code: number; msg?: string; data?: { message_id?: string } };
    if (data.code !== 0) {
      console.error(`[${ts()}] [SEND] text FAIL: chatId=${chatId} code=${data.code} msg="${data.msg ?? ""}"`);
      return false;
    }
    console.log(`[${ts()}] [SEND] text OK: chatId=${chatId} msgId=${data.data?.message_id ?? "N/A"}`);
    return true;
  } catch (err) {
    console.error(`[${ts()}] [SEND] text FAIL: chatId=${chatId} ${(err as Error).message}`);
    return false;
  }
}

function messageImageContentType(imagePath: string): string {
  const ext = extname(imagePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".bmp") return "image/bmp";
  return "image/png";
}

async function uploadMessageImage(token: string, imagePath: string): Promise<string> {
  const buffer = await readFile(imagePath);
  const blob = new Blob([new Uint8Array(buffer)], {
    type: messageImageContentType(imagePath),
  });
  const form = new FormData();
  form.append("image_type", "message");
  form.append("image", blob, imagePath.split(/[\\/]/).pop() || "image.png");

  const resp = await fetch(`${BASE_URL}/im/v1/images`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const text = await resp.text();
  let data: { code: number; msg?: string; data?: { image_key?: string } };
  try { data = JSON.parse(text); } catch {
    throw new Error(`uploadMessageImage non-JSON response: ${text.slice(0, 200)}`);
  }
  if (data.code !== 0) throw new Error(`[${data.code}] ${data.msg}`);
  const imageKey = data.data?.image_key;
  if (!imageKey) throw new Error("uploadMessageImage response missing image_key");
  return imageKey;
}

export async function sendImageReply(
  token: string,
  chatId: string,
  imagePath: string,
): Promise<boolean> {
  try {
    const imageKey = await uploadMessageImage(token, imagePath);
    const resp = await fetch(`${BASE_URL}/im/v1/messages?receive_id_type=chat_id`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: "image",
        content: JSON.stringify({ image_key: imageKey }),
      }),
    });
    const data = (await resp.json().catch(() => ({}))) as { code?: number; msg?: string; data?: { message_id?: string } };
    if (data.code !== 0) {
      console.error(`[${ts()}] [SEND] image FAIL: chatId=${chatId} path=${imagePath} code=${data.code} msg="${data.msg ?? ""}"`);
      throw new Error(`[${data.code}] ${data.msg ?? "send image failed"}`);
    }
    console.log(`[${ts()}] [SEND] image OK: chatId=${chatId} msgId=${data.data?.message_id ?? "N/A"}`);
    return true;
  } catch (err) {
    if (!(err instanceof Error && err.message.startsWith("["))) {
      console.error(`[${ts()}] [SEND] image FAIL: chatId=${chatId} path=${imagePath} ${(err as Error).message}`);
    }
    throw err;
  }
}

function feishuFileType(ext: string): string {
  const map: Record<string, string> = {
    ".mp4": "mp4",
    ".mp3": "opus", ".wav": "opus", ".ogg": "opus", ".aac": "opus", ".m4a": "opus",
    ".pdf": "pdf", ".doc": "doc", ".docx": "doc",
    ".xls": "xls", ".xlsx": "xls", ".csv": "xls",
    ".ppt": "ppt", ".pptx": "ppt",
  };
  return map[ext] ?? "stream";
}

const VIDEO_EXTENSIONS = [".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv"];

function parseMediaDurationMs(buffer: Buffer): number {
  try {
    let offset = 0;
    while (offset + 8 <= buffer.length) {
      const size = buffer.readUInt32BE(offset);
      const type = buffer.toString("ascii", offset + 4, offset + 8);
      if (size < 8 || offset + size > buffer.length) break;
      if (type === "moov") {
        let mo = offset + 8;
        const moEnd = offset + size;
        while (mo + 8 <= moEnd) {
          const s = buffer.readUInt32BE(mo);
          const t = buffer.toString("ascii", mo + 4, mo + 8);
          if (s < 8 || mo + s > moEnd) break;
          if (t === "mvhd") {
            const ds = mo + 8;
            const ver = buffer[ds];
            let timescale: number, duration: number;
            if (ver === 1) {
              timescale = buffer.readUInt32BE(ds + 20);
              duration = Number(buffer.readBigUInt64BE(ds + 24));
            } else {
              timescale = buffer.readUInt32BE(ds + 12);
              duration = buffer.readUInt32BE(ds + 16);
            }
            if (timescale <= 0) return 0;
            return Math.round((duration / timescale) * 1000);
          }
          mo += s;
        }
      }
      offset += size;
    }
  } catch {}
  return 0;
}

async function uploadMessageFile(token: string, filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase();
  const isVideo = VIDEO_EXTENSIONS.includes(ext);
  const buffer = await readFile(filePath);
  const fileName = filePath.split(/[\\/]/).pop() || "file";
  const fileType = isVideo ? "stream" : feishuFileType(ext);
  const blob = new Blob([new Uint8Array(buffer)], { type: isVideo ? "video/mp4" : "application/octet-stream" });
  const form = new FormData();
  form.append("file_type", fileType);
  form.append("file_name", fileName);
  // 音频文件传 duration（opus 需要）
  if (fileType === "opus") {
    const durationMs = parseMediaDurationMs(buffer);
    if (durationMs > 0) form.append("duration", String(durationMs));
  }
  form.append("file", blob, fileName);

  const resp = await fetch(`${BASE_URL}/im/v1/files`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const text = await resp.text();
  let data: { code: number; msg?: string; data?: { file_key?: string } };
  try { data = JSON.parse(text); } catch {
    throw new Error(`uploadMessageFile non-JSON response: ${text.slice(0, 200)}`);
  }
  if (data.code !== 0) throw new Error(`[${data.code}] ${data.msg}`);
  const fileKey = data.data?.file_key;
  if (!fileKey) throw new Error("uploadMessageFile response missing file_key");
  return fileKey;
}

export async function sendFileReply(
  token: string,
  chatId: string,
  filePath: string,
): Promise<boolean> {
  try {
    const fileKey = await uploadMessageFile(token, filePath);
    const fileName = filePath.split(/[\\/]/).pop() || "file";
    const ext = extname(filePath).toLowerCase();
    // 视频/音频用 msg_type: "media"，文档用 "file"
    const isMedia = [".mp3", ".wav", ".ogg", ".aac", ".m4a"].includes(ext);
    const msgType = isMedia ? "media" : "file";
    const resp = await fetch(`${BASE_URL}/im/v1/messages?receive_id_type=chat_id`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: msgType,
        content: JSON.stringify({ file_key: fileKey }),
      }),
    });
    const data = (await resp.json().catch(() => ({}))) as { code?: number; msg?: string; data?: { message_id?: string } };
    if (data.code !== 0) {
      console.error(`[${ts()}] [SEND] ${msgType} FAIL: chatId=${chatId} path=${filePath} code=${data.code} msg="${data.msg ?? ""}"`);
      throw new Error(`[${data.code}] ${data.msg ?? "send file failed"}`);
    }
    console.log(`[${ts()}] [SEND] ${msgType} OK: chatId=${chatId} name=${fileName} msgId=${data.data?.message_id ?? "N/A"}`);
    return true;
  } catch (err) {
    if (!(err instanceof Error && err.message.startsWith("["))) {
      console.error(`[${ts()}] [SEND] file FAIL: chatId=${chatId} path=${filePath} ${(err as Error).message}`);
    }
    throw err;
  }
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
): Promise<boolean> {
  const safeTitle = applyPrivacy(title);
  const safeContent = applyPrivacy(content);
  const card = JSON.stringify({
    config: { wide_screen_mode: true },
    header: { template, title: { content: safeTitle, tag: "plain_text" } },
    elements: [{ tag: "div", text: { tag: "lark_md", content: safeContent } }],
  });

  try {
    const resp = await fetch(`${BASE_URL}/im/v1/messages?receive_id_type=chat_id`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ receive_id: chatId, msg_type: "interactive", content: card }),
    });
    const data = (await resp.json().catch(() => ({}))) as { code: number; msg?: string; data?: { message_id?: string } };
    if (data.code !== 0) {
      console.error(`[${ts()}] [SEND] card FAIL: chatId=${chatId} title="${title}" code=${data.code} msg="${data.msg ?? ""}"`);
      return false;
    }
    console.log(`[${ts()}] [SEND] card OK: chatId=${chatId} title="${title}" msgId=${data.data?.message_id ?? "N/A"}`);
    return true;
  } catch (err) {
    console.error(`[${ts()}] [SEND] card FAIL: chatId=${chatId} title="${title}" ${(err as Error).message}`);
    return false;
  }
}

export async function sendRawCard(
  token: string,
  chatId: string,
  cardJson: string
): Promise<boolean> {
  const safeJson = applyPrivacy(cardJson);
  try {
    const resp = await fetch(`${BASE_URL}/im/v1/messages?receive_id_type=chat_id`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ receive_id: chatId, msg_type: "interactive", content: safeJson }),
    });
    const data = (await resp.json().catch(() => ({}))) as { code: number; msg?: string; data?: { message_id?: string } };
    if (data.code !== 0) {
      console.error(`[${ts()}] [SEND] raw_card FAIL: chatId=${chatId} code=${data.code} msg="${data.msg ?? ""}"`);
      return false;
    }
    console.log(`[${ts()}] [SEND] raw_card OK: chatId=${chatId} msgId=${data.data?.message_id ?? "N/A"}`);
    return true;
  } catch (err) {
    console.error(`[${ts()}] [SEND] raw_card FAIL: chatId=${chatId} ${(err as Error).message}`);
    return false;
  }
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

    // 微信 chat ID 无法通过飞书 API 发送，跳过
    if (latestChatId.includes("@im.wechat")) {
      console.log(`[${ts()}] [RESTART] Latest chat is WeChat (${latestChatId}), skipping Feishu notification`);
      return;
    }

    console.log(`[${ts()}] [RESTART] Latest active chat: ${latestChatId} (mtime=${new Date(latestTime).toISOString()})`);

    const restartCard = buildHelpCard("", {
      greeting: "Bot 已启动完成，可以继续使用。",
      defaultToolLabel: toolDisplayName(resolveDefaultAgentTool()),
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

/**
 * 发送飞书 post 类型消息（非卡片富文本消息）。
 *
 * post 消息支持 table、text、a、at、img 等富文本元素，
 * 与 interactive 卡片消息不同，post 直接在消息流中渲染。
 *
 * @param postContent 飞书 post content 格式的二维数组，每个元素是一个 paragraph
 */
export async function sendPostMessage(
  token: string,
  chatId: string,
  title: string,
  postContent: unknown[][],
): Promise<boolean> {
  const content = JSON.stringify({
    post: {
      zh_cn: {
        title,
        content: postContent,
      },
    },
  });
  try {
    const resp = await fetch(`${BASE_URL}/im/v1/messages?receive_id_type=chat_id`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: "post",
        content,
      }),
    });
    const data = (await resp.json().catch(() => ({}))) as { code: number; msg?: string; data?: { message_id?: string } };
    if (data.code !== 0) {
      console.error(`[${ts()}] [SEND] post FAIL: chatId=${chatId} code=${data.code} msg="${data.msg ?? ""}"`);
      return false;
    }
    console.log(`[${ts()}] [SEND] post OK: chatId=${chatId} msgId=${data.data?.message_id ?? "N/A"}`);
    return true;
  } catch (err) {
    console.error(`[${ts()}] [SEND] post FAIL: chatId=${chatId} ${(err as Error).message}`);
    return false;
  }
}
