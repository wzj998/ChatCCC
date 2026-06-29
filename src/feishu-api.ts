import { readdir, stat, readFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
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
  config,
} from "./config.ts";
import { getCursorUsageSummary, type CursorUsageSummary } from "./cursor-usage.ts";
import type { ChatAvatarUsageHints } from "./platform-adapter.ts";
import { applyPrivacy } from "./privacy.ts";

// ---------------------------------------------------------------------------
// 合并转发消息类型
// ---------------------------------------------------------------------------

export interface FeishuMessageItem {
  message_id?: string;
  msg_type?: string;
  body?: { content?: string };
  sender?: { id?: string; id_type?: string };
  create_time?: string;
  upper_message_id?: string;
}
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
  {
    scope: "im:message:read",
    description: "读取合并转发消息中的子消息列表",
    method: "GET",
    path: "/im/v1/messages/om_000000000000000000000000000000",
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
const AVATAR_COMBINATIONS_DIR = resolvePath(AVATAR_DIR, "combinations");
const AVATAR_KEY_CACHE_FILE = resolvePath(USER_DATA_DIR, "state", "avatar-image-keys.json");
const CODEX_AUTH_FILE = resolvePath(homedir(), ".codex", "auth.json");
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const CODEX_RESET_CONSUME_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";
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
const AVATAR_BADGE_SIZE = 92;
const AVATAR_BADGE_MARGIN = 10;
const CODEX_AVATAR_USAGE_STYLE_VERSION = "usage-ring-gray-consumed-v13";
const CURSOR_AVATAR_USAGE_STYLE_VERSION = "usage-battery-v1";

export interface CodexUsageBalance {
  usedPercent: number;
  remainingPercent: number;
  resetAtEpochSeconds: number | null;
  resetAfterSeconds: number | null;
}

export interface CodexRateLimitResetCredit {
  grantedAt: string | null;
  expiresAt: string;
}

export interface CodexUsageSummary {
  fiveHour: CodexUsageBalance;
  weekly: CodexUsageBalance | null;
  rateLimitResetCreditsAvailable: number | null;
  rateLimitResetCredits: CodexRateLimitResetCredit[] | null;
}

export type CodexResetConsumeCode = "reset" | "nothing_to_reset" | "no_credit" | "already_redeemed";

export interface CodexResetConsumeResult {
  code: CodexResetConsumeCode;
  windowsReset: number;
}

const avatarKeyCache = new Map<string, string>();
let avatarKeyCacheLoaded = false;

function normalizeAvatarTool(tool: string): string {
  return AVATAR_BADGES[tool] ? tool : "claude";
}

function normalizeAvatarStatus(status: string): string {
  return AVATAR_SOURCES[status] ? status : "idle";
}

function avatarCombinationPath(tool: string, status: string): string {
  return resolvePath(AVATAR_COMBINATIONS_DIR, `avatar_${normalizeAvatarTool(tool)}_${normalizeAvatarStatus(status)}.png`);
}

function avatarCacheKey(
  tool: string,
  status: string,
  codexUsage: CodexUsageSummary | null = null,
  cursorBatteryPercent: number | null = null,
): string {
  const normalizedTool = normalizeAvatarTool(tool);
  const normalizedStatus = normalizeAvatarStatus(status);
  if (normalizedTool === "codex") {
    return codexUsage
      ? `${normalizedTool}:${normalizedStatus}:${CODEX_AVATAR_USAGE_STYLE_VERSION}:week-battery:${codexUsage.weekly?.remainingPercent}:5h-ring:${codexUsage.fiveHour.remainingPercent}`
      : `${normalizedTool}:${normalizedStatus}:plain`;
  }
  if (normalizedTool === "cursor") {
    return cursorBatteryPercent !== null
      ? `${normalizedTool}:${normalizedStatus}:${CURSOR_AVATAR_USAGE_STYLE_VERSION}:battery:${cursorBatteryPercent}`
      : `${normalizedTool}:${normalizedStatus}:plain`;
  }
  return `${normalizedTool}:${normalizedStatus}`;
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

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function usageBalanceFromWindow(raw: Record<string, unknown>, fieldName: string): CodexUsageBalance {
  const value = raw.used_percent;
  const usedPercent = Number(value);
  if (!Number.isFinite(usedPercent)) throw new Error(`missing ${fieldName}.used_percent`);
  const used = clampPercent(usedPercent);
  const resetAt = Number(raw.reset_at);
  const resetAfter = Number(raw.reset_after_seconds);
  return {
    usedPercent: used,
    remainingPercent: clampPercent(100 - used),
    resetAtEpochSeconds: Number.isFinite(resetAt) ? resetAt : null,
    resetAfterSeconds: Number.isFinite(resetAfter) ? resetAfter : null,
  };
}

function parseOptionalUsageWindow(rateLimit: Record<string, unknown>, keys: string[]): CodexUsageBalance | null {
  for (const key of keys) {
    const raw = rateLimit[key];
    if (!raw || typeof raw !== "object") continue;
    if ((raw as { used_percent?: unknown }).used_percent === undefined) continue;
    return usageBalanceFromWindow(raw as Record<string, unknown>, `rate_limit.${key}`);
  }
  return null;
}

function parseRateLimitResetCredits(data: Record<string, unknown>): number | null {
  const raw = data.rate_limit_reset_credits;
  if (!raw || typeof raw !== "object") return null;
  const availableCount = Number((raw as { available_count?: unknown }).available_count);
  if (!Number.isFinite(availableCount)) return null;
  return Math.max(0, Math.trunc(availableCount));
}

interface CodexAuth {
  accessToken: string;
  accountId?: string;
}

async function getCodexAuth(): Promise<CodexAuth | null> {
  try {
    const raw = await readFile(CODEX_AUTH_FILE, "utf-8");
    const parsed = JSON.parse(raw) as { tokens?: { access_token?: unknown; account_id?: unknown } };
    const token = parsed.tokens?.access_token;
    if (typeof token !== "string" || !token.trim()) return null;
    const accountId = parsed.tokens?.account_id;
    return {
      accessToken: token,
      accountId: typeof accountId === "string" && accountId.trim() ? accountId : undefined,
    };
  } catch {
    return null;
  }
}

async function getCodexAccessToken(): Promise<string | null> {
  return (await getCodexAuth())?.accessToken ?? null;
}

function codexAuthHeaders(auth: CodexAuth): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.accessToken}`,
    "OpenAI-Beta": "codex-1",
    originator: "Codex Desktop",
  };
  if (auth.accountId) headers["ChatGPT-Account-ID"] = auth.accountId;
  return headers;
}

function parseCodexResetCreditDetails(data: Record<string, unknown>): {
  availableCount: number | null;
  availableCredits: CodexRateLimitResetCredit[];
} {
  const availableCount = Number(data.available_count);
  const credits = Array.isArray(data.credits) ? data.credits : [];
  return {
    availableCount: Number.isFinite(availableCount) ? Math.max(0, Math.trunc(availableCount)) : null,
    availableCredits: credits.flatMap((raw) => {
      if (!raw || typeof raw !== "object") return [];
      const credit = raw as { status?: unknown; granted_at?: unknown; expires_at?: unknown };
      if (credit.status !== "available") return [];
      if (typeof credit.expires_at !== "string" || !credit.expires_at.trim()) return [];
      return [{
        grantedAt: typeof credit.granted_at === "string" && credit.granted_at.trim() ? credit.granted_at : null,
        expiresAt: credit.expires_at,
      }];
    }),
  };
}

async function fetchCodexRateLimitResetCredits(auth: CodexAuth): Promise<{
  availableCount: number | null;
  availableCredits: CodexRateLimitResetCredit[];
} | null> {
  try {
    const resp = await fetch(CODEX_RESET_CREDITS_URL, {
      headers: codexAuthHeaders(auth),
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${text.slice(0, 160)}`);
    return parseCodexResetCreditDetails(JSON.parse(text) as Record<string, unknown>);
  } catch (err) {
    console.warn(`[Codex] reset credits lookup failed: ${(err as Error).message}`);
    return null;
  }
}

export async function getCodexUsageSummary(): Promise<CodexUsageSummary> {
  const auth = await getCodexAuth();
  if (!auth) throw new Error("missing ~/.codex/auth.json access token");

  const resetCreditsPromise = fetchCodexRateLimitResetCredits(auth);

  const resp = await fetch(CODEX_USAGE_URL, {
    headers: { Authorization: `Bearer ${auth.accessToken}` },
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${text.slice(0, 160)}`);

  const data = JSON.parse(text) as {
    rate_limit?: Record<string, unknown>;
    rate_limit_reset_credits?: unknown;
  };
  const rateLimit = data.rate_limit;
  if (!rateLimit || typeof rateLimit !== "object") throw new Error("missing rate_limit");

  const fiveHour = parseOptionalUsageWindow(rateLimit, ["primary_window"]);
  if (!fiveHour) throw new Error("missing rate_limit.primary_window.used_percent");
  const resetCredits = await resetCreditsPromise;

  return {
    fiveHour,
    weekly: parseOptionalUsageWindow(rateLimit, [
      "secondary_window",
      "weekly_window",
      "week_window",
      "long_window",
    ]),
    rateLimitResetCreditsAvailable: resetCredits?.availableCount ?? parseRateLimitResetCredits(data),
    rateLimitResetCredits: resetCredits?.availableCredits ?? null,
  };
}

export async function consumeCodexRateLimitResetCredit(redeemRequestId: string): Promise<CodexResetConsumeResult> {
  if (!redeemRequestId.trim()) throw new Error("missing redeem_request_id");
  const token = await getCodexAccessToken();
  if (!token) throw new Error("missing ~/.codex/auth.json access token");

  const resp = await fetch(CODEX_RESET_CONSUME_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ redeem_request_id: redeemRequestId }),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${text.slice(0, 160)}`);

  const data = JSON.parse(text) as { code?: unknown; windows_reset?: unknown };
  const code = data.code;
  if (
    code !== "reset"
    && code !== "nothing_to_reset"
    && code !== "no_credit"
    && code !== "already_redeemed"
  ) {
    throw new Error("missing or unknown reset result code");
  }
  const windowsReset = Number(data.windows_reset);
  return {
    code,
    windowsReset: Number.isFinite(windowsReset) ? Math.max(0, Math.trunc(windowsReset)) : 0,
  };
}

async function resolveCodexAvatarUsage(usageHint?: CodexUsageSummary | null): Promise<CodexUsageSummary | null> {
  if (usageHint !== undefined) {
    if (!usageHint?.weekly) return null;
    return usageHint;
  }

  try {
    const summary = await getCodexUsageSummary();
    if (!summary.weekly) throw new Error("missing weekly usage window");
    return summary;
  } catch (err) {
    console.warn(`[${ts()}] [AVATAR] Codex usage unavailable, using plain avatar: ${(err as Error).message}`);
    return null;
  }
}

function cursorAvatarBatteryPercentFromUsage(summary: CursorUsageSummary): number {
  if (config.cursor.avatarBatteryMode === "onDemandUse") {
    const usedCents = Number(summary.spendLimitUsage?.individualUsed);
    if (!Number.isFinite(usedCents)) throw new Error("missing spendLimitUsage.individualUsed");
    const budget = config.cursor.onDemandMonthlyBudget > 0 ? config.cursor.onDemandMonthlyBudget : 1000;
    return clampPercent(100 - ((usedCents / 100) / budget) * 100);
  }

  const apiPercentUsed = Number(summary.planUsage?.apiPercentUsed);
  if (!Number.isFinite(apiPercentUsed)) throw new Error("missing planUsage.apiPercentUsed");
  return clampPercent(100 - apiPercentUsed);
}

async function resolveCursorAvatarBatteryPercent(usageHint?: CursorUsageSummary | null): Promise<number | null> {
  if (usageHint !== undefined) {
    if (!usageHint) return null;
    try {
      return cursorAvatarBatteryPercentFromUsage(usageHint);
    } catch (err) {
      console.warn(`[${ts()}] [AVATAR] Cursor usage unavailable, using plain avatar: ${(err as Error).message}`);
      return null;
    }
  }

  try {
    return cursorAvatarBatteryPercentFromUsage(await getCursorUsageSummary());
  } catch (err) {
    console.warn(`[${ts()}] [AVATAR] Cursor usage unavailable, using plain avatar: ${(err as Error).message}`);
    return null;
  }
}

function codexUsagePalette(remainingPercent: number): { start: string; end: string; glow: string } {
  if (remainingPercent <= 25) return { start: "#ef4444", end: "#fb923c", glow: "#fed7aa" };
  if (remainingPercent <= 60) return { start: "#eab308", end: "#facc15", glow: "#fef3c7" };
  return { start: "#16a34a", end: "#34d399", glow: "#bbf7d0" };
}

function buildCodexUsageBatterySvg(remainingPercent: number): Buffer {
  const remaining = clampPercent(remainingPercent);
  const label = String(remaining);
  const palette = codexUsagePalette(remaining);

  const bodyX = 28;
  const bodyY = 38;
  const bodyW = 109;
  const bodyH = 56;
  const capW = 12;
  const capH = 22;
  const capX = bodyX + bodyW;
  const capY = bodyY + Math.round((bodyH - capH) / 2);
  const pad = 6;
  const fillMaxW = bodyW - pad * 2;
  const fillWidth = Math.round((fillMaxW * remaining) / 100);
  const labelFontSize = label.length >= 3 ? 49 : 51;

  return Buffer.from(`
<svg width="256" height="256" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <filter id="shadow" x="-35%" y="-35%" width="170%" height="170%">
      <feDropShadow dx="0" dy="4" stdDeviation="4" flood-color="#4a2712" flood-opacity="0.30"/>
    </filter>
    <linearGradient id="fill" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${palette.start}"/>
      <stop offset="1" stop-color="${palette.end}"/>
    </linearGradient>
    <linearGradient id="well" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#334155"/>
      <stop offset="1" stop-color="#111827"/>
    </linearGradient>
    <clipPath id="batteryInnerClip">
      <rect x="${bodyX + pad}" y="${bodyY + pad}" width="${fillMaxW}" height="${bodyH - pad * 2}" rx="10"/>
    </clipPath>
  </defs>
  <g filter="url(#shadow)">
    <rect x="${bodyX}" y="${bodyY}" width="${bodyW}" height="${bodyH}" rx="18" fill="#0f172a"/>
    <rect x="${bodyX + pad}" y="${bodyY + pad}" width="${fillMaxW}" height="${bodyH - pad * 2}" rx="12" fill="url(#well)"/>
    <rect x="${bodyX + pad}" y="${bodyY + pad}" width="${fillWidth}" height="${bodyH - pad * 2}" fill="url(#fill)" clip-path="url(#batteryInnerClip)"/>
    <rect x="${bodyX + pad + 4}" y="${bodyY + pad + 5}" width="${Math.max(0, fillWidth - 8)}" height="8" rx="4" fill="${palette.glow}" fill-opacity="0.42" clip-path="url(#batteryInnerClip)"/>
    <rect x="${capX}" y="${capY}" width="${capW}" height="${capH}" rx="6" fill="#0f172a"/>
    <rect x="${bodyX}" y="${bodyY}" width="${bodyW}" height="${bodyH}" rx="18" fill="none" stroke="#f8fafc" stroke-opacity="0.82" stroke-width="3.8"/>
    <text x="${bodyX + bodyW / 2}" y="${bodyY + bodyH / 2 + 3}" text-anchor="middle" dominant-baseline="middle" alignment-baseline="middle" font-family="Arial, Helvetica, sans-serif" font-size="${labelFontSize}" font-weight="600" letter-spacing="0" stroke="#0b1220" stroke-width="4.6" paint-order="stroke" stroke-linejoin="round" fill="#ffffff">${label}</text>
  </g>
</svg>`);
}

function buildCodexUsageRingSvg(remainingPercent: number): Buffer {
  const remaining = clampPercent(remainingPercent);
  const palette = codexUsagePalette(remaining);
  const cx = 128;
  const cy = 128;
  const r = 118;
  const strokeWidth = 16;
  const used = clampPercent(100 - remaining);
  const polar = (angleDegrees: number) => {
    const angle = (angleDegrees * Math.PI) / 180;
    return {
      x: cx + r * Math.cos(angle),
      y: cy + r * Math.sin(angle),
    };
  };
  const startAngle = -90 + (used / 100) * 360;
  const sweepAngle = (remaining / 100) * 360;
  const start = polar(startAngle);
  const end = polar(startAngle + Math.min(sweepAngle, 359.99));
  const largeArcFlag = sweepAngle > 180 ? 1 : 0;
  const progressPath = remaining >= 100
    ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="url(#ring)" stroke-width="${strokeWidth}" stroke-linecap="round" filter="url(#ringShadow)"/>`
    : remaining <= 0
      ? ""
      : `<path d="M ${start.x.toFixed(3)} ${start.y.toFixed(3)} A ${r} ${r} 0 ${largeArcFlag} 1 ${end.x.toFixed(3)} ${end.y.toFixed(3)}" fill="none" stroke="url(#ring)" stroke-width="${strokeWidth}" stroke-linecap="round" filter="url(#ringShadow)"/>`;

  return Buffer.from(`
<svg width="256" height="256" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="ring" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${palette.start}"/>
      <stop offset="1" stop-color="${palette.end}"/>
    </linearGradient>
    <filter id="ringShadow" x="-22%" y="-22%" width="144%" height="144%">
      <feDropShadow dx="0" dy="0" stdDeviation="5.2" flood-color="#0f172a" flood-opacity="0.78"/>
      <feDropShadow dx="0" dy="3" stdDeviation="2.8" flood-color="#0f172a" flood-opacity="0.45"/>
    </filter>
  </defs>
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#94a3b8" stroke-width="${strokeWidth}"/>
  ${progressPath}
</svg>`);
}

async function buildAgentBadgeOverlay(tool: string): Promise<sharp.OverlayOptions> {
  const badge = await sharp(AVATAR_BADGES[tool])
    .resize(AVATAR_BADGE_SIZE, AVATAR_BADGE_SIZE, {
      fit: "contain",
      kernel: sharp.kernel.lanczos3,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
  return {
    input: badge,
    left: AVATAR_SIZE - AVATAR_BADGE_SIZE - AVATAR_BADGE_MARGIN,
    top: AVATAR_SIZE - AVATAR_BADGE_SIZE - AVATAR_BADGE_MARGIN,
  };
}

async function renderAvatar(
  tool: string,
  status: string,
  codexUsage: CodexUsageSummary | null = null,
  cursorBatteryPercent: number | null = null,
): Promise<{ buffer: Buffer; contentType: string; filename: string }> {
  const normalizedTool = normalizeAvatarTool(tool);
  const normalizedStatus = normalizeAvatarStatus(status);
  const composites: sharp.OverlayOptions[] = [];

  const codexWeeklyUsage = normalizedTool === "codex" ? codexUsage?.weekly : null;
  const useDynamicCodexAvatar = codexUsage && codexWeeklyUsage;
  const useDynamicCursorAvatar = normalizedTool === "cursor" && cursorBatteryPercent !== null;
  const basePath = useDynamicCodexAvatar || useDynamicCursorAvatar
    ? AVATAR_SOURCES[normalizedStatus]
    : avatarCombinationPath(normalizedTool, normalizedStatus);

  if (useDynamicCodexAvatar) {
    composites.push(
      { input: buildCodexUsageRingSvg(codexUsage.fiveHour.remainingPercent), left: 0, top: 0 },
      { input: buildCodexUsageBatterySvg(codexWeeklyUsage.remainingPercent), left: 0, top: 0 },
      await buildAgentBadgeOverlay(normalizedTool),
    );
  } else if (useDynamicCursorAvatar) {
    composites.push(
      { input: buildCodexUsageBatterySvg(cursorBatteryPercent), left: 0, top: 0 },
      await buildAgentBadgeOverlay(normalizedTool),
    );
  }

  let pipeline = sharp(await readFile(basePath))
    .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: "cover", position: "center" });
  if (composites.length > 0) {
    pipeline = pipeline.composite(composites);
  }

  const jpeg = await pipeline
    .flatten({ background: "#ffffff" })
    .removeAlpha()
    .jpeg({ quality: 95, progressive: false })
    .toBuffer();

  return {
    buffer: jpeg,
    contentType: "image/jpeg",
    filename: codexUsage?.weekly
      ? `avatar_${normalizedTool}_${normalizedStatus}_week_${codexUsage.weekly.remainingPercent}_5h_${codexUsage.fiveHour.remainingPercent}.jpg`
      : cursorBatteryPercent !== null
        ? `avatar_${normalizedTool}_${normalizedStatus}_battery_${cursorBatteryPercent}.jpg`
      : `avatar_${normalizedTool}_${normalizedStatus}.jpg`,
  };
}

async function uploadImage(
  token: string,
  tool: string,
  status: string,
  codexUsage: CodexUsageSummary | null = null,
  cursorBatteryPercent: number | null = null,
): Promise<string> {
  const image = await renderAvatar(tool, status, codexUsage, cursorBatteryPercent);
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

async function getOrUploadAvatarKey(
  token: string,
  tool: string,
  status: string,
  usageHints: ChatAvatarUsageHints = {},
): Promise<string> {
  await loadAvatarKeyCache();
  const normalizedTool = normalizeAvatarTool(tool);
  const normalizedStatus = normalizeAvatarStatus(status);
  const codexUsage = normalizedTool === "codex" ? await resolveCodexAvatarUsage(usageHints.codexUsage) : null;
  const cursorBatteryPercent = normalizedTool === "cursor"
    ? await resolveCursorAvatarBatteryPercent(usageHints.cursorUsage)
    : null;
  const keyName = avatarCacheKey(normalizedTool, normalizedStatus, codexUsage, cursorBatteryPercent);
  const cached = avatarKeyCache.get(keyName);
  if (cached) return cached;
  const key = await uploadImage(token, normalizedTool, normalizedStatus, codexUsage, cursorBatteryPercent);
  avatarKeyCache.set(keyName, key);
  await persistAvatarKeyCache().catch((err) => {
    console.error(`[${ts()}] [AVATAR] persist cache FAIL: ${(err as Error).message}`);
  });
  console.log(`[${ts()}] [AVATAR] Uploaded "${keyName}" → image_key=${key}`);
  return key;
}

export async function setChatAvatar(
  token: string,
  chatId: string,
  tool: string,
  status: string,
  usageHints: ChatAvatarUsageHints = {},
): Promise<void> {
  try {
    const avatarKey = await getOrUploadAvatarKey(token, tool, status, usageHints);
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
  const timeoutMs = 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
      signal: controller.signal,
    });
    const respText = await resp.text();
    let data: { code: number; msg?: string; data?: { message_id?: string } };
    try {
      data = JSON.parse(respText);
    } catch {
      console.error(`[${ts()}] [SEND] text FAIL: chatId=${chatId} invalid JSON status=${resp.status}`);
      return false;
    }
    if (data.code !== 0) {
      console.error(`[${ts()}] [SEND] text FAIL: chatId=${chatId} code=${data.code} msg="${data.msg ?? ""}"`);
      return false;
    }
    console.log(`[${ts()}] [SEND] text OK: chatId=${chatId} msgId=${data.data?.message_id ?? "N/A"}`);
    return true;
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      console.error(`[${ts()}] [SEND] text TIMEOUT after ${timeoutMs}ms: chatId=${chatId}`);
      return false;
    }
    console.error(`[${ts()}] [SEND] text FAIL: chatId=${chatId} ${(err as Error).message}`);
    return false;
  } finally {
    clearTimeout(timer);
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
    const resp = await fetch(`${BASE_URL}/im/v1/messages?receive_id_type=chat_id`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: "file",
        content: JSON.stringify({ file_key: fileKey }),
      }),
    });
    const data = (await resp.json().catch(() => ({}))) as { code?: number; msg?: string; data?: { message_id?: string } };
    if (data.code !== 0) {
      console.error(`[${ts()}] [SEND] file FAIL: chatId=${chatId} path=${filePath} code=${data.code} msg="${data.msg ?? ""}"`);
      throw new Error(`[${data.code}] ${data.msg ?? "send file failed"}`);
    }
    console.log(`[${ts()}] [SEND] file OK: chatId=${chatId} name=${fileName} msgId=${data.data?.message_id ?? "N/A"}`);
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

// ---------------------------------------------------------------------------
// 合并转发消息
// ---------------------------------------------------------------------------

/**
 * 获取合并转发消息中的子消息列表。
 *
 * 对合并转发消息调用 GET /im/v1/messages/{messageId} 时，
 * 返回 data.items[] 扁平的子消息列表，通过 upper_message_id 构建层级。
 * 第一个 item（无 upper_message_id）是合并转发消息自身。
 *
 * 权限要求: im:message:read
 */
export async function getMergeForwardMessages(
  token: string,
  messageId: string,
): Promise<FeishuMessageItem[]> {
  const resp = await fetch(`${BASE_URL}/im/v1/messages/${messageId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = (await resp.json()) as {
    code: number;
    msg?: string;
    data?: { items?: FeishuMessageItem[] };
  };
  if (json.code !== 0) {
    throw new Error(`getMergeForwardMessages [${json.code}] ${json.msg ?? ""}`);
  }
  return json.data?.items ?? [];
}
