// =============================================================================
// web-ui.ts — Setup Wizard & Management Dashboard HTTP Server
// =============================================================================
// Serves on the same port as the WebSocket relay (18080 default).
// - Setup mode: no config.json → show setup wizard, skip Feishu connection
// - Dashboard mode: config.json exists → serve management page alongside WS relay
// =============================================================================

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile, writeFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn, execSync } from "node:child_process";
import { CHATCCC_PACKAGE_ROOT } from "./package-root.ts";
import { resolveChatCccRuntimeSpawnSpec } from "./runtime-entry.ts";
import { handleAgentTeamRequest } from "./agent-team/http/board-routes.ts";
import { AGENT_TEAM_PAGE_HTML } from "./agent-team/web/agent-team-page.ts";
export { AGENT_TEAM_PAGE_HTML } from "./agent-team/web/agent-team-page.ts";
import {
  buildWebUiUrl,
  createInternalRestartEnv,
  openWebUiInDefaultBrowser,
} from "./startup-lifecycle.ts";
import { engineManager } from "./engines/engine-specs.ts";
import { isSafeMaintenanceAdmissionClosed } from "./safe-maintenance.ts";

const PROJECT_ROOT = CHATCCC_PACKAGE_ROOT;
const USER_DATA_DIR = join(homedir(), ".chatccc");
const CONFIG_FILE = join(USER_DATA_DIR, "config.json");
const CONFIG_SAMPLE_FILE = join(PROJECT_ROOT, "config.sample.json");
const PID_FILE = join(USER_DATA_DIR, "state", "runtime.pid");
const ILINK_AUTH_PATH = join(USER_DATA_DIR, "state", "ilink-auth.json");

// ---------------------------------------------------------------------------
// Helpers — config.json parsing & generation
// ---------------------------------------------------------------------------

interface AppConfig {
  feishu?: { appId?: string; appSecret?: string };
  platforms?: {
    feishu?: { enabled?: boolean; platformType?: string };
    ilink?: { enabled?: boolean; reuseTokenOnStart?: boolean };
  };
  webUi?: { openOnStart?: boolean };
  chromeDevtools?: { enabled?: boolean; port?: number; chromePath?: string };
  port?: number;
  gitTimeoutSeconds?: number;
  claude?: { enabled?: boolean; defaultAgent?: boolean; model?: string; subagentModel?: string; effort?: string; apiKey?: string; baseUrl?: string; maxTurn?: number };
  // `command` 是已废弃的旧字段名，保留只读以兼容升级前的 config.json
  cursor?: {
    enabled?: boolean;
    defaultAgent?: boolean;
    path?: string;
    command?: string;
    model?: string;
    alternativeModel?: string;
    avatarBatteryMode?: string;
    onDemandMonthlyBudget?: number;
  };
  codex?: { enabled?: boolean; defaultAgent?: boolean; path?: string; command?: string; model?: string; alternativeModel?: string; effort?: string; fastMode?: boolean };
  ccc?: {
    enabled?: boolean;
    defaultAgent?: boolean;
    DEEPSEEK_API_KEY?: string;
    DEEPSEEK_BASE_URL?: string;
    model?: string;
    alternativeModel?: string;
    effort?: string;
    maxOutputTokens?: number | null;
    /** 留空（""）= 不 override，跟随 DeepCCC 内核配置（~/.deepccc/config.json 或 DEEPCCC_PROVIDER） */
    provider?: "" | "openai" | "anthropic";
    gitCoAuthor?: boolean | null;
  };
  dsh?: { enabled?: boolean; defaultAgent?: boolean; apiKey?: string; baseUrl?: string; model?: string; provider?: string; maxTokens?: number };
}

// ---------------------------------------------------------------------------
// /api/start 路径选择（纯函数，便于单测护栏）
// ---------------------------------------------------------------------------
//
// 三种语义：
//   - "inplace" : setup 模式，原地启动飞书 service（同进程，不动 PID 文件）
//   - "spawn"   : dashboard 模式 + service 未运行，spawn 子进程（旧 service 退出后场景）
//   - "reload"  : dashboard 模式 + service 已经在跑（通常就是当前进程自己）→
//                 仅调用 reloadConfigFromDisk() 刷新 export let 常量，**不真正重启**。
//                 用户的设计意图："让新 config 生效就行，不用走 spawn+exit 的真重启"。
//
// 关键契约：只要 setup 模式注册了 onActivate 回调，无条件走 inplace —— 因为
// setup 进程**总是**占着 PID 文件、isServiceRunning() 永远为 true，再判 PID
// 会陷入"自己挡自己"的死循环（用户点保存并启动只会得到 already running）。
//
// 历史：曾经在 service 已运行时返回 "reject-already-running"，但 dashboard 的
// UI 本身就在跑着的进程内，service 必然在跑——重新跑向导改完配置点"保存并启动"
// 100% 会撞到这条 reject 路径，造成"自己挡自己"的死循环。改 reload 后即可
// 让常量热更新（API 来源、模型、effort、CLI 路径等下次创建会话即生效）。
// 已建立的飞书 WSClient 仍持有旧 APP_ID/APP_SECRET 句柄——如改了飞书凭证，
// 仍需重启 chatccc 进程才能让 WS 长连接换 token；但这是用户少见路径，文档说明即可。

export type StartPath = "inplace" | "spawn" | "reload";

export function chooseStartPath(input: {
  hasInplaceActivateHook: boolean;
  isServiceRunning: boolean;
}): StartPath {
  if (input.hasInplaceActivateHook) return "inplace";
  if (input.isServiceRunning) return "reload";
  return "spawn";
}

/** 读取 cursor / codex 的 CLI 路径，优先新字段 path，回退旧字段 command */
function readToolPath(tool?: { path?: string; command?: string }): string {
  if (!tool) return "";
  if (tool.path && tool.path.trim()) return tool.path;
  if (tool.command && tool.command.trim()) return tool.command;
  return "";
}

function loadConfig(): AppConfig {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    let raw = readFileSync(CONFIG_FILE, "utf8");
    // 移除可能意外写入的 UTF-8 BOM，避免 JSON.parse 失败导致返回空对象、
    // UI 显示所有配置为空。
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveConfig(cfg: AppConfig): void {
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf8");
}

type ConfigApplyMode = "saved" | "reload" | "restart-required";

interface ConfigApplyResult {
  mode: ConfigApplyMode;
  restartRequired: boolean;
  restartReasons: string[];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function portValue(cfg: AppConfig): number {
  return Number.isInteger(cfg.port) && cfg.port! >= 1 && cfg.port! <= 65535 ? cfg.port! : 18080;
}

function platformEnabled(cfg: AppConfig, platform: "feishu" | "ilink"): boolean {
  return cfg.platforms?.[platform]?.enabled !== false;
}

function feishuPlatformType(cfg: AppConfig): string {
  return cfg.platforms?.feishu?.platformType === "lark" ? "lark" : "feishu";
}

function ilinkReuseTokenOnStart(cfg: AppConfig): boolean {
  return cfg.platforms?.ilink?.reuseTokenOnStart !== false;
}

export function getRestartRequiredReasons(before: AppConfig, after: AppConfig): string[] {
  const reasons: string[] = [];

  if (portValue(before) !== portValue(after)) reasons.push("port");
  if (stringValue(before.feishu?.appId) !== stringValue(after.feishu?.appId)) reasons.push("feishu.appId");
  if (stringValue(before.feishu?.appSecret) !== stringValue(after.feishu?.appSecret)) reasons.push("feishu.appSecret");
  if (feishuPlatformType(before) !== feishuPlatformType(after)) reasons.push("platforms.feishu.platformType");
  if (platformEnabled(before, "feishu") !== platformEnabled(after, "feishu")) reasons.push("platforms.feishu.enabled");
  if (platformEnabled(before, "ilink") !== platformEnabled(after, "ilink")) reasons.push("platforms.ilink.enabled");
  if (ilinkReuseTokenOnStart(before) !== ilinkReuseTokenOnStart(after)) {
    reasons.push("platforms.ilink.reuseTokenOnStart");
  }

  return reasons;
}

async function applySavedConfigIfPossible(before: AppConfig, after: AppConfig): Promise<ConfigApplyResult> {
  const setupMode = Boolean(setupActivateHook && setupHttpServer);
  if (setupMode) {
    return { mode: "saved", restartRequired: false, restartReasons: [] };
  }

  const running = isServiceRunning();
  if (!running) {
    return { mode: "saved", restartRequired: false, restartReasons: [] };
  }

  const restartReasons = getRestartRequiredReasons(before, after);
  if (restartReasons.length > 0) {
    return { mode: "restart-required", restartRequired: true, restartReasons };
  }
  if (!reloadConfigHook) {
    return { mode: "saved", restartRequired: false, restartReasons: [] };
  }

  await reloadConfigHook();
  return { mode: "reload", restartRequired: false, restartReasons: [] };
}

function maskSecret(value: string | undefined): string {
  if (!value) return "(未设置)";
  if (value.length <= 8) return "***";
  return value.slice(0, 4) + "***" + value.slice(-4);
}

// ---------------------------------------------------------------------------
// Helpers — process management
// ---------------------------------------------------------------------------

function isServiceRunning(): boolean {
  if (!existsSync(PID_FILE)) return false;
  try {
    const raw = readFileSync(PID_FILE, "utf8").trim();
    const pid = parseInt(raw, 10);
    if (isNaN(pid)) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getServicePid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  try {
    const pid = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

function getServiceUptime(): number | null {
  try {
    const s = statSync(PID_FILE);
    return Math.floor((Date.now() - s.mtimeMs) / 1000);
  } catch {
    return null;
  }
}

import { statSync } from "node:fs";

function spawnService(): { ok: boolean; pid?: number; error?: string } {
  const spec = resolveChatCccRuntimeSpawnSpec(PROJECT_ROOT);
  if (!existsSync(spec.args[0])) return { ok: false, error: `Entry not found: ${spec.args[0]}` };
  try {
    const child = spawn(spec.command, spec.args, {
      cwd: PROJECT_ROOT,
      detached: true,
      stdio: "ignore",
      shell: false,
      env: createInternalRestartEnv(),
    });
    child.unref();
    return { ok: true, pid: child.pid ?? undefined };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * 安排一次真正的进程重启：先回复 HTTP 请求，再 spawn 一个延迟启动的子进程，
 * 然后退出当前进程。延迟是为了让当前进程完全退出并释放端口。
 */
function scheduleRestart(): void {
  const spec = resolveChatCccRuntimeSpawnSpec(PROJECT_ROOT);
  if (!existsSync(spec.args[0])) return;
  const delayedLauncher = [
    "const { spawn } = require('node:child_process');",
    `const command = ${JSON.stringify(spec.command)};`,
    `const args = ${JSON.stringify(spec.args)};`,
    `const cwd = ${JSON.stringify(PROJECT_ROOT)};`,
    "setTimeout(() => {",
    "  const child = spawn(command, args, { cwd, detached: true, stdio: 'ignore', shell: false, env: process.env });",
    "  child.unref();",
    "}, 2000);",
  ].join("\n");
  if (process.platform === "win32") {
    // Windows keeps the helper window hidden; the helper itself provides the delay.
    spawn(process.execPath, ["-e", delayedLauncher], {
      cwd: PROJECT_ROOT,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: createInternalRestartEnv(),
    }).unref();
  } else {
    spawn(process.execPath, ["-e", delayedLauncher], {
      cwd: PROJECT_ROOT,
      detached: true,
      stdio: "ignore",
      env: createInternalRestartEnv(),
    }).unref();
  }
}

function stopService(): { ok: boolean; error?: string } {
  const pid = getServicePid();
  if (!pid) return { ok: false, error: "No PID file found" };
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /PID ${pid} /F /T`, { stdio: "pipe", windowsHide: true });
    } else {
      process.kill(pid, "SIGTERM");
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

function validateCli(tool: string): { ok: boolean; path?: string; error?: string } {
  const cfg = loadConfig();
  let cmd: string;
  if (tool === "cursor") {
    cmd = readToolPath(cfg.cursor) || detectCursorAgentPath();
  } else {
    cmd = readToolPath(cfg.codex) || "codex";
  }
  try {
    const out = execSync(`"${cmd}" --version`, { encoding: "utf8", timeout: 10000, windowsHide: true }).trim();
    return { ok: true, path: cmd, error: out.slice(0, 200) };
  } catch (err) {
    return { ok: false, path: cmd, error: (err as Error).message };
  }
}

function detectCursorAgentPath(): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const defaultPath = join(localAppData, "cursor-agent", "agent.cmd");
    if (existsSync(defaultPath)) return defaultPath;
  }
  return "agent";
}

// ---------------------------------------------------------------------------
// Helpers — HTTP
// ---------------------------------------------------------------------------

function jsonReply(res: ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => resolve(body));
  });
}

// ---------------------------------------------------------------------------
// API route handlers
// ---------------------------------------------------------------------------

async function handleApiCheck(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const hasConfig = existsSync(CONFIG_FILE);
  let hasCreds = false;
  if (hasConfig) {
    const c = loadConfig();
    const feishuEnabled = c.platforms?.feishu?.enabled !== false; // 默认 true（向后兼容）
    const feishuOk = feishuEnabled && Boolean(c.feishu?.appId?.trim() && c.feishu?.appSecret?.trim());
    hasCreds = feishuOk || !feishuEnabled;
  }
  jsonReply(res, 200, { hasConfig, hasCreds, configPath: CONFIG_FILE });
}

async function handleGetConfig(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const running = isServiceRunning();
  const pid = getServicePid();
  const vars = loadConfig();
  let ilinkAuthExists = false;
  if (existsSync(ILINK_AUTH_PATH)) {
    try {
      const auth = JSON.parse(readFileSync(ILINK_AUTH_PATH, "utf8"));
      ilinkAuthExists = Boolean(auth.token);
    } catch { /* ignore parse errors */ }
  }
  jsonReply(res, 200, { vars, running, pid, ilinkAuthExists });
}

async function handlePostConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readRequestBody(req);
  let updates: Record<string, unknown>;
  try {
    const parsed = JSON.parse(body);
    updates = parsed.vars ?? {};
  } catch {
    jsonReply(res, 400, { ok: false, error: "Invalid JSON" });
    return;
  }
  const existing = loadConfig();
  // AppConfig 是闭合接口（无 index signature），但运行时本质就是 JSON 对象，
  // 这里通过 unknown 桥接到 Record 让 deepMerge 能复用；写回前断言回 AppConfig。
  const merged = deepMerge(
    existing as unknown as Record<string, unknown>,
    unflattenConfig(updates),
  ) as AppConfig;
  try {
    saveConfig(merged);
    const applyResult = await applySavedConfigIfPossible(existing, merged);
    jsonReply(res, 200, { ok: true, ...applyResult });
  } catch (err) {
    jsonReply(res, 500, { ok: false, saved: true, error: (err as Error).message });
  }
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const [key, val] of Object.entries(source)) {
    if (val !== null && typeof val === "object" && !Array.isArray(val) && typeof result[key] === "object" && result[key] !== null && !Array.isArray(result[key])) {
      result[key] = deepMerge(result[key] as Record<string, unknown>, val as Record<string, unknown>);
    } else {
      result[key] = val;
    }
  }
  return result;
}

// Convert flat key-value pairs to nested config structure
export function unflattenConfig(flat: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(flat)) {
    if (key === "CHATCCC_APP_ID") {
      result.feishu = result.feishu || {};
      (result.feishu as Record<string, unknown>).appId = val;
    } else if (key === "CHATCCC_APP_SECRET") {
      result.feishu = result.feishu || {};
      (result.feishu as Record<string, unknown>).appSecret = val;
    } else if (key === "CHATCCC_FEISHU_ENABLED") {
      result.platforms = result.platforms || {};
      (result.platforms as Record<string, unknown>).feishu = (result.platforms as Record<string, unknown>).feishu || {};
      ((result.platforms as Record<string, unknown>).feishu as Record<string, unknown>).enabled = val === true || val === "true";
    } else if (key === "CHATCCC_FEISHU_PLATFORM_TYPE") {
      result.platforms = result.platforms || {};
      (result.platforms as Record<string, unknown>).feishu = (result.platforms as Record<string, unknown>).feishu || {};
      ((result.platforms as Record<string, unknown>).feishu as Record<string, unknown>).platformType = val;
    } else if (key === "CHATCCC_ILINK_ENABLED") {
      result.platforms = result.platforms || {};
      (result.platforms as Record<string, unknown>).ilink = (result.platforms as Record<string, unknown>).ilink || {};
      ((result.platforms as Record<string, unknown>).ilink as Record<string, unknown>).enabled = val === true || val === "true";
    } else if (key === "CHATCCC_WEB_UI_OPEN_ON_START") {
      result.webUi = result.webUi || {};
      (result.webUi as Record<string, unknown>).openOnStart = val === true || val === "true";
    } else if (key === "CHATCCC_CHROME_DEVTOOLS_ENABLED") {
      result.chromeDevtools = result.chromeDevtools || {};
      (result.chromeDevtools as Record<string, unknown>).enabled = val === true || val === "true";
    } else if (key === "CHATCCC_CHROME_DEVTOOLS_PORT") {
      result.chromeDevtools = result.chromeDevtools || {};
      (result.chromeDevtools as Record<string, unknown>).port = parseInt(val as string, 10) || 15166;
    } else if (key === "CHATCCC_CHROME_DEVTOOLS_PATH") {
      result.chromeDevtools = result.chromeDevtools || {};
      (result.chromeDevtools as Record<string, unknown>).chromePath = val;
    } else if (key === "CHATCCC_PORT") {
      result.port = parseInt(val as string, 10) || 18080;
    } else if (key === "CHATCCC_GIT_TIMEOUT_SECONDS") {
      result.gitTimeoutSeconds = parseInt(val as string, 10) || 180;
    } else if (key === "CHATCCC_ANTHROPIC_MODEL") {
      result.claude = result.claude || {};
      (result.claude as Record<string, unknown>).model = val;
    } else if (key === "CHATCCC_ANTHROPIC_SUBAGENT_MODEL") {
      result.claude = result.claude || {};
      (result.claude as Record<string, unknown>).subagentModel = val;
    } else if (key === "CHATCCC_ANTHROPIC_EFFORT") {
      result.claude = result.claude || {};
      (result.claude as Record<string, unknown>).effort = val;
    } else if (key === "CHATCCC_ANTHROPIC_API_KEY") {
      result.claude = result.claude || {};
      (result.claude as Record<string, unknown>).apiKey = val;
    } else if (key === "CHATCCC_ANTHROPIC_BASE_URL") {
      result.claude = result.claude || {};
      (result.claude as Record<string, unknown>).baseUrl = val;
    } else if (key === "CHATCCC_ANTHROPIC_MAX_TURN") {
      result.claude = result.claude || {};
      (result.claude as Record<string, unknown>).maxTurn = (function(v){ var n = parseInt(v, 10); return isNaN(n) ? 0 : n; })(val as string);
    } else if (key === "CHATCCC_CLAUDE_ENABLED") {
      result.claude = result.claude || {};
      (result.claude as Record<string, unknown>).enabled = val === true || val === "true";
    } else if (key === "CHATCCC_CLAUDE_DEFAULT_AGENT") {
      result.claude = result.claude || {};
      (result.claude as Record<string, unknown>).defaultAgent = val === true || val === "true";
    } else if (key === "CHATCCC_CURSOR_PATH") {
      result.cursor = result.cursor || {};
      (result.cursor as Record<string, unknown>).path = val;
    } else if (key === "CHATCCC_CURSOR_MODEL") {
      result.cursor = result.cursor || {};
      (result.cursor as Record<string, unknown>).model = val;
    } else if (key === "CHATCCC_CURSOR_ALTERNATIVE_MODEL") {
      result.cursor = result.cursor || {};
      (result.cursor as Record<string, unknown>).alternativeModel = val;
    } else if (key === "CHATCCC_CURSOR_AVATAR_BATTERY_MODE") {
      result.cursor = result.cursor || {};
      (result.cursor as Record<string, unknown>).avatarBatteryMode = val;
    } else if (key === "CHATCCC_CURSOR_ON_DEMAND_MONTHLY_BUDGET") {
      result.cursor = result.cursor || {};
      (result.cursor as Record<string, unknown>).onDemandMonthlyBudget = Number(val);
    } else if (key === "CHATCCC_CURSOR_ENABLED") {
      result.cursor = result.cursor || {};
      (result.cursor as Record<string, unknown>).enabled = val === true || val === "true";
    } else if (key === "CHATCCC_CURSOR_DEFAULT_AGENT") {
      result.cursor = result.cursor || {};
      (result.cursor as Record<string, unknown>).defaultAgent = val === true || val === "true";
    } else if (key === "CHATCCC_CODEX_PATH") {
      result.codex = result.codex || {};
      (result.codex as Record<string, unknown>).path = val;
    } else if (key === "CHATCCC_CODEX_MODEL") {
      result.codex = result.codex || {};
      (result.codex as Record<string, unknown>).model = val;
    } else if (key === "CHATCCC_CODEX_ALTERNATIVE_MODEL") {
      result.codex = result.codex || {};
      (result.codex as Record<string, unknown>).alternativeModel = val;
    } else if (key === "CHATCCC_CODEX_EFFORT") {
      result.codex = result.codex || {};
      (result.codex as Record<string, unknown>).effort = val;
    } else if (key === "CHATCCC_CODEX_FAST_MODE") {
      result.codex = result.codex || {};
      (result.codex as Record<string, unknown>).fastMode = val === true || val === "true";
    } else if (key === "CHATCCC_CODEX_ENABLED") {
      result.codex = result.codex || {};
      (result.codex as Record<string, unknown>).enabled = val === true || val === "true";
    } else if (key === "CHATCCC_CODEX_DEFAULT_AGENT") {
      result.codex = result.codex || {};
      (result.codex as Record<string, unknown>).defaultAgent = val === true || val === "true";
    } else if (key === "CHATCCC_CCC_API_KEY") {
      result.ccc = result.ccc || {};
      (result.ccc as Record<string, unknown>).DEEPSEEK_API_KEY = val;
    } else if (key === "CHATCCC_CCC_BASE_URL") {
      result.ccc = result.ccc || {};
      (result.ccc as Record<string, unknown>).DEEPSEEK_BASE_URL = val;
    } else if (key === "CHATCCC_CCC_MODEL") {
      result.ccc = result.ccc || {};
      (result.ccc as Record<string, unknown>).model = val;
    } else if (key === "CHATCCC_CCC_SUB_MODEL") {
      result.ccc = result.ccc || {};
      (result.ccc as Record<string, unknown>).subModel = val;
    } else if (key === "CHATCCC_CCC_ALTERNATIVE_MODEL") {
      result.ccc = result.ccc || {};
      (result.ccc as Record<string, unknown>).alternativeModel = val;
    } else if (key === "CHATCCC_CCC_EFFORT") {
      result.ccc = result.ccc || {};
      (result.ccc as Record<string, unknown>).effort = val;
    } else if (key === "CHATCCC_CCC_MAX_OUTPUT_TOKENS") {
      result.ccc = result.ccc || {};
      const raw = String(val ?? "").trim();
      const parsed = Number(raw);
      (result.ccc as Record<string, unknown>).maxOutputTokens = raw && Number.isInteger(parsed) && parsed > 0
        ? parsed
        : null;
    } else if (key === "CHATCCC_CCC_PROVIDER") {
      result.ccc = result.ccc || {};
      (result.ccc as Record<string, unknown>).provider = val;
    } else if (key === "CHATCCC_CCC_GIT_COAUTHOR") {
      result.ccc = result.ccc || {};
      (result.ccc as Record<string, unknown>).gitCoAuthor = val === "inherit" ? null : val === "enabled";
    } else if (key === "CHATCCC_CCC_CONTEXT_WINDOW") {
      result.ccc = result.ccc || {};
      (result.ccc as Record<string, unknown>).contextWindow = parseInt(String(val), 10) || 1048576;
    } else if (key === "CHATCCC_CCC_ENABLED") {
      result.ccc = result.ccc || {};
      (result.ccc as Record<string, unknown>).enabled = val === true || val === "true";
    } else if (key === "CHATCCC_CCC_DEFAULT_AGENT") {
      result.ccc = result.ccc || {};
      (result.ccc as Record<string, unknown>).defaultAgent = val === true || val === "true";
    } else if (key === "CHATCCC_DSH_API_KEY") {
      result.dsh = result.dsh || {};
      (result.dsh as Record<string, unknown>).apiKey = val;
    } else if (key === "CHATCCC_DSH_BASE_URL") {
      result.dsh = result.dsh || {};
      (result.dsh as Record<string, unknown>).baseUrl = val;
    } else if (key === "CHATCCC_DSH_MODEL") {
      result.dsh = result.dsh || {};
      (result.dsh as Record<string, unknown>).model = val;
    } else if (key === "CHATCCC_DSH_SUB_MODEL") {
      result.dsh = result.dsh || {};
      (result.dsh as Record<string, unknown>).subModel = val;
    } else if (key === "CHATCCC_DSH_ALTERNATIVE_MODEL") {
      result.dsh = result.dsh || {};
      (result.dsh as Record<string, unknown>).alternativeModel = val;
    } else if (key === "CHATCCC_DSH_PROVIDER") {
      result.dsh = result.dsh || {};
      (result.dsh as Record<string, unknown>).provider = val;
    } else if (key === "CHATCCC_DSH_MAX_TOKENS") {
      result.dsh = result.dsh || {};
      (result.dsh as Record<string, unknown>).maxTokens = parseInt(String(val), 10) || 49152;
    } else if (key === "CHATCCC_DSH_ENABLED") {
      result.dsh = result.dsh || {};
      (result.dsh as Record<string, unknown>).enabled = val === true || val === "true";
    } else if (key === "CHATCCC_DSH_DEFAULT_AGENT") {
      result.dsh = result.dsh || {};
      (result.dsh as Record<string, unknown>).defaultAgent = val === true || val === "true";
    }
  }
  return result;
}

async function handleGetStatus(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const running = isServiceRunning();
  const pid = getServicePid();
  const uptime = running ? getServiceUptime() : null;
  jsonReply(res, 200, { running, pid, uptime });
}

async function handleStartService(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = chooseStartPath({
    hasInplaceActivateHook: Boolean(setupActivateHook && setupHttpServer),
    isServiceRunning: isServiceRunning(),
  });

  if (path === "inplace") {
    // setup 模式：原地启动飞书 service，复用 setup HTTP server，不动 PID 文件。
    // 注意 hook 和 setupHttpServer 在 chooseStartPath() 之后**绝不会被并发清空**
    // —— init 时一次性赋值，且当前函数是 onActivate 唯一调用点；非 null 断言安全。
    const hook = setupActivateHook!;
    const server = setupHttpServer!;
    const result = await hook(server);
    if (result.ok) {
      // 切换成功：清掉 hook 防止再次走 inplace 路径（service 已经在跑了）。
      // setupHttpServer 不清 —— 它已经接管为 service server，dashboard 仍要用。
      setupActivateHook = null;
      jsonReply(res, 200, { ok: true, pid: process.pid, mode: "inplace" });
    } else {
      jsonReply(res, 500, { ok: false, error: result.error });
    }
    return;
  }

  if (path === "reload") {
    // service 已经在跑：只刷新进程内配置，让后续消息/新会话使用新值。
    if (!reloadConfigHook) {
      jsonReply(res, 200, { ok: true, pid: process.pid, mode: "saved" });
      return;
    }
    try {
      await reloadConfigHook();
      jsonReply(res, 200, { ok: true, pid: process.pid, mode: "reload" });
    } catch (err) {
      jsonReply(res, 500, { ok: false, error: (err as Error).message });
    }
    return;
  }

  const result = spawnService();
  if (result.ok) {
    await new Promise((r) => setTimeout(r, 1000));
    jsonReply(res, 200, { ok: true, pid: result.pid, mode: "spawn" });
  } else {
    jsonReply(res, 500, result);
  }
}

async function handleStopService(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const running = isServiceRunning();
  if (!running) {
    jsonReply(res, 200, { ok: false, error: "Service is not running" });
    return;
  }
  jsonReply(res, 200, { ok: true });
  setImmediate(() => {
    stopService();
  });
}

async function handleRestartService(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  jsonReply(res, 200, { ok: true, message: "Restarting..." });
  scheduleRestart();
  process.exit(0);
}

async function handleValidate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readRequestBody(req);
  let tool: string;
  try { tool = JSON.parse(body).tool; } catch {
    jsonReply(res, 400, { ok: false, error: "Missing tool" });
    return;
  }
  const result = validateCli(tool);
  jsonReply(res, 200, result);
}

async function handleForgetIlink(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    if (existsSync(ILINK_AUTH_PATH)) {
      unlinkSync(ILINK_AUTH_PATH);
    }
    jsonReply(res, 200, { ok: true });
  } catch (err) {
    jsonReply(res, 500, { ok: false, error: (err as Error).message });
  }
}

async function handleEngineStatus(engineId: string, res: ServerResponse): Promise<void> {
  try {
    jsonReply(res, 200, { ok: true, ...(await engineManager.getStatus(engineId)) });
  } catch (err) {
    jsonReply(res, (err as Error).message.startsWith("Unknown engine:") ? 404 : 500, { ok: false, error: (err as Error).message });
  }
}

async function handleEngineInstall(engineId: string, res: ServerResponse): Promise<void> {
  if (isSafeMaintenanceAdmissionClosed()) {
    jsonReply(res, 409, { ok: false, error: "ChatCCC 正在等待安全维护，暂不接受新的依赖安装任务。" });
    return;
  }
  try {
    jsonReply(res, 202, { ok: true, job: await engineManager.startInstall(engineId) });
  } catch (err) {
    jsonReply(res, (err as Error).message.startsWith("Unknown engine:") ? 404 : 500, { ok: false, error: (err as Error).message });
  }
}

// ---------------------------------------------------------------------------
// HTML page (embedded template)
// ---------------------------------------------------------------------------

export const PAGE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ChatCCC</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f1f5f9;color:#1e293b;line-height:1.6}
header{background:#0f172a;color:#fff;padding:16px 24px;display:flex;align-items:center;justify-content:space-between}
header h1{font-size:20px;font-weight:600}
header .badge{font-size:13px;padding:4px 12px;border-radius:12px;font-weight:500}
.header-actions{display:flex;align-items:center;gap:12px}
.agent-team-entry,.deepccc-web-entry{display:inline-flex;align-items:center;gap:8px;padding:9px 16px;border:1px solid rgba(255,255,255,.2);border-radius:999px;background:linear-gradient(135deg,#6366f1,#8b5cf6 55%,#d946ef);color:#fff;text-decoration:none;font-size:14px;font-weight:700;letter-spacing:.01em;box-shadow:0 8px 24px rgba(99,102,241,.38);transition:transform .18s ease,box-shadow .18s ease,filter .18s ease}
.deepccc-web-entry{background:linear-gradient(135deg,#171a23,#413a76);box-shadow:0 8px 24px rgba(42,38,78,.38)}
.agent-team-entry:hover,.deepccc-web-entry:hover{transform:translateY(-2px);box-shadow:0 12px 30px rgba(139,92,246,.52);filter:saturate(1.16)}
.agent-team-entry:focus-visible{outline:3px solid rgba(196,181,253,.65);outline-offset:3px}
.agent-team-entry .agent-team-icon{font-size:16px;line-height:1}
.badge-running{background:#16a34a;color:#fff}
.badge-stopped{background:#94a3b8;color:#fff}
/* container 完全不限宽、不留左右内边距 —— step-2 是三列卡片需要尽量利用屏幕；
   单列内容（step-1/3、steps-bar、dashboard-view 子元素）由下面 720 规则收口居中。 */
.container{margin:0 auto;padding:24px 0}
.card{background:#fff;border-radius:12px;padding:24px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
/* 单列内容（飞书表单 / 确认 / dashboard 卡片 / 进度条）保留 720 居中，不受 container 加宽影响 */
#step-1,#step-3,#steps-bar,#step-label-bar,#dashboard-view > *{max-width:720px;margin-left:auto;margin-right:auto}
.card h2{font-size:18px;font-weight:600;margin-bottom:12px}
.card h3{font-size:15px;font-weight:600;margin-bottom:8px;color:#334155}
.form-group{margin-bottom:16px}
.form-group label{display:block;font-size:14px;font-weight:500;margin-bottom:4px;color:#475569}
/* 只针对文本/下拉这类输入控件加边框 + focus 高亮；radio/checkbox 保留浏览器默认渲染，
   否则 box-shadow:0 0 0 3px 会在 radio 的矩形包围盒外画出一个蓝色矩形框，看上去像另一个输入控件。 */
.form-group input:not([type=radio]):not([type=checkbox]),.form-group select{width:100%;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;outline:none;transition:border-color .15s}
.form-group input:not([type=radio]):not([type=checkbox]):focus,.form-group select:focus{border-color:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,.15)}
.form-group .hint{font-size:12px;color:#94a3b8;margin-top:2px}
.btn{display:inline-flex;align-items:center;gap:6px;padding:8px 20px;border:none;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer;transition:all .15s}
.btn-primary{background:#3b82f6;color:#fff}
.btn-primary:hover{background:#2563eb}
.btn-outline{background:#fff;color:#475569;border:1px solid #cbd5e1}
.btn-outline:hover{background:#f1f5f9}
.btn-danger{background:#ef4444;color:#fff}
.btn-danger:hover{background:#dc2626}
.btn-success{background:#16a34a;color:#fff}
.btn-success:hover{background:#15803d}
.btn:disabled{opacity:.5;cursor:not-allowed}
.engine-status{font-size:13px;color:#64748b;margin-bottom:8px}
.engine-steps{display:grid;gap:5px;margin:8px 0 10px}
.engine-step{display:grid;grid-template-columns:18px 1fr auto;gap:7px;align-items:center;padding:5px 7px;border-radius:7px;background:#f8fafc;font-size:12px;color:#64748b}
.engine-step.running{background:#eff6ff;color:#1d4ed8}.engine-step.completed{color:#15803d}.engine-step.failed{background:#fef2f2;color:#dc2626}
.engine-step-icon{font-weight:700;text-align:center}.engine-step-percent{font-variant-numeric:tabular-nums;color:inherit}
.btn-group{display:flex;gap:8px;flex-wrap:wrap}
.agent-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:16px}
.agent-card{min-width:0}
.agent-card{border:2px solid #e2e8f0;border-radius:12px;padding:16px;background:#fff;display:flex;flex-direction:column;transition:border-color .15s,background .15s}
.agent-card.enabled{border-color:#3b82f6;background:#eff6ff}
.agent-card-header{display:flex;align-items:flex-start;gap:10px;margin-bottom:12px}
.agent-card-header .meta{flex:1;min-width:0}
.agent-card-header .name{font-size:15px;font-weight:600;margin-bottom:2px}
.agent-card-header .desc{font-size:12px;color:#64748b;line-height:1.4}
.agent-toggle{appearance:none;-webkit-appearance:none;width:38px;height:22px;background:#cbd5e1;border-radius:11px;position:relative;cursor:pointer;flex-shrink:0;transition:background .2s;outline:none;border:none;margin:0}
.agent-toggle:checked{background:#3b82f6}
.agent-toggle::before{content:"";position:absolute;width:18px;height:18px;border-radius:50%;background:#fff;top:2px;left:2px;transition:left .2s;box-shadow:0 1px 2px rgba(0,0,0,.2)}
.agent-toggle:checked::before{left:18px}
.agent-default-row{display:flex;align-items:center;gap:8px;font-size:13px;color:#334155;margin:-4px 0 12px}
.agent-default-row input{margin:0}
.agent-body{flex:1}
.agent-body fieldset{border:none;padding:0;margin:0}
.agent-body fieldset[disabled]{opacity:.45;pointer-events:none}
.steps{display:flex;gap:4px;margin-bottom:8px}
.step{flex:1;height:4px;background:#e2e8f0;border-radius:2px;transition:background .2s}
.step.active{background:#3b82f6}
.step.done{background:#93c5fd}
.step-label-bar{text-align:right;font-size:13px;color:#64748b;margin-bottom:16px;font-weight:500}
.status-bar{display:flex;align-items:center;gap:12px;padding:16px 20px;background:#fff;border-radius:12px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.status-dot{width:10px;height:10px;border-radius:50%}
.status-dot.running{background:#16a34a;box-shadow:0 0 6px rgba(22,163,74,.4)}
.status-dot.stopped{background:#94a3b8}
.config-row{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #f1f5f9}
.config-row:last-child{border-bottom:none}
.config-row .key{font-size:13px;font-weight:500;color:#64748b}
.config-row .val{font-size:14px;color:#1e293b;text-align:right}
.config-section{margin-bottom:8px}
.config-section summary{font-weight:600;font-size:15px;cursor:pointer;padding:8px 0;color:#334155}
.section-detail{padding:8px 0 16px 8px}
.hidden{display:none !important}
.toast{position:fixed;top:16px;right:16px;padding:12px 20px;border-radius:8px;color:#fff;font-size:14px;font-weight:500;z-index:100;animation:slideIn .3s ease}
.toast-success{background:#16a34a}
.toast-error{background:#ef4444}
@keyframes slideIn{from{transform:translateX(100%);opacity:0}to{transform:translateX(0);opacity:1}}
.spinner{display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .6s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@media(max-width:520px){header{padding:12px 14px}.header-actions{gap:8px}.agent-team-entry,.deepccc-web-entry{padding:8px 11px;font-size:13px}header .badge{padding:4px 8px}.deepccc-web-entry span:last-child{display:none}}
</style>
</head>
<body>
<header>
  <h1>ChatCCC</h1>
  <div class="header-actions">
    <button type="button" class="deepccc-web-entry" onclick="openDeepCccWeb()"><span aria-hidden="true">D</span><span>DeepCCC Web</span></button>
    <a href="/agent-team" class="agent-team-entry"><span class="agent-team-icon" aria-hidden="true">✦</span>Agent Team <span aria-hidden="true">→</span></a>
    <span id="header-badge" class="badge badge-stopped">未启动</span>
  </div>
</header>
<div class="container">

  <!-- ===== Setup Wizard ===== -->
  <div id="wizard-view">
    <div class="steps" id="steps-bar">
      <div class="step active" data-step="1"></div>
      <div class="step" data-step="2"></div>
      <div class="step" data-step="3"></div>
    </div>
    <div class="step-label-bar" id="step-label-bar">第 1 步 / 共 3 步</div>

    <!-- Step 1: 平台配置 -->
    <div id="step-1" class="card">
      <h2>平台配置</h2>
      <p style="color:#64748b;font-size:14px;margin-bottom:16px">选择要启用的 IM 平台，至少开启一个。平台关闭时不需填写对应凭证。</p>

      <!-- 飞书 -->
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px;margin-bottom:12px" id="platform-block-feishu">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <div>
            <div style="font-weight:600;font-size:14px">飞书</div>
            <div style="font-size:12px;color:#64748b">通过飞书自建应用收发消息、管理群聊</div>
          </div>
          <input type="checkbox" class="agent-toggle" id="platform-enable-feishu" checked onchange="onWizardPlatformToggle('feishu', this.checked)">
        </div>
        <div id="feishu-cred-fields" style="margin-top:12px;padding-top:12px;border-top:1px solid #e2e8f0">
          <div class="form-group" style="margin-bottom:10px">
            <label>平台类型</label>
            <select id="field-CHATCCC_FEISHU_PLATFORM_TYPE" style="width:100%;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;outline:none">
              <option value="feishu">飞书 (open.feishu.cn)</option>
              <option value="lark">Lark (open.larksuite.com)</option>
            </select>
            <div class="hint">飞书或 Lark 国际版，决定 API 服务器地址</div>
          </div>
          <div class="form-group" style="margin-bottom:10px">
            <label>CHATCCC_APP_ID *</label>
            <input type="text" id="field-CHATCCC_APP_ID" placeholder="cli_xxxxxxxxxxxx">
            <div class="hint">飞书开放平台「凭证与基础信息」→ App ID</div>
          </div>
          <div class="form-group">
            <label>CHATCCC_APP_SECRET *</label>
            <input type="password" id="field-CHATCCC_APP_SECRET" placeholder="...">
            <div class="hint">飞书开放平台「凭证与基础信息」→ App Secret</div>
          </div>
        </div>
      </div>

      <!-- 微信 iLink -->
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px;margin-bottom:12px" id="platform-block-ilink">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <div>
            <div style="font-weight:600;font-size:14px">微信 iLink</div>
            <div style="font-size:12px;color:#64748b">启动后扫码登录，通过微信收发消息（仅支持私聊）</div>
          </div>
          <input type="checkbox" class="agent-toggle" id="platform-enable-ilink" checked onchange="onWizardPlatformToggle('ilink', this.checked)">
        </div>
      </div>

      <!-- Web UI 启动行为 -->
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px;margin-bottom:12px" id="web-ui-startup-block">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:16px">
          <div>
            <div style="font-weight:600;font-size:14px">启动时打开 Web UI</div>
            <div style="font-size:12px;color:#64748b">直接运行 ChatCCC 时用系统默认浏览器打开管理页面；内部重启始终不打开</div>
          </div>
          <input type="checkbox" class="agent-toggle" id="field-CHATCCC_WEB_UI_OPEN_ON_START" checked>
        </div>
      </div>

      <!-- Chrome CDP -->
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px;margin-bottom:12px" id="chrome-devtools-block">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <div>
            <div style="font-weight:600;font-size:14px">常驻 Chrome CDP（选填）</div>
            <div style="font-size:12px;color:#64748b">维护本机 Chrome DevTools Protocol 端口，用于 ChatGPT 订阅到期查询</div>
          </div>
          <input type="checkbox" class="agent-toggle" id="field-CHATCCC_CHROME_DEVTOOLS_ENABLED" onchange="toggleWizardChromeDevtoolsFields(this.checked)">
        </div>
        <div id="chrome-devtools-settings" style="margin-top:12px;padding-top:12px;border-top:1px solid #e2e8f0">
          <div class="hint" style="margin-bottom:10px;line-height:1.6">
            依赖：本机已安装 Google Chrome；查询 ChatGPT 订阅到期时间时，需要在这个 CDP 专用 Chrome 窗口中登录 ChatGPT。
          </div>
          <div class="form-group" style="margin-bottom:10px">
            <label>CDP 端口</label>
            <input type="number" id="field-CHATCCC_CHROME_DEVTOOLS_PORT" min="1" max="65535" step="1" placeholder="15166">
            <div class="hint">默认 15166；健康检查端点：http://127.0.0.1:15166/json/version</div>
          </div>
          <div class="form-group">
            <label>Chrome 路径（选填）</label>
            <input type="text" id="field-CHATCCC_CHROME_DEVTOOLS_PATH" placeholder="留空自动探测 chrome.exe">
            <div class="hint">选填；留空时自动探测 Google Chrome。</div>
          </div>
        </div>
      </div>

      <div class="btn-group" style="justify-content:flex-end">
        <button class="btn btn-primary" id="btn-step1-next" onclick="goStep1Next()">下一步</button>
      </div>
    </div>

    <!-- Step 2: 启用 AI Agent 并配置 -->
    <div id="step-2" class="card hidden">
      <h2>启用 AI Agent</h2>
      <p style="color:#64748b;font-size:14px;margin-bottom:16px">在飞书中可同时启用多个 AI 编程工具。打开对应卡片的开关后填写配置，至少需要启用一个并填写正确才能进入下一步。</p>

      <div class="agent-cards">

        <!-- CCC Agent 卡片（置顶：ChatCCC 内置 Agent，开箱即用） -->
        <div class="agent-card" id="agent-card-ccc">
          <div class="agent-card-header">
            <input type="checkbox" class="agent-toggle" id="agent-enable-ccc" onchange="onAgentToggle('ccc', this.checked)">
            <div class="meta">
              <div class="name">CCC Agent</div>
              <div class="desc">ChatCCC 内置 Agent<br>OpenAI 兼容 API（不限于 DeepSeek）</div>
            </div>
          </div>
          <label class="agent-default-row">
            <input type="checkbox" id="agent-default-ccc" onchange="onDefaultAgentToggle('ccc', this.checked)">
            设为默认 Agent
          </label>
          <fieldset class="agent-body" id="agent-body-ccc" disabled>
            <div class="form-group">
              <label>API Key</label>
              <input type="password" id="field-CHATCCC_CCC_API_KEY" placeholder="OpenAI 兼容 API Key（如 DeepSeek）">
            </div>
            <div class="form-group">
              <label>Base URL</label>
              <input type="text" id="field-CHATCCC_CCC_BASE_URL" placeholder="https://api.deepseek.com/v1（可填任意 OpenAI 兼容端点）">
            </div>
            <div class="form-group">
              <label>模型</label>
              <input type="text" id="field-CHATCCC_CCC_MODEL" placeholder="deepseek-v4-pro">
            </div>
            <div class="form-group">
              <label>子模型（选填）</label>
              <input type="text" id="field-CHATCCC_CCC_SUB_MODEL" placeholder="留空跟随主模型；用于压缩摘要、子代理任务等轻量环节">
            </div>
            <div class="form-group">
              <label>备选模型（选填）</label>
              <input type="text" id="field-CHATCCC_CCC_ALTERNATIVE_MODEL" placeholder="加入 /model 列表，便于会话内切换">
            </div>
            <div class="form-group">
              <label>API 协议（选填）</label>
              <select id="field-CHATCCC_CCC_PROVIDER">
                <option value="">跟随 DeepCCC 内核配置（默认）</option>
                <option value="openai">openai - OpenAI 兼容协议</option>
                <option value="anthropic">anthropic - Anthropic Messages 协议</option>
              </select>
              <div class="hint">与 Base URL 强相关：OpenAI 兼容端点选 openai；Anthropic Messages 端点选 anthropic。留空时使用 ~/.deepccc/config.json 或 DEEPCCC_PROVIDER 的值。</div>
            </div>
            <div class="form-group">
              <label>Git 提交共同作者</label>
              <select id="field-CHATCCC_CCC_GIT_COAUTHOR">
                <option value="inherit">跟随 DeepCCC 全局设置（默认开启）</option>
                <option value="enabled">强制开启</option>
                <option value="disabled">强制关闭</option>
              </select>
              <div class="hint">开启时追加 DeepCCC 共同作者，不替换你的 Git Author。</div>
            </div>
            <div class="form-group">
              <label>Effort（推理强度，选填）</label>
              <select id="field-CHATCCC_CCC_EFFORT">
                <option value="">跟随 DeepCCC 内核配置（默认）</option>
                <option value="none">none - 直接作答，最省 token</option>
                <option value="minimal">minimal</option>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
                <option value="xhigh">xhigh</option>
                <option value="max">max - 最强推理</option>
              </select>
              <div class="hint">留空时读取 ~/.deepccc/config.json 或 DEEPCCC_EFFORT；DeepCCC 也留空时使用模型服务端默认值。</div>
            </div>
            <div class="form-group">
              <label>最大输出 Token（选填）</label>
              <input type="number" id="field-CHATCCC_CCC_MAX_OUTPUT_TOKENS" min="1" step="1" placeholder="留空跟随 DeepCCC 内核配置">
              <div class="hint">限制主对话单次输出长度。留空时读取 ~/.deepccc/config.json 或 DEEPCCC_MAX_OUTPUT_TOKENS；DeepCCC 也未配置时使用模型服务端默认值。</div>
            </div>
            <div class="form-group">
              <label>上下文窗口（模型最大上下文）</label>
              <select id="field-CHATCCC_CCC_CONTEXT_WINDOW" onchange="onContextWindowPresetChange('field-', this.value)">
                <option value="1m">1M（1,048,576 tokens，推荐）</option>
                <option value="512k">512K（524,288 tokens）</option>
                <option value="256k">256K（262,144 tokens）</option>
                <option value="128k">128K（131,072 tokens）</option>
                <option value="custom">自定义（单位 k）</option>
              </select>
              <div id="field-CHATCCC_CCC_CONTEXT_WINDOW_CUSTOM_ROW" style="margin-top:6px;display:none">
                <input type="number" id="field-CHATCCC_CCC_CONTEXT_WINDOW_CUSTOM" min="1" placeholder="例如 768 表示 768K（786,432 tokens）" style="width:100%;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;outline:none">
              </div>
              <div class="hint">压缩阈值自动 = 窗口 × 80%（超出即把较早消息压缩为摘要）。⚠️ 超过模型/服务端实际上限时请求会被 API 直接拒绝（context length exceeded）；实际窗口以模型与所用服务端为准（如 litellm 代理的 max_input_tokens）。</div>
            </div>
          </fieldset>
        </div>

        <!-- DeepSeek Harness 卡片 -->
        <div class="agent-card" id="agent-card-dsh">
          <div class="agent-card-header">
            <input type="checkbox" class="agent-toggle" id="agent-enable-dsh" onchange="onInstallableAgentToggle('dsh', this)">
            <div class="meta">
              <div class="name">DeepSeek Harness</div>
              <div class="desc">DeepSeek 官方 Agent Harness<br>按需安装，独立于 CCC Agent</div>
            </div>
          </div>
          <label class="agent-default-row">
            <input type="checkbox" id="agent-default-dsh" onchange="onDefaultAgentToggle('dsh', this.checked)">
            设为默认 Agent
          </label>
          <fieldset class="agent-body" id="agent-body-dsh" disabled>
            <div class="form-group"><label>API Key</label><input type="password" id="field-CHATCCC_DSH_API_KEY" placeholder="DeepSeek API Key"></div>
            <div class="form-group"><label>Base URL</label><input type="text" id="field-CHATCCC_DSH_BASE_URL" placeholder="https://api.deepseek.com/v1"></div>
            <div class="form-group"><label>模型</label><input type="text" id="field-CHATCCC_DSH_MODEL" placeholder="deepseek-v4-flash"></div>
            <div class="form-group"><label>子模型（选填）</label><input type="text" id="field-CHATCCC_DSH_SUB_MODEL" placeholder="留空跟随主模型；用于 subagent 子代理任务"></div>
            <div class="form-group"><label>备选模型（选填）</label><input type="text" id="field-CHATCCC_DSH_ALTERNATIVE_MODEL" placeholder="加入 /model 列表，便于会话内切换"></div>
            <div class="form-group"><label>Provider 路由</label><input type="text" id="field-CHATCCC_DSH_PROVIDER" placeholder="deepseek-official"></div>
            <div class="form-group"><label>单次最大输出 Tokens</label><input type="number" id="field-CHATCCC_DSH_MAX_TOKENS" min="1" placeholder="49152"></div>
            <div class="form-group" style="border-top:1px solid #e2e8f0;padding-top:12px;margin-top:4px">
              <label>DeepSeek Harness 引擎</label>
              <div id="dsh-engine-status" class="engine-status">检测中...</div>
              <div id="dsh-engine-steps" class="engine-steps"></div>
              <button type="button" class="btn btn-outline" id="dsh-engine-install-btn" onclick="installEngine('dsh')">安装并启用</button>
              <div class="hint" style="margin-top:6px">一次点击自动完成环境检查、下载、校验、Runtime 握手和原子切换；页面刷新后仍可恢复进度。</div>
            </div>
          </fieldset>
        </div>

        <!-- Claude 卡片 -->
        <div class="agent-card" id="agent-card-claude">
          <div class="agent-card-header">
            <input type="checkbox" class="agent-toggle" id="agent-enable-claude" onchange="onInstallableAgentToggle('claude', this)">
            <div class="meta">
              <div class="name">Claude Code</div>
              <div class="desc">Anthropic Claude Code CLI<br>模型、effort 均为选填</div>
            </div>
          </div>
          <label class="agent-default-row">
            <input type="checkbox" id="agent-default-claude" onchange="onDefaultAgentToggle('claude', this.checked)">
            设为默认 Agent
          </label>
          <fieldset class="agent-body" id="agent-body-claude" disabled>
            <div class="form-group">
              <label>模型（选填）</label>
              <input type="text" id="field-CHATCCC_ANTHROPIC_MODEL" placeholder="留空使用默认模型">
            </div>
            <div class="form-group">
              <label>Subagent 模型（选填）</label>
              <input type="text" id="field-CHATCCC_ANTHROPIC_SUBAGENT_MODEL" placeholder="留空使用默认 subagent 模型">
            </div>
            <div class="form-group">
              <label>思考深度 Effort（选填）</label>
              <input type="text" id="field-CHATCCC_ANTHROPIC_EFFORT" placeholder="留空使用默认值">
            </div>
            <div class="form-group">
              <label>API Key（选填）</label>
              <input type="password" id="field-CHATCCC_ANTHROPIC_API_KEY" placeholder="留空使用 Claude Code 默认认证">
            </div>
            <div class="form-group">
              <label>Base URL（选填）</label>
              <input type="text" id="field-CHATCCC_ANTHROPIC_BASE_URL" placeholder="留空使用默认端点">
            </div>
            <div class="form-group" style="border-top:1px solid #e2e8f0;padding-top:12px;margin-top:4px">
              <label>Claude Code 引擎（Agent SDK）</label>
              <div id="claude-engine-status" class="engine-status">检测中...</div>
              <div id="claude-engine-steps" class="engine-steps"></div>
              <button type="button" class="btn btn-outline" id="claude-engine-install-btn" onclick="installEngine('claude')">安装并启用</button>
              <div class="hint" style="margin-top:6px">ChatCCC 通过 Claude Agent SDK 调用 Claude Code；SDK 引擎按需下载到本机（仅启用 Claude Code 时需要），安装期间请保持网络畅通。</div>
            </div>
          </fieldset>
        </div>

        <!-- Cursor 卡片 -->
        <div class="agent-card" id="agent-card-cursor">
          <div class="agent-card-header">
            <input type="checkbox" class="agent-toggle" id="agent-enable-cursor" onchange="onAgentToggle('cursor', this.checked)">
            <div class="meta">
              <div class="name">Cursor</div>
              <div class="desc">Cursor Agent CLI<br>需安装 Cursor</div>
            </div>
          </div>
          <label class="agent-default-row">
            <input type="checkbox" id="agent-default-cursor" onchange="onDefaultAgentToggle('cursor', this.checked)">
            设为默认 Agent
          </label>
          <fieldset class="agent-body" id="agent-body-cursor" disabled>
            <div class="form-group">
              <label>CLI 路径</label>
              <input type="text" id="field-CHATCCC_CURSOR_PATH" placeholder="自动探测...">
              <div class="hint" id="cursor-path-hint"></div>
            </div>
            <div class="form-group">
              <label>模型</label>
              <input type="text" id="field-CHATCCC_CURSOR_MODEL" placeholder="留空表示不传 --model">
            </div>
            <div class="form-group">
              <label>备选模型（选填）</label>
              <input type="text" id="field-CHATCCC_CURSOR_ALTERNATIVE_MODEL" placeholder="加入 /model 列表，便于会话内切换">
            </div>
            <div class="form-group">
              <label>头像电池电量</label>
              <select id="field-CHATCCC_CURSOR_AVATAR_BATTERY_MODE" onchange="onCursorBatteryModeChange('field-', this.value)" style="width:100%;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;outline:none">
                <option value="apiPercent">API 使用比例</option>
                <option value="onDemandUse">On demand use 金额</option>
              </select>
            </div>
            <div class="form-group" id="field-cursor-on-demand-budget-row" style="display:none">
              <label>每月On demand use预算</label>
              <input type="number" id="field-CHATCCC_CURSOR_ON_DEMAND_MONTHLY_BUDGET" min="1" step="1" placeholder="1000">
            </div>
            <button class="btn btn-outline" onclick="validateCli('cursor')" style="margin-bottom:12px">检测 Cursor CLI</button>
            <div id="cursor-validate-result"></div>
          </fieldset>
        </div>

        <!-- Codex 卡片 -->
        <div class="agent-card" id="agent-card-codex">
          <div class="agent-card-header">
            <input type="checkbox" class="agent-toggle" id="agent-enable-codex" onchange="onAgentToggle('codex', this.checked)">
            <div class="meta">
              <div class="name">Codex</div>
              <div class="desc">OpenAI Codex CLI<br>需安装并登录</div>
            </div>
          </div>
          <label class="agent-default-row">
            <input type="checkbox" id="agent-default-codex" onchange="onDefaultAgentToggle('codex', this.checked)">
            设为默认 Agent
          </label>
          <fieldset class="agent-body" id="agent-body-codex" disabled>
            <div class="form-group">
              <label>CLI 路径</label>
              <input type="text" id="field-CHATCCC_CODEX_PATH" placeholder="codex">
            </div>
            <div class="form-group">
              <label>模型</label>
              <input type="text" id="field-CHATCCC_CODEX_MODEL" placeholder="留空由 codex config.toml 决定">
            </div>
            <div class="form-group">
              <label>备选模型（选填）</label>
              <input type="text" id="field-CHATCCC_CODEX_ALTERNATIVE_MODEL" placeholder="加入 /model 列表，便于会话内切换">
            </div>
            <div class="form-group">
              <label>努力程度 (Effort)</label>
              <input type="text" id="field-CHATCCC_CODEX_EFFORT" placeholder="留空由 codex config.toml 决定">
            </div>
            <div class="form-group">
              <label style="display:flex;align-items:center;gap:8px">
                <input type="checkbox" id="field-CHATCCC_CODEX_FAST_MODE"> Fast 模式
              </label>
            </div>
            <button class="btn btn-outline" onclick="validateCli('codex')" style="margin-bottom:12px">检测 Codex CLI</button>
            <div id="codex-validate-result"></div>
          </fieldset>
        </div>

      </div>

      <div class="btn-group" style="justify-content:space-between">
        <button class="btn btn-outline" onclick="goStep(1)">返回</button>
        <button class="btn btn-primary" id="btn-step2-next" disabled onclick="goStep(3)">下一步</button>
      </div>
    </div>

    <!-- Step 3: Review -->
    <div id="step-3" class="card hidden">
      <h2>确认配置</h2>
      <div id="review-content"></div>
      <div class="btn-group" style="justify-content:space-between;margin-top:16px">
        <button class="btn btn-outline" onclick="goStep(2)">返回修改</button>
        <button class="btn btn-success" id="btn-save-start" onclick="saveAndStart()">保存并启动</button>
      </div>
    </div>
  </div>

  <!-- ===== Dashboard ===== -->
  <div id="dashboard-view" class="hidden">
    <div class="status-bar" id="status-bar">
      <div class="status-dot stopped" id="status-dot"></div>
      <div style="flex:1">
        <div style="font-weight:600" id="status-text">服务未启动</div>
        <div style="font-size:13px;color:#64748b" id="status-detail"></div>
      </div>
      <div class="btn-group">
        <button class="btn btn-danger" id="btn-stop" onclick="stopService()">停止</button>
        <button class="btn btn-outline" id="btn-restart" onclick="restartService()">重启</button>
      </div>
    </div>

    <details class="card config-section">
      <summary>飞书</summary>
      <div class="section-detail">
        <div class="config-row">
          <span class="key">状态</span>
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
            <input type="checkbox" class="agent-toggle" id="dash-platform-feishu" onchange="onPlatformToggle('feishu', this.checked)">
            <span id="dash-platform-feishu-label">已启用</span>
          </label>
        </div>
        <div class="config-row"><span class="key">App ID</span><span class="val" id="cfg-APP_ID">-</span></div>
        <div class="config-row"><span class="key">App Secret</span><span class="val" id="cfg-APP_SECRET">-</span></div>
        <div class="config-row"><span class="key">平台类型</span><span class="val" id="cfg-FEISHU_PLATFORM_TYPE">-</span></div>
        <div class="hint" style="margin-top:6px;line-height:1.6">生效范围：飞书开关、App ID、App Secret 或平台类型变更需要重启 ChatCCC。</div>
        <button class="btn btn-outline" style="margin-top:8px" onclick="editSection('feishu')">编辑</button>
      </div>
    </details>

    <details class="card config-section">
      <summary>微信 iLink</summary>
      <div class="section-detail">
        <div class="config-row">
          <span class="key">状态</span>
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
            <input type="checkbox" class="agent-toggle" id="dash-platform-ilink" onchange="onPlatformToggle('ilink', this.checked)">
            <span id="dash-platform-ilink-label">未启用</span>
          </label>
        </div>
        <div id="ilink-forget-row" style="margin-top:6px;display:none">
          <button class="btn btn-outline" style="font-size:12px" onclick="forgetIlink()">忘记扫码</button>
          <span style="font-size:11px;color:#94a3b8;margin-left:8px">清除登录状态，重启后重新扫码</span>
        </div>
        <div class="hint" style="margin-top:6px;line-height:1.6">生效范围：微信 iLink 开关变更需要重启 ChatCCC。</div>
      </div>
    </details>

    <details class="card config-section">
      <summary>Web UI</summary>
      <div class="section-detail">
        <div class="config-row"><span class="key">直接启动时自动打开</span><span class="val" id="cfg-WEB_UI_OPEN_ON_START">-</span></div>
        <div class="hint" style="margin-top:6px;line-height:1.6">生效范围：下次直接启动生效；内部重启始终不打开。Linux 无图形桌面时会跳过打开并输出 SSH 隧道提示。</div>
        <button class="btn btn-outline" style="margin-top:8px" onclick="editSection('webUi')">编辑</button>
      </div>
    </details>

    <details class="card config-section">
      <summary>Chrome CDP（选填）</summary>
      <div class="section-detail">
        <div class="config-row"><span class="key">状态</span><span class="val" id="cfg-CHROME_DEVTOOLS_ENABLED">-</span></div>
        <div class="config-row" id="cfg-CHROME_DEVTOOLS_PORT_ROW"><span class="key">CDP 端口</span><span class="val" id="cfg-CHROME_DEVTOOLS_PORT">-</span></div>
        <div class="config-row" id="cfg-CHROME_DEVTOOLS_PATH_ROW"><span class="key">Chrome 路径</span><span class="val" id="cfg-CHROME_DEVTOOLS_PATH">-</span></div>
        <div class="hint" style="margin-top:6px;line-height:1.6">生效范围：保存后立即应用到 Chrome CDP 守护进程。依赖：本机 Google Chrome；ChatGPT 订阅到期查询需要在该 CDP Chrome 中登录 ChatGPT。</div>
        <button class="btn btn-outline" style="margin-top:8px" onclick="editSection('chromeDevtools')">编辑</button>
      </div>
    </details>

    <details class="card config-section" id="dash-claude">
      <summary>Claude Agent</summary>
      <div class="section-detail">
        <div class="config-row"><span class="key">模型</span><span class="val" id="cfg-ANTHROPIC_MODEL">-</span></div>
        <div class="config-row"><span class="key">Subagent 模型</span><span class="val" id="cfg-ANTHROPIC_SUBAGENT_MODEL">-</span></div>
        <div class="config-row"><span class="key">Effort</span><span class="val" id="cfg-ANTHROPIC_EFFORT">-</span></div>
        <div class="config-row"><span class="key">API Key</span><span class="val" id="cfg-ANTHROPIC_API_KEY">-</span></div>
        <div class="config-row"><span class="key">Base URL</span><span class="val" id="cfg-ANTHROPIC_BASE_URL">-</span></div>
        <div class="config-row"><span class="key">Max Turns</span><span class="val" id="cfg-ANTHROPIC_MAX_TURN">-</span><span class="hint">(0=无限制)</span></div>
        <label class="agent-default-row" style="margin-top:10px"><input type="checkbox" id="dash-default-claude" onchange="setDashboardDefaultAgent('claude', this.checked)"> 设为默认 Agent</label>
        <div class="hint" style="margin-top:6px;line-height:1.6">生效范围：保存后下一条消息或下个新会话生效，当前生成不中断。</div>
        <button class="btn btn-outline" style="margin-top:8px" onclick="editSection('claude')">编辑</button>
      </div>
    </details>

    <details class="card config-section" id="dash-dsh">
      <summary>DeepSeek Harness</summary>
      <div class="section-detail">
        <div class="config-row"><span class="key">API Key</span><span class="val" id="cfg-DSH_API_KEY">-</span></div>
        <div class="config-row"><span class="key">Base URL</span><span class="val" id="cfg-DSH_BASE_URL">-</span></div>
        <div class="config-row"><span class="key">模型</span><span class="val" id="cfg-DSH_MODEL">-</span></div>
        <div class="config-row"><span class="key">子模型</span><span class="val" id="cfg-DSH_SUB_MODEL">-</span></div>
        <div class="config-row"><span class="key">备选模型</span><span class="val" id="cfg-DSH_ALTERNATIVE_MODEL">-</span></div>
        <div class="config-row"><span class="key">Provider</span><span class="val" id="cfg-DSH_PROVIDER">-</span></div>
        <div class="config-row"><span class="key">最大输出 Tokens</span><span class="val" id="cfg-DSH_MAX_TOKENS">-</span></div>
        <div id="dsh-dashboard-engine-status" class="engine-status">检测中...</div>
        <div id="dsh-dashboard-engine-steps" class="engine-steps"></div>
        <button type="button" class="btn btn-outline" id="dsh-dashboard-engine-install-btn" onclick="installEngine('dsh')">安装或升级引擎</button>
        <label class="agent-default-row" style="margin-top:10px"><input type="checkbox" id="dash-default-dsh" onchange="setDashboardDefaultAgent('dsh', this.checked)"> 设为默认 Agent</label>
        <div class="hint" style="margin-top:6px;line-height:1.6">安装过程不调用付费模型；保存后下一条消息或下个新会话生效。</div>
        <button class="btn btn-outline" style="margin-top:8px" onclick="editSection('dsh')">编辑</button>
      </div>
    </details>

    <details class="card config-section" id="dash-cursor">
      <summary>Cursor Agent</summary>
      <div class="section-detail">
        <div class="config-row"><span class="key">CLI 路径</span><span class="val" id="cfg-CURSOR_PATH">-</span></div>
        <div class="config-row"><span class="key">模型</span><span class="val" id="cfg-CURSOR_MODEL">-</span></div>
        <div class="config-row"><span class="key">备选模型</span><span class="val" id="cfg-CURSOR_ALTERNATIVE_MODEL">-</span></div>
        <div class="config-row"><span class="key">头像电池电量</span><span class="val" id="cfg-CURSOR_AVATAR_BATTERY_MODE">-</span></div>
        <div class="config-row" id="cfg-CURSOR_ON_DEMAND_MONTHLY_BUDGET_ROW"><span class="key">每月On demand use预算</span><span class="val" id="cfg-CURSOR_ON_DEMAND_MONTHLY_BUDGET">-</span></div>
        <label class="agent-default-row" style="margin-top:10px"><input type="checkbox" id="dash-default-cursor" onchange="setDashboardDefaultAgent('cursor', this.checked)"> 设为默认 Agent</label>
        <div class="hint" style="margin-top:6px;line-height:1.6">生效范围：保存后下一条消息或下个新会话生效，当前生成不中断。</div>
        <button class="btn btn-outline" style="margin-top:8px" onclick="editSection('cursor')">编辑</button>
      </div>
    </details>

    <details class="card config-section" id="dash-codex">
      <summary>Codex Agent</summary>
      <div class="section-detail">
        <div class="config-row"><span class="key">CLI 路径</span><span class="val" id="cfg-CODEX_PATH">-</span></div>
        <div class="config-row"><span class="key">模型</span><span class="val" id="cfg-CODEX_MODEL">-</span></div>
        <div class="config-row"><span class="key">备选模型</span><span class="val" id="cfg-CODEX_ALTERNATIVE_MODEL">-</span></div>
        <div class="config-row"><span class="key">Effort</span><span class="val" id="cfg-CODEX_EFFORT">-</span></div>
        <div class="config-row"><span class="key">Fast 模式</span><span class="val" id="cfg-CODEX_FAST_MODE">-</span></div>
        <label class="agent-default-row" style="margin-top:10px"><input type="checkbox" id="dash-default-codex" onchange="setDashboardDefaultAgent('codex', this.checked)"> 设为默认 Agent</label>
        <div class="hint" style="margin-top:6px;line-height:1.6">生效范围：保存后下一条消息或下个新会话生效，当前生成不中断。</div>
        <button class="btn btn-outline" style="margin-top:8px" onclick="editSection('codex')">编辑</button>
      </div>
    </details>

    <details class="card config-section" id="dash-ccc">
      <summary>CCC Agent</summary>
      <div class="section-detail">
        <div class="config-row"><span class="key">API Key</span><span class="val" id="cfg-CCC_API_KEY">-</span></div>
        <div class="config-row"><span class="key">Base URL</span><span class="val" id="cfg-CCC_BASE_URL">-</span></div>
        <div class="config-row"><span class="key">API 协议</span><span class="val" id="cfg-CCC_PROVIDER">-</span></div>
        <div class="config-row"><span class="key">模型</span><span class="val" id="cfg-CCC_MODEL">-</span></div>
        <div class="config-row"><span class="key">子模型</span><span class="val" id="cfg-CCC_SUB_MODEL">-</span></div>
        <div class="config-row"><span class="key">备选模型</span><span class="val" id="cfg-CCC_ALTERNATIVE_MODEL">-</span></div>
        <div class="config-row"><span class="key">Effort</span><span class="val" id="cfg-CCC_EFFORT">-</span></div>
        <div class="config-row"><span class="key">最大输出 Token</span><span class="val" id="cfg-CCC_MAX_OUTPUT_TOKENS">-</span></div>
        <div class="config-row"><span class="key">Git 共同作者</span><span class="val" id="cfg-CCC_GIT_COAUTHOR">-</span></div>
        <label class="agent-default-row" style="margin-top:10px"><input type="checkbox" id="dash-default-ccc" onchange="setDashboardDefaultAgent('ccc', this.checked)"> 设为默认 Agent</label>
        <div class="hint" style="margin-top:6px;line-height:1.6">备选模型仅加入 /model 人工切换列表；保存后下一条消息或下个新会话生效。</div>
        <button class="btn btn-outline" style="margin-top:8px" onclick="editSection('ccc')">编辑</button>
      </div>
    </details>

    <div class="card" id="dash-no-agent-hint" style="text-align:center;color:#94a3b8;display:none">
      未启用任何 AI Agent。点击下方按钮重新运行配置向导启用。
    </div>

    <div class="card" style="text-align:center">
      <button class="btn btn-outline" onclick="reconfigure()">重新运行配置向导</button>
    </div>
  </div>

  <!-- Edit Modal -->
  <div id="edit-modal" class="card hidden" style="position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:90%;max-width:480px;z-index:200;max-height:80vh;overflow-y:auto">
    <h2 id="edit-modal-title">编辑配置</h2>
    <div id="edit-modal-effect" class="hint" style="margin-bottom:12px;line-height:1.6"></div>
    <div id="edit-modal-fields"></div>
    <div class="btn-group" style="justify-content:flex-end;margin-top:16px">
      <button class="btn btn-outline" onclick="closeEditModal()">取消</button>
      <button class="btn btn-primary" onclick="saveEdit()">保存</button>
    </div>
  </div>
  <div id="edit-overlay" class="hidden" style="position:fixed;inset:0;background:rgba(0,0,0,.3);z-index:199" onclick="closeEditModal()"></div>

</div>

<script>
let state = {
  view: 'loading',
  // 五个 Agent 各自的启用开关；初始全 false，renderStep2() 会按已存在 config 自动打开
  agentsEnabled: { claude: false, cursor: false, codex: false, ccc: false, dsh: false },
  defaultAgent: 'claude',
  wizardStep: 1,
  config: {},
  running: false,
  pid: null,
  // 平台开关；默认全开，renderStep1() 会按已存在 config 回填
  platformsEnabled: { feishu: true, ilink: true }
};

// Step 2 输入事件是否已绑（避免每次 goStep(2) 重复绑定）
var step2InputBound = false;

const AGENT_FIELDS = {
  claude: ['CHATCCC_ANTHROPIC_MODEL','CHATCCC_ANTHROPIC_SUBAGENT_MODEL','CHATCCC_ANTHROPIC_EFFORT','CHATCCC_ANTHROPIC_API_KEY','CHATCCC_ANTHROPIC_BASE_URL','CHATCCC_ANTHROPIC_MAX_TURN'],
  cursor: ['CHATCCC_CURSOR_PATH','CHATCCC_CURSOR_MODEL','CHATCCC_CURSOR_ALTERNATIVE_MODEL','CHATCCC_CURSOR_AVATAR_BATTERY_MODE','CHATCCC_CURSOR_ON_DEMAND_MONTHLY_BUDGET'],
  codex: ['CHATCCC_CODEX_PATH','CHATCCC_CODEX_MODEL','CHATCCC_CODEX_ALTERNATIVE_MODEL','CHATCCC_CODEX_EFFORT','CHATCCC_CODEX_FAST_MODE'],
  ccc: ['CHATCCC_CCC_API_KEY','CHATCCC_CCC_BASE_URL','CHATCCC_CCC_MODEL','CHATCCC_CCC_SUB_MODEL','CHATCCC_CCC_ALTERNATIVE_MODEL','CHATCCC_CCC_EFFORT','CHATCCC_CCC_MAX_OUTPUT_TOKENS','CHATCCC_CCC_PROVIDER','CHATCCC_CCC_GIT_COAUTHOR','CHATCCC_CCC_CONTEXT_WINDOW'],
  dsh: ['CHATCCC_DSH_API_KEY','CHATCCC_DSH_BASE_URL','CHATCCC_DSH_MODEL','CHATCCC_DSH_SUB_MODEL','CHATCCC_DSH_ALTERNATIVE_MODEL','CHATCCC_DSH_PROVIDER','CHATCCC_DSH_MAX_TOKENS']
};
const FEISHU_FIELDS = ['CHATCCC_APP_ID','CHATCCC_APP_SECRET'];
const WEB_UI_FIELDS = ['CHATCCC_WEB_UI_OPEN_ON_START'];
const CHROME_DEVTOOLS_FIELDS = ['CHATCCC_CHROME_DEVTOOLS_ENABLED','CHATCCC_CHROME_DEVTOOLS_PORT','CHATCCC_CHROME_DEVTOOLS_PATH'];

function cursorBatteryModeLabel(value) {
  return value === 'onDemandUse' ? 'On demand use 金额' : 'API 使用比例';
}

// 上下文窗口：预设档位 ↔ tokens。下拉值用小写 k / m 标签，自定义输入以 k 为单位。
function contextWindowPresetFor(tokens) {
  if (tokens === 1048576) return '1m';
  if (tokens === 524288) return '512k';
  if (tokens === 262144) return '256k';
  if (tokens === 131072) return '128k';
  return 'custom';
}

function contextWindowTokensLabel(tokens) {
  var t = Number(tokens) || 1048576;
  if (t >= 1048576) return (t / 1048576) + 'M (' + t.toLocaleString('en-US') + ' tokens)';
  return (t / 1024) + 'K (' + t.toLocaleString('en-US') + ' tokens)';
}

// 根据 tokens 回填预设下拉 + 自定义输入；prefix 为 'field-'（向导）或 'edit-'（编辑弹窗）。
function prefillContextWindow(prefix, tokens) {
  var t = Number(tokens) || 1048576;
  var selectEl = document.getElementById(prefix + 'CHATCCC_CCC_CONTEXT_WINDOW');
  if (!selectEl) return;
  var preset = contextWindowPresetFor(t);
  selectEl.value = preset;
  onContextWindowPresetChange(prefix, preset);
  if (preset === 'custom') {
    var customEl = document.getElementById(prefix + 'CHATCCC_CCC_CONTEXT_WINDOW_CUSTOM');
    if (customEl) customEl.value = String(Math.round(t / 1024));
  }
}

// 预设切换：custom 时显示自定义输入框（单位 k）。
function onContextWindowPresetChange(prefix, value) {
  var rowId = prefix === 'edit-' ? 'edit-CHATCCC_CCC_CONTEXT_WINDOW_CUSTOM_ROW' : 'field-CHATCCC_CCC_CONTEXT_WINDOW_CUSTOM_ROW';
  var row = document.getElementById(rowId);
  if (row) row.style.display = (value === 'custom') ? '' : 'none';
}

// 把预设下拉 + 自定义输入转换为 tokens 数字字符串（用于提交给服务端）。
function contextWindowToTokensValue(prefix) {
  var selectEl = document.getElementById(prefix + 'CHATCCC_CCC_CONTEXT_WINDOW');
  if (!selectEl || !selectEl.value) return null;
  var v = selectEl.value;
  if (v === '1m') return String(1048576);
  if (v === 'custom') {
    var customEl = document.getElementById(prefix + 'CHATCCC_CCC_CONTEXT_WINDOW_CUSTOM');
    var k = parseInt((customEl && customEl.value.trim()) || '', 10);
    if (!Number.isFinite(k) || k <= 0) k = 1024; // 非法输入回退 1M
    return String(k * 1024);
  }
  var presetK = parseInt(v, 10); // '128k' → 128
  return String((presetK || 1024) * 1024);
}

function configEffectHint(section) {
  if (section === 'feishu') return '生效范围：App ID、App Secret、平台类型或飞书开关变更需要重启 ChatCCC；其它未变更项仅保存。';
  if (section === 'webUi') return '生效范围：下次直接启动生效；内部重启始终不打开。';
  if (section === 'chromeDevtools') return '生效范围：保存后立即应用到 Chrome CDP 守护进程。';
  if (section === 'claude') return '生效范围：保存后下一条消息或下个新会话生效，当前生成不中断。';
  if (section === 'cursor') return '生效范围：保存后下一条消息或下个新会话生效，当前生成不中断。';
  if (section === 'codex') return '生效范围：保存后下一条消息或下个新会话生效，当前生成不中断。';
  return '生效范围：保存后按配置类型应用。';
}

function toastConfigApplyResult(result, savedText) {
  var text = savedText || '配置已保存';
  if (result && result.mode === 'reload') {
    toast(text + '，后续消息/新会话已生效。');
  } else if (result && result.mode === 'restart-required') {
    toast(text + '，需重启服务生效。');
  } else {
    toast(text);
  }
}

function onCursorBatteryModeChange(prefix, value) {
  var rowId = prefix === 'edit-' ? 'edit-cursor-on-demand-budget-row' : 'field-cursor-on-demand-budget-row';
  var row = document.getElementById(rowId);
  if (row) row.style.display = value === 'onDemandUse' ? '' : 'none';
}

function toggleWizardChromeDevtoolsFields(enabled) {
  var settings = document.getElementById('chrome-devtools-settings');
  if (settings) settings.style.display = enabled ? '' : 'none';
}

function toggleEditChromeDevtoolsFields(enabled) {
  ['CHATCCC_CHROME_DEVTOOLS_PORT', 'CHATCCC_CHROME_DEVTOOLS_PATH'].forEach(function(key){
    var row = document.getElementById('edit-row-' + key);
    if (row) row.style.display = enabled ? '' : 'none';
  });
}

function onWizardPlatformToggle(platform, enabled) {
  state.platformsEnabled[platform] = enabled;
  // 飞书凭证字段跟随开关显示/隐藏
  if (platform === 'feishu') {
    var credFields = document.getElementById('feishu-cred-fields');
    if (credFields) credFields.style.display = enabled ? '' : 'none';
  }
}
async function onPlatformToggle(platform, enabled) {
  var vars = {};
  if (platform === 'feishu') vars.CHATCCC_FEISHU_ENABLED = enabled;
  else vars.CHATCCC_ILINK_ENABLED = enabled;
  var result = await api('/api/config', 'POST', { vars: vars });
  if (result.ok) {
    state.config.platforms = state.config.platforms || {};
    state.config.platforms[platform] = state.config.platforms[platform] || {};
    state.config.platforms[platform].enabled = enabled;
    var label = document.getElementById('dash-platform-' + platform + '-label');
    if (label) label.textContent = enabled ? '已启用' : '未启用';
    toastConfigApplyResult(result, (platform === 'feishu' ? '飞书' : '微信 iLink') + (enabled ? ' 已启用' : ' 已禁用'));
  } else {
    toast('保存失败: ' + (result.error || '未知错误'), 'error');
    // 还原 toggle
    var toggle = document.getElementById('dash-platform-' + platform);
    if (toggle) toggle.checked = !enabled;
  }
}
async function forgetIlink() {
  if (!confirm('清除微信登录状态后，重启服务将需要重新扫码。确定吗？')) return;
  var r = await api('/api/ilink/forget', 'POST');
  if (r && r.ok) {
    toast('已清除微信登录状态。重启后将需要重新扫码。');
    var row = document.getElementById('ilink-forget-row');
    if (row) row.style.display = 'none';
  } else {
    toast('清除失败：' + ((r && r.error) || '未知错误'), 'error');
  }
}
function onAgentToggle(agent, enabled) {
  state.agentsEnabled[agent] = enabled;
  var card = document.getElementById('agent-card-' + agent);
  if (card) card.classList.toggle('enabled', enabled);
  var body = document.getElementById('agent-body-' + agent);
  if (body) body.disabled = !enabled;
  if (!enabled && state.defaultAgent === agent) {
    state.defaultAgent = firstEnabledAgent();
  } else if (enabled && !state.defaultAgent) {
    state.defaultAgent = agent;
  }
  updateDefaultAgentToggles();
  updateStep2NextBtn();
}

function firstEnabledAgent() {
  if (state.agentsEnabled.claude) return 'claude';
  if (state.agentsEnabled.cursor) return 'cursor';
  if (state.agentsEnabled.codex) return 'codex';
  if (state.agentsEnabled.ccc) return 'ccc';
  if (state.agentsEnabled.dsh) return 'dsh';
  return null;
}

function resolveDefaultAgentFromConfig(c, claudeOn, cursorOn, codexOn, cccOn, dshOn) {
  if (claudeOn && c.claude && c.claude.defaultAgent === true) return 'claude';
  if (cursorOn && c.cursor && c.cursor.defaultAgent === true) return 'cursor';
  if (codexOn && c.codex && c.codex.defaultAgent === true) return 'codex';
  if (cccOn && c.ccc && c.ccc.defaultAgent === true) return 'ccc';
  if (dshOn && c.dsh && c.dsh.defaultAgent === true) return 'dsh';
  if (claudeOn) return 'claude';
  if (cursorOn) return 'cursor';
  if (codexOn) return 'codex';
  if (cccOn) return 'ccc';
  if (dshOn) return 'dsh';
  return 'claude';
}

function updateDefaultAgentToggles() {
  ['claude','cursor','codex','ccc','dsh'].forEach(function(agent){
    var el = document.getElementById('agent-default-' + agent);
    if (el) {
      el.checked = state.defaultAgent === agent;
      el.disabled = !state.agentsEnabled[agent];
    }
    var dashEl = document.getElementById('dash-default-' + agent);
    if (dashEl) dashEl.checked = state.defaultAgent === agent;
  });
}

function onDefaultAgentToggle(agent, enabled) {
  if (enabled) {
    state.defaultAgent = agent;
  } else if (state.defaultAgent === agent) {
    state.defaultAgent = null;
  }
  updateDefaultAgentToggles();
  updateStep2NextBtn();
}

/**
 * "下一步"按钮启用条件：至少一个 Agent 开关打开
 * - cursor / codex：开关打开即视为填对（path 留空时运行时会自动探测/退回 PATH）
 */
function updateStep2NextBtn() {
  var btn = document.getElementById('btn-step2-next');
  if (!btn) return;
  var validCount = 0;
  if (state.agentsEnabled.claude) validCount++;
  if (state.agentsEnabled.cursor) validCount++;
  if (state.agentsEnabled.codex) validCount++;
  if (state.agentsEnabled.ccc) validCount++;
  if (state.agentsEnabled.dsh) validCount++;
  if (validCount > 0 && !state.defaultAgent) {
    state.defaultAgent = firstEnabledAgent();
    updateDefaultAgentToggles();
  }
  btn.disabled = validCount === 0;
}

// ---- API helpers ----
async function api(path, method, body) {
  const opts = { method, headers: {} };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch(path, opts);
  return r.json();
}

// ---- Toast ----
function toast(msg, type) {
  const el = document.createElement('div');
  el.className = 'toast toast-' + (type || 'success');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(function(){ el.remove(); }, 3000);
}

// ---- Init ----
async function init() {
  const check = await api('/api/check');
  if (check.hasCreds) {
    await loadDashboard();
  } else {
    await showWizard();
  }
}

// ---- Wizard ----
const TOTAL_STEPS = 3;

async function showWizard() {
  state.view = 'wizard';
  document.getElementById('wizard-view').classList.remove('hidden');
  document.getElementById('dashboard-view').classList.add('hidden');
  document.getElementById('header-badge').textContent = '首次配置';
  document.getElementById('header-badge').className = 'badge badge-stopped';
  // 预加载已有 config，便于在 wizard 各步骤回填
  try {
    var d = await api('/api/config');
    state.config = d.vars || {};
  } catch (e) { state.config = state.config || {}; }
  goStep(1);
}

function goStep1Next() {
  // 飞书启用时必须填写凭证；飞书未启用时跳过
  if (state.platformsEnabled.feishu) {
    var appId = (document.getElementById('field-CHATCCC_APP_ID').value || '').trim();
    var appSecret = (document.getElementById('field-CHATCCC_APP_SECRET').value || '').trim();
    if (!appId || !appSecret) {
      toast('飞书已启用，请先填写 App ID 和 App Secret', 'error');
      return;
    }
  } else if (!state.platformsEnabled.ilink) {
    toast('请至少启用一个平台（飞书或微信 iLink）', 'error');
    return;
  }
  goStep(2);
}

function goStep(n) {
  state.wizardStep = n;
  document.querySelectorAll('#wizard-view > .card').forEach(function(c){ c.classList.add('hidden'); });
  document.getElementById('step-' + n).classList.remove('hidden');
  document.querySelectorAll('#steps-bar .step').forEach(function(s, i){
    s.classList.remove('active','done');
    if (i + 1 < n) s.classList.add('done');
    if (i + 1 === n) s.classList.add('active');
  });
  document.getElementById('step-label-bar').textContent = '第 ' + n + ' 步 / 共 ' + TOTAL_STEPS + ' 步';
  if (n === 1) renderStep1();
  if (n === 2) renderStep2();
  if (n === 3) renderStep3();
}

function prefillNested(elId, val) {
  var el = document.getElementById(elId);
  if (el && !el.value && val !== undefined && val !== null && val !== '') el.value = val;
}

function renderStep1() {
  // 从嵌套 config 预填飞书字段（state.config.feishu.appId 等）
  // 端口与 /git 超时不在前端页面配置，仅作为高级配置保留在 config.json 中。
  var c = state.config || {};
  var f = c.feishu || {};
  prefillNested('field-CHATCCC_APP_ID', f.appId);
  prefillNested('field-CHATCCC_APP_SECRET', f.appSecret);
  var pf = (c.platforms && c.platforms.feishu) || {};
  prefillNested('field-CHATCCC_FEISHU_PLATFORM_TYPE', pf.platformType || 'feishu');
  // 平台开关：按已有 config 回填；首次配置（无飞书凭证）时默认关闭飞书、开启微信
  var hasExistingCreds = Boolean(c.feishu?.appId?.trim() && c.feishu?.appSecret?.trim());
  var feishuEnabled = hasExistingCreds
    ? (c.platforms?.feishu?.enabled !== false)
    : false;
  var ilinkEnabled = hasExistingCreds
    ? (c.platforms?.ilink?.enabled !== false)
    : true;
  state.platformsEnabled = { feishu: feishuEnabled, ilink: ilinkEnabled };
  var feToggle = document.getElementById('platform-enable-feishu');
  if (feToggle) feToggle.checked = feishuEnabled;
  // 飞书凭证字段初始显隐
  var credFields = document.getElementById('feishu-cred-fields');
  if (credFields) credFields.style.display = feishuEnabled ? '' : 'none';
  var ilToggle = document.getElementById('platform-enable-ilink');
  if (ilToggle) ilToggle.checked = ilinkEnabled;
  var webUiOpenOnStart = document.getElementById('field-CHATCCC_WEB_UI_OPEN_ON_START');
  if (webUiOpenOnStart) webUiOpenOnStart.checked = !c.webUi || c.webUi.openOnStart !== false;
  var cd = c.chromeDevtools || {};
  var cdpEnabled = document.getElementById('field-CHATCCC_CHROME_DEVTOOLS_ENABLED');
  if (cdpEnabled) cdpEnabled.checked = cd.enabled === true;
  prefillNested('field-CHATCCC_CHROME_DEVTOOLS_PORT', cd.port || 15166);
  prefillNested('field-CHATCCC_CHROME_DEVTOOLS_PATH', cd.chromePath);
  toggleWizardChromeDevtoolsFields(cd.enabled === true);
}

/**
 * 判定某个 agent 是否启用，优先级：
 * 1) config 中显式 boolean enabled 字段
 * 2) 任一配置字段非空（向后兼容旧 config.json，未升级到带 enabled 字段时仍可工作）
 */
function isAgentEnabled(node, keys) {
  if (!node) return false;
  if (typeof node.enabled === 'boolean') return node.enabled;
  for (var i = 0; i < keys.length; i++) {
    var v = node[keys[i]];
    if (v !== undefined && v !== null && String(v).trim() !== '') return true;
  }
  return false;
}

var CLAUDE_FALLBACK_KEYS = ['model','subagentModel','effort','maxTurn'];
var CURSOR_FALLBACK_KEYS = ['path','command','model','alternativeModel'];
var CODEX_FALLBACK_KEYS = ['path','command','model','alternativeModel','effort','fastMode'];
// 旧版 CCC 配置没有 enabled；只有 API Key 才表示用户实际完成了配置。
var CCC_FALLBACK_KEYS = ['DEEPSEEK_API_KEY'];
var DSH_FALLBACK_KEYS = ['apiKey'];

function renderStep2() {
  var c = state.config || {};
  if (c.claude) {
    prefillNested('field-CHATCCC_ANTHROPIC_MODEL', c.claude.model);
    prefillNested('field-CHATCCC_ANTHROPIC_SUBAGENT_MODEL', c.claude.subagentModel);
    prefillNested('field-CHATCCC_ANTHROPIC_EFFORT', c.claude.effort);
  }
  if (c.cursor) {
    prefillNested('field-CHATCCC_CURSOR_PATH', c.cursor.path || c.cursor.command);
    prefillNested('field-CHATCCC_CURSOR_MODEL', c.cursor.model);
    prefillNested('field-CHATCCC_CURSOR_ALTERNATIVE_MODEL', c.cursor.alternativeModel);
    var cursorMode = c.cursor.avatarBatteryMode || 'apiPercent';
    var cursorModeInput = document.getElementById('field-CHATCCC_CURSOR_AVATAR_BATTERY_MODE');
    if (cursorModeInput) cursorModeInput.value = cursorMode;
    prefillNested('field-CHATCCC_CURSOR_ON_DEMAND_MONTHLY_BUDGET', c.cursor.onDemandMonthlyBudget || 1000);
  } else {
    var defaultCursorModeInput = document.getElementById('field-CHATCCC_CURSOR_AVATAR_BATTERY_MODE');
    if (defaultCursorModeInput) defaultCursorModeInput.value = 'apiPercent';
    prefillNested('field-CHATCCC_CURSOR_ON_DEMAND_MONTHLY_BUDGET', 1000);
  }
  var cursorBatteryModeEl = document.getElementById('field-CHATCCC_CURSOR_AVATAR_BATTERY_MODE');
  if (cursorBatteryModeEl && !cursorBatteryModeEl.value) cursorBatteryModeEl.value = 'apiPercent';
  onCursorBatteryModeChange('field-', cursorBatteryModeEl ? cursorBatteryModeEl.value : 'apiPercent');
  if (c.codex) {
    prefillNested('field-CHATCCC_CODEX_PATH', c.codex.path || c.codex.command);
    prefillNested('field-CHATCCC_CODEX_MODEL', c.codex.model);
    prefillNested('field-CHATCCC_CODEX_ALTERNATIVE_MODEL', c.codex.alternativeModel);
    prefillNested('field-CHATCCC_CODEX_EFFORT', c.codex.effort);
  }
  var codexFastModeEl = document.getElementById('field-CHATCCC_CODEX_FAST_MODE');
  if (codexFastModeEl) codexFastModeEl.checked = !!(c.codex && c.codex.fastMode === true);
  if (c.ccc) {
    prefillNested('field-CHATCCC_CCC_API_KEY', c.ccc.DEEPSEEK_API_KEY);
    prefillNested('field-CHATCCC_CCC_BASE_URL', c.ccc.DEEPSEEK_BASE_URL);
    prefillNested('field-CHATCCC_CCC_PROVIDER', c.ccc.provider);
    var coAuthorField = document.getElementById('field-CHATCCC_CCC_GIT_COAUTHOR');
    if (coAuthorField) coAuthorField.value = c.ccc.gitCoAuthor == null ? 'inherit' : (c.ccc.gitCoAuthor ? 'enabled' : 'disabled');
    prefillNested('field-CHATCCC_CCC_MODEL', c.ccc.model);
    prefillNested('field-CHATCCC_CCC_SUB_MODEL', c.ccc.subModel);
    prefillNested('field-CHATCCC_CCC_ALTERNATIVE_MODEL', c.ccc.alternativeModel);
    prefillNested('field-CHATCCC_CCC_EFFORT', c.ccc.effort);
    prefillNested('field-CHATCCC_CCC_MAX_OUTPUT_TOKENS', c.ccc.maxOutputTokens);
    prefillContextWindow('field-', c.ccc.contextWindow);
  }
  if (c.dsh) {
    prefillNested('field-CHATCCC_DSH_API_KEY', c.dsh.apiKey);
    prefillNested('field-CHATCCC_DSH_BASE_URL', c.dsh.baseUrl);
    prefillNested('field-CHATCCC_DSH_MODEL', c.dsh.model);
    prefillNested('field-CHATCCC_DSH_SUB_MODEL', c.dsh.subModel);
    prefillNested('field-CHATCCC_DSH_ALTERNATIVE_MODEL', c.dsh.alternativeModel);
    prefillNested('field-CHATCCC_DSH_PROVIDER', c.dsh.provider);
    prefillNested('field-CHATCCC_DSH_MAX_TOKENS', c.dsh.maxTokens || 49152);
  }

  // 按已有 config 决定每个 Agent 默认是否开启：优先 enabled 字段，缺省时按"任一字段非空"
  var claudeOn = isAgentEnabled(c.claude, CLAUDE_FALLBACK_KEYS);
  var cursorOn = isAgentEnabled(c.cursor, CURSOR_FALLBACK_KEYS);
  var codexOn = isAgentEnabled(c.codex, CODEX_FALLBACK_KEYS);
  var cccOn = isAgentEnabled(c.ccc, CCC_FALLBACK_KEYS);
  var dshOn = isAgentEnabled(c.dsh, DSH_FALLBACK_KEYS);
  // 全新用户：五个 Agent 均无启用/配置痕迹时，只默认勾选 DeepCCC（ccc），其余不勾
  if (!claudeOn && !cursorOn && !codexOn && !cccOn && !dshOn) {
    cccOn = true;
  }
  state.defaultAgent = resolveDefaultAgentFromConfig(c, claudeOn, cursorOn, codexOn, cccOn, dshOn);
  document.getElementById('agent-enable-claude').checked = claudeOn;
  document.getElementById('agent-enable-cursor').checked = cursorOn;
  document.getElementById('agent-enable-codex').checked = codexOn;
  document.getElementById('agent-enable-ccc').checked = cccOn;
  document.getElementById('agent-enable-dsh').checked = dshOn;
  onAgentToggle('claude', claudeOn);
  onAgentToggle('cursor', cursorOn);
  onAgentToggle('codex', codexOn);
  onAgentToggle('ccc', cccOn);
  onAgentToggle('dsh', dshOn);
  updateDefaultAgentToggles();

  // Cursor path placeholder/hint：把已探测到的路径显示为占位
  var hint = document.getElementById('cursor-path-hint');
  var detected = c.cursor && (c.cursor.path || c.cursor.command);
  if (detected) {
    var inp = document.getElementById('field-CHATCCC_CURSOR_PATH');
    if (inp && !inp.value) inp.placeholder = detected;
    if (hint) hint.textContent = '已自动探测到';
  }

  // 字段输入时实时刷新"下一步"按钮
  if (!step2InputBound) {
    document.getElementById('step-2').addEventListener('input', updateStep2NextBtn);
    step2InputBound = true;
  }
  updateStep2NextBtn();
}

/**
 * 收集"待落地到 config.json 的扁平 vars"。
 *
 * - 飞书字段始终收集
  * - 五个 Agent 的 enabled 状态都显式下发，让 config.json 持久化用户的最新开关偏好
 * - Agent 字段仅在该 Agent 开关启用时收集；未启用的 Agent 不下发其它字段，
 *   服务端 deepMerge 会保留 config.json 中已有值（避免关闭开关时误清空旧配置）
 */
function collectAllFields() {
  var vars = {};
  FEISHU_FIELDS.forEach(function(key){
    var el = document.getElementById('field-' + key);
    if (el && el.value.trim()) vars[key] = el.value.trim();
  });
  // 平台类型（下拉选择框，始终发送以保持与服务端同步）
  var ptEl = document.getElementById('field-CHATCCC_FEISHU_PLATFORM_TYPE');
  if (ptEl && ptEl.value.trim()) vars['CHATCCC_FEISHU_PLATFORM_TYPE'] = ptEl.value.trim();
  vars.CHATCCC_FEISHU_ENABLED = !!state.platformsEnabled.feishu;
  vars.CHATCCC_ILINK_ENABLED = !!state.platformsEnabled.ilink;
  var webUiOpenOnStartEl = document.getElementById('field-CHATCCC_WEB_UI_OPEN_ON_START');
  vars.CHATCCC_WEB_UI_OPEN_ON_START = !webUiOpenOnStartEl || !!webUiOpenOnStartEl.checked;
  var cdpEnabledEl = document.getElementById('field-CHATCCC_CHROME_DEVTOOLS_ENABLED');
  vars.CHATCCC_CHROME_DEVTOOLS_ENABLED = !!(cdpEnabledEl && cdpEnabledEl.checked);
  var cdpPortEl = document.getElementById('field-CHATCCC_CHROME_DEVTOOLS_PORT');
  vars.CHATCCC_CHROME_DEVTOOLS_PORT = (cdpPortEl && cdpPortEl.value.trim()) ? cdpPortEl.value.trim() : '15166';
  var cdpPathEl = document.getElementById('field-CHATCCC_CHROME_DEVTOOLS_PATH');
  if (cdpPathEl && cdpPathEl.value.trim()) vars.CHATCCC_CHROME_DEVTOOLS_PATH = cdpPathEl.value.trim();
  vars.CHATCCC_CLAUDE_ENABLED = !!state.agentsEnabled.claude;
  vars.CHATCCC_CURSOR_ENABLED = !!state.agentsEnabled.cursor;
  vars.CHATCCC_CODEX_ENABLED = !!state.agentsEnabled.codex;
  vars.CHATCCC_CCC_ENABLED = !!state.agentsEnabled.ccc;
  vars.CHATCCC_DSH_ENABLED = !!state.agentsEnabled.dsh;
  if (!state.defaultAgent || !state.agentsEnabled[state.defaultAgent]) {
    state.defaultAgent = firstEnabledAgent();
  }
  vars.CHATCCC_CLAUDE_DEFAULT_AGENT = state.defaultAgent === 'claude';
  vars.CHATCCC_CURSOR_DEFAULT_AGENT = state.defaultAgent === 'cursor';
  vars.CHATCCC_CODEX_DEFAULT_AGENT = state.defaultAgent === 'codex';
  vars.CHATCCC_CCC_DEFAULT_AGENT = state.defaultAgent === 'ccc';
  vars.CHATCCC_DSH_DEFAULT_AGENT = state.defaultAgent === 'dsh';
  if (state.agentsEnabled.claude) {
    AGENT_FIELDS.claude.forEach(function(key){
      var el = document.getElementById('field-' + key);
      if (el && el.value.trim()) vars[key] = el.value.trim();
    });
  }
  if (state.agentsEnabled.cursor) {
    AGENT_FIELDS.cursor.forEach(function(key){
      var el = document.getElementById('field-' + key);
      if (el && el.value.trim()) vars[key] = el.value.trim();
    });
  }
  if (state.agentsEnabled.codex) {
    AGENT_FIELDS.codex.forEach(function(key){
      var el = document.getElementById('field-' + key);
      if (!el) return;
      if (key === 'CHATCCC_CODEX_FAST_MODE') vars[key] = !!el.checked;
      else if (el.value.trim()) vars[key] = el.value.trim();
    });
  }
  if (state.agentsEnabled.ccc) {
    AGENT_FIELDS.ccc.forEach(function(key){
      if (key === 'CHATCCC_CCC_CONTEXT_WINDOW') {
        var cw = contextWindowToTokensValue('field-');
        if (cw !== null) vars[key] = cw;
        return;
      }
      var el = document.getElementById('field-' + key);
      if (el && el.value.trim()) vars[key] = el.value.trim();
    });
  }
  if (state.agentsEnabled.dsh) {
    AGENT_FIELDS.dsh.forEach(function(key){
      var el = document.getElementById('field-' + key);
      if (el && el.value.trim()) vars[key] = el.value.trim();
    });
  }
  return vars;
}

function renderStep3() {
  var vars = collectAllFields();
  var lines = [];

  lines.push('<h3 style="margin-bottom:8px">飞书</h3>');
  lines.push('<div class="config-row"><span class="key">状态</span><span class="val">' + (state.platformsEnabled.feishu ? '已启用' : '已禁用') + '</span></div>');
  if (state.platformsEnabled.feishu) {
    lines.push('<div class="config-row"><span class="key">CHATCCC_APP_ID</span><span class="val">' + (vars.CHATCCC_APP_ID || '<span style="color:#ef4444">未填写</span>') + '</span></div>');
    lines.push('<div class="config-row"><span class="key">CHATCCC_APP_SECRET</span><span class="val">' + (vars.CHATCCC_APP_SECRET ? '***已设置***' : '<span style="color:#ef4444">未填写</span>') + '</span></div>');
    var ptLabel = vars.CHATCCC_FEISHU_PLATFORM_TYPE === 'lark' ? 'Lark (open.larksuite.com)' : '飞书 (open.feishu.cn)';
    lines.push('<div class="config-row"><span class="key">平台类型</span><span class="val">' + ptLabel + '</span></div>');
  }

  lines.push('<h3 style="margin:16px 0 8px">微信 iLink</h3>');
  lines.push('<div class="config-row"><span class="key">状态</span><span class="val">' + (state.platformsEnabled.ilink ? '已启用' : '已禁用') + '</span></div>');

  if (!state.platformsEnabled.feishu && !state.platformsEnabled.ilink) {
    lines.push('<div style="color:#ef4444;margin-top:8px">未启用任何平台</div>');
  }
  lines.push('<h3 style="margin:16px 0 8px">Web UI</h3>');
  lines.push('<div class="config-row"><span class="key">直接启动时自动打开</span><span class="val">' + (vars.CHATCCC_WEB_UI_OPEN_ON_START ? '已启用' : '已禁用') + '</span></div>');

  lines.push('<h3 style="margin:16px 0 8px">Chrome CDP</h3>');
  lines.push('<div class="config-row"><span class="key">状态</span><span class="val">' + (vars.CHATCCC_CHROME_DEVTOOLS_ENABLED ? '已启用' : '已禁用') + '</span></div>');
  if (vars.CHATCCC_CHROME_DEVTOOLS_ENABLED) {
    lines.push('<div class="config-row"><span class="key">CDP 端口</span><span class="val">' + (vars.CHATCCC_CHROME_DEVTOOLS_PORT || '15166') + '</span></div>');
    if (vars.CHATCCC_CHROME_DEVTOOLS_PATH) {
      lines.push('<div class="config-row"><span class="key">Chrome 路径</span><span class="val">' + vars.CHATCCC_CHROME_DEVTOOLS_PATH + '</span></div>');
    }
  }

  lines.push('<h3 style="margin:16px 0 8px">已启用的 AI Agent</h3>');
  var enabledList = [];
  if (state.agentsEnabled.claude) enabledList.push('claude');
  if (state.agentsEnabled.cursor) enabledList.push('cursor');
  if (state.agentsEnabled.codex) enabledList.push('codex');
  if (state.agentsEnabled.ccc) enabledList.push('ccc');
  if (state.agentsEnabled.dsh) enabledList.push('dsh');
  if (enabledList.length === 0) {
    lines.push('<div style="color:#ef4444">未启用任何 AI Agent</div>');
  } else {
    var defaultLabel = state.defaultAgent === 'cursor' ? 'Cursor' : state.defaultAgent === 'codex' ? 'Codex' : state.defaultAgent === 'ccc' ? 'CCC Agent' : 'Claude Code';
    lines.push('<div class="config-row"><span class="key">/new 默认 Agent</span><span class="val">' + defaultLabel + '</span></div>');
  }
  enabledList.forEach(function(t){
    if (t === 'claude') {
      lines.push('<h4 style="margin:10px 0 4px;color:#334155">Claude Code</h4>');
      lines.push('<div class="config-row"><span class="key">模型</span><span class="val">' + (vars.CHATCCC_ANTHROPIC_MODEL || '(留空)') + '</span></div>');
      lines.push('<div class="config-row"><span class="key">Subagent 模型</span><span class="val">' + (vars.CHATCCC_ANTHROPIC_SUBAGENT_MODEL || '(留空)') + '</span></div>');
      lines.push('<div class="config-row"><span class="key">Effort</span><span class="val">' + (vars.CHATCCC_ANTHROPIC_EFFORT || '(留空)') + '</span></div>');
      lines.push('<div class="config-row"><span class="key">API Key</span><span class="val">' + (vars.CHATCCC_ANTHROPIC_API_KEY ? '***已设置***' : '(留空)') + '</span></div>');
      lines.push('<div class="config-row"><span class="key">Base URL</span><span class="val">' + (vars.CHATCCC_ANTHROPIC_BASE_URL || '(留空)') + '</span></div>');
    } else if (t === 'cursor') {
      lines.push('<h4 style="margin:10px 0 4px;color:#334155">Cursor</h4>');
      if (vars.CHATCCC_CURSOR_PATH) lines.push('<div class="config-row"><span class="key">CLI 路径</span><span class="val">' + vars.CHATCCC_CURSOR_PATH + '</span></div>');
      lines.push('<div class="config-row"><span class="key">模型</span><span class="val">' + (vars.CHATCCC_CURSOR_MODEL || '(留空)') + '</span></div>');
      lines.push('<div class="config-row"><span class="key">备选模型</span><span class="val">' + (vars.CHATCCC_CURSOR_ALTERNATIVE_MODEL || '(留空)') + '</span></div>');
      lines.push('<div class="config-row"><span class="key">头像电池电量</span><span class="val">' + cursorBatteryModeLabel(vars.CHATCCC_CURSOR_AVATAR_BATTERY_MODE) + '</span></div>');
      if (vars.CHATCCC_CURSOR_AVATAR_BATTERY_MODE === 'onDemandUse') {
        lines.push('<div class="config-row"><span class="key">每月On demand use预算</span><span class="val">' + (vars.CHATCCC_CURSOR_ON_DEMAND_MONTHLY_BUDGET || '1000') + '</span></div>');
      }
    } else if (t === 'codex') {
      lines.push('<h4 style="margin:10px 0 4px;color:#334155">Codex</h4>');
      if (vars.CHATCCC_CODEX_PATH) lines.push('<div class="config-row"><span class="key">CLI 路径</span><span class="val">' + vars.CHATCCC_CODEX_PATH + '</span></div>');
      lines.push('<div class="config-row"><span class="key">模型</span><span class="val">' + (vars.CHATCCC_CODEX_MODEL || '(留空)') + '</span></div>');
      lines.push('<div class="config-row"><span class="key">备选模型</span><span class="val">' + (vars.CHATCCC_CODEX_ALTERNATIVE_MODEL || '(留空)') + '</span></div>');
      lines.push('<div class="config-row"><span class="key">Effort</span><span class="val">' + (vars.CHATCCC_CODEX_EFFORT || '(留空)') + '</span></div>');
      lines.push('<div class="config-row"><span class="key">Fast 模式</span><span class="val">' + (vars.CHATCCC_CODEX_FAST_MODE ? '已启用' : '已禁用') + '</span></div>');
    } else if (t === 'ccc') {
      lines.push('<h4 style="margin:10px 0 4px;color:#334155">CCC Agent</h4>');
      lines.push('<div class="config-row"><span class="key">API Key</span><span class="val">' + (vars.CHATCCC_CCC_API_KEY ? '***已设置***' : '(留空)') + '</span></div>');
      lines.push('<div class="config-row"><span class="key">Base URL</span><span class="val">' + (vars.CHATCCC_CCC_BASE_URL || '(留空)') + '</span></div>');
      lines.push('<div class="config-row"><span class="key">模型</span><span class="val">' + (vars.CHATCCC_CCC_MODEL || '(留空)') + '</span></div>');
      lines.push('<div class="config-row"><span class="key">子模型</span><span class="val">' + (vars.CHATCCC_CCC_SUB_MODEL || '(留空，跟随主模型)') + '</span></div>');
      lines.push('<div class="config-row"><span class="key">备选模型</span><span class="val">' + (vars.CHATCCC_CCC_ALTERNATIVE_MODEL || '(留空)') + '</span></div>');
      lines.push('<div class="config-row"><span class="key">Effort</span><span class="val">' + (vars.CHATCCC_CCC_EFFORT || '(留空)') + '</span></div>');
      lines.push('<div class="config-row"><span class="key">最大输出 Token</span><span class="val">' + (vars.CHATCCC_CCC_MAX_OUTPUT_TOKENS || '(跟随 DeepCCC)') + '</span></div>');
      lines.push('<div class="config-row"><span class="key">上下文窗口</span><span class="val">' + contextWindowTokensLabel(vars.CHATCCC_CCC_CONTEXT_WINDOW || 1048576) + '</span></div>');
    } else if (t === 'dsh') {
      lines.push('<h4 style="margin:10px 0 4px;color:#334155">DeepSeek Harness</h4>');
      lines.push('<div class="config-row"><span class="key">API Key</span><span class="val">' + (vars.CHATCCC_DSH_API_KEY ? '***已设置***' : '(留空)') + '</span></div>');
      lines.push('<div class="config-row"><span class="key">Base URL</span><span class="val">' + (vars.CHATCCC_DSH_BASE_URL || '(默认)') + '</span></div>');
      lines.push('<div class="config-row"><span class="key">模型</span><span class="val">' + (vars.CHATCCC_DSH_MODEL || 'deepseek-v4-flash') + '</span></div>');
    }
  });
  document.getElementById('review-content').innerHTML = lines.join('');
}

async function saveConfig(vars, options) {
  options = options || {};
  var result = await api('/api/config', 'POST', { vars: vars });
  if (result.ok) {
    state.config = Object.assign({}, state.config, vars);
    if (!options.quiet) toastConfigApplyResult(result, '配置已保存');
  } else {
    toast('保存失败: ' + (result.error || '未知错误'), 'error');
  }
  return result;
}

async function setDashboardDefaultAgent(agent, enabled) {
  if (!enabled) {
    updateDefaultAgentToggles();
    return;
  }
  state.defaultAgent = agent;
  var vars = {
    CHATCCC_CLAUDE_DEFAULT_AGENT: agent === 'claude',
    CHATCCC_CURSOR_DEFAULT_AGENT: agent === 'cursor',
    CHATCCC_CODEX_DEFAULT_AGENT: agent === 'codex',
    CHATCCC_CCC_DEFAULT_AGENT: agent === 'ccc',
    CHATCCC_DSH_DEFAULT_AGENT: agent === 'dsh'
  };
  var result = await api('/api/config', 'POST', { vars: vars });
  if (result.ok) {
    state.config.claude = state.config.claude || {};
    state.config.cursor = state.config.cursor || {};
    state.config.codex = state.config.codex || {};
    state.config.ccc = state.config.ccc || {};
    state.config.dsh = state.config.dsh || {};
    state.config.claude.defaultAgent = agent === 'claude';
    state.config.cursor.defaultAgent = agent === 'cursor';
    state.config.codex.defaultAgent = agent === 'codex';
    state.config.ccc.defaultAgent = agent === 'ccc';
    state.config.dsh.defaultAgent = agent === 'dsh';
    updateDefaultAgentToggles();
    toastConfigApplyResult(result, '默认 Agent 已更新');
  } else {
    toast('保存失败: ' + (result.error || '未知错误'), 'error');
    updateDefaultAgentToggles();
  }
}

async function saveAndStart() {
  var vars = collectAllFields();
  if (state.platformsEnabled.feishu && (!vars.CHATCCC_APP_ID || !vars.CHATCCC_APP_SECRET)) {
    toast('飞书已启用，请先填写 App ID 和 App Secret', 'error');
    return;
  }
  var saved = await saveConfig(vars, { quiet: true });
  if (saved.ok !== true) return;
  document.getElementById('btn-save-start').disabled = true;
  document.getElementById('btn-save-start').innerHTML = '<span class="spinner"></span> 应用中...';

  if (state.running && saved.restartRequired === true) {
    await api('/api/restart', 'POST');
    toast('配置已保存，服务正在重启…');
    pollUntilRunning();
    return;
  }

  if (state.running && saved.mode === 'reload') {
    toastConfigApplyResult(saved, '配置已保存');
    setTimeout(function(){ location.reload(); }, 1000);
    return;
  }

  var result = await api('/api/start', 'POST');
  if (result.ok) {
    var msg;
    if (result.mode === 'reload') {
      msg = '配置已保存，后续消息/新会话已生效。';
    } else if (result.mode === 'inplace') {
      msg = '服务已启动! PID: ' + result.pid;
    } else {
      msg = '服务已启动! PID: ' + (result.pid || '?');
    }
    toast(msg);
    setTimeout(function(){ location.reload(); }, 1500);
  } else {
    toast('保存失败: ' + (result.error || '未知错误'), 'error');
    document.getElementById('btn-save-start').disabled = false;
    document.getElementById('btn-save-start').textContent = '保存并启动';
  }
}

// ---- Dashboard ----
async function loadDashboard() {
  state.view = 'dashboard';
  document.getElementById('wizard-view').classList.add('hidden');
  document.getElementById('dashboard-view').classList.remove('hidden');

  var configData = await api('/api/config');
  state.config = configData.vars || {};
  state.running = configData.running;
  state.pid = configData.pid;
  state.ilinkAuthExists = configData.ilinkAuthExists || false;

  updateDashboardUI();
  if (state.running) { pollStatus(); }
}

function updateDashboardUI() {
  var running = state.running;
  var dot = document.getElementById('status-dot');
  var text = document.getElementById('status-text');
  var detail = document.getElementById('status-detail');
  var badge = document.getElementById('header-badge');
  var btnStop = document.getElementById('btn-stop');
  var btnRestart = document.getElementById('btn-restart');

  // dashboard 顶部不再提供"启动"按钮：dashboard 本身跑在 chatccc 进程内，
  // 用户能看到此页面时 service 必然在跑；停止后页面随进程退出无法再点启动，
  // 必须回到终端 chatccc 重新启动。这里只保留"停止 / 重启"。
  if (running) {
    dot.className = 'status-dot running';
    text.textContent = '服务运行中';
    detail.textContent = 'PID: ' + (state.pid || '?') + ' | 端口: ' + (state.config.port || '18080');
    badge.textContent = '运行中';
    badge.className = 'badge badge-running';
    btnStop.disabled = false;
    btnRestart.disabled = false;
  } else {
    dot.className = 'status-dot stopped';
    text.textContent = '服务未启动（请在终端运行 chatccc 重新启动）';
    detail.textContent = '';
    badge.textContent = '已停止';
    badge.className = 'badge badge-stopped';
    btnStop.disabled = true;
    btnRestart.disabled = true;
  }

  // Config summary
  var c = state.config;

  // Platform toggles
  var feishuEnabled = c.platforms && c.platforms.feishu ? c.platforms.feishu.enabled !== false : true;
  var fsToggle = document.getElementById('dash-platform-feishu');
  if (fsToggle) fsToggle.checked = feishuEnabled;
  var fsLabel = document.getElementById('dash-platform-feishu-label');
  if (fsLabel) fsLabel.textContent = feishuEnabled ? '已启用' : '已禁用';
  state.platformsEnabled.feishu = feishuEnabled;
  document.getElementById('cfg-APP_ID').textContent = c.feishu && c.feishu.appId ? c.feishu.appId.slice(0,8) + '...' + c.feishu.appId.slice(-4) : '-';
  document.getElementById('cfg-APP_SECRET').textContent = c.feishu && c.feishu.appSecret ? '***已设置***' : '-';
  var pt = (c.platforms && c.platforms.feishu && c.platforms.feishu.platformType === 'lark') ? 'Lark (open.larksuite.com)' : '飞书 (open.feishu.cn)';
  document.getElementById('cfg-FEISHU_PLATFORM_TYPE').textContent = pt;

  // 只显示已启用的 Agent 卡片（按 enabled 字段；缺省时退回到"任一字段非空"兼容旧 config）
  var claudeOn = isAgentEnabled(c.claude, CLAUDE_FALLBACK_KEYS);
  var cursorOn = isAgentEnabled(c.cursor, CURSOR_FALLBACK_KEYS);
  var codexOn = isAgentEnabled(c.codex, CODEX_FALLBACK_KEYS);
  var cccOn = isAgentEnabled(c.ccc, CCC_FALLBACK_KEYS);
  var dshOn = isAgentEnabled(c.dsh, DSH_FALLBACK_KEYS);
  state.agentsEnabled = { claude: claudeOn, cursor: cursorOn, codex: codexOn, ccc: cccOn, dsh: dshOn };
  state.defaultAgent = resolveDefaultAgentFromConfig(c, claudeOn, cursorOn, codexOn, cccOn, dshOn);

  // 微信 iLink 平台开关：同步复选框和标签
  var ilinkEnabled = c.platforms && c.platforms.ilink ? c.platforms.ilink.enabled !== false : true;
  var ilToggle = document.getElementById('dash-platform-ilink');
  if (ilToggle) ilToggle.checked = ilinkEnabled;
  var ilLabel = document.getElementById('dash-platform-ilink-label');
  if (ilLabel) ilLabel.textContent = ilinkEnabled ? '已启用' : '已禁用';
  state.platformsEnabled.ilink = ilinkEnabled;

  // 微信 iLink "忘记扫码" 按钮：仅在 ilink 已启用且有已保存 token 时显示
  var ilinkForgetRow = document.getElementById('ilink-forget-row');
  if (ilinkForgetRow) {
    ilinkForgetRow.style.display = (ilinkEnabled && state.ilinkAuthExists) ? '' : 'none';
  }

  var webUi = c.webUi || {};
  document.getElementById('cfg-WEB_UI_OPEN_ON_START').textContent = webUi.openOnStart !== false ? '已启用' : '已禁用';

  var chromeDevtools = c.chromeDevtools || {};
  var cdpPort = chromeDevtools.port || 15166;
  document.getElementById('cfg-CHROME_DEVTOOLS_ENABLED').textContent = chromeDevtools.enabled ? '已启用' : '已禁用';
  document.getElementById('cfg-CHROME_DEVTOOLS_PORT').textContent = String(cdpPort);
  document.getElementById('cfg-CHROME_DEVTOOLS_PATH').textContent = chromeDevtools.chromePath || '(自动探测)';
  var cdpPortRow = document.getElementById('cfg-CHROME_DEVTOOLS_PORT_ROW');
  var cdpPathRow = document.getElementById('cfg-CHROME_DEVTOOLS_PATH_ROW');
  if (cdpPortRow) cdpPortRow.style.display = chromeDevtools.enabled ? '' : 'none';
  if (cdpPathRow) cdpPathRow.style.display = chromeDevtools.enabled ? '' : 'none';

  document.getElementById('dash-claude').style.display = claudeOn ? '' : 'none';
  document.getElementById('dash-cursor').style.display = cursorOn ? '' : 'none';
  document.getElementById('dash-codex').style.display = codexOn ? '' : 'none';
  document.getElementById('dash-ccc').style.display = cccOn ? '' : 'none';
  document.getElementById('dash-dsh').style.display = dshOn ? '' : 'none';
  updateDefaultAgentToggles();
  // 五个都未启用时给一个空态提示，引导用户去配置向导启用
  var emptyHint = document.getElementById('dash-no-agent-hint');
  if (emptyHint) emptyHint.style.display = (!claudeOn && !cursorOn && !codexOn && !cccOn && !dshOn) ? '' : 'none';

  document.getElementById('cfg-ANTHROPIC_MODEL').textContent = (c.claude && c.claude.model) || '(留空)';
  document.getElementById('cfg-ANTHROPIC_SUBAGENT_MODEL').textContent = (c.claude && c.claude.subagentModel) || '(留空)';
  document.getElementById('cfg-ANTHROPIC_EFFORT').textContent = (c.claude && c.claude.effort) || '(留空)';
  document.getElementById('cfg-ANTHROPIC_API_KEY').textContent = (c.claude && c.claude.apiKey) ? '***已设置***' : '(留空)';
  document.getElementById('cfg-ANTHROPIC_BASE_URL').textContent = (c.claude && c.claude.baseUrl) || '(留空)';
  document.getElementById('cfg-ANTHROPIC_MAX_TURN').textContent = (c.claude && c.claude.maxTurn != null) ? String(c.claude.maxTurn) : '0';
  document.getElementById('cfg-CURSOR_PATH').textContent = (c.cursor && (c.cursor.path || c.cursor.command)) || '-';
  document.getElementById('cfg-CURSOR_MODEL').textContent = (c.cursor && c.cursor.model) || '(留空)';
  document.getElementById('cfg-CURSOR_ALTERNATIVE_MODEL').textContent = (c.cursor && c.cursor.alternativeModel) || '(留空)';
  var cursorBatteryMode = (c.cursor && c.cursor.avatarBatteryMode) || 'apiPercent';
  document.getElementById('cfg-CURSOR_AVATAR_BATTERY_MODE').textContent = cursorBatteryModeLabel(cursorBatteryMode);
  var cursorBudgetRow = document.getElementById('cfg-CURSOR_ON_DEMAND_MONTHLY_BUDGET_ROW');
  if (cursorBudgetRow) cursorBudgetRow.style.display = cursorBatteryMode === 'onDemandUse' ? '' : 'none';
  document.getElementById('cfg-CURSOR_ON_DEMAND_MONTHLY_BUDGET').textContent = String((c.cursor && c.cursor.onDemandMonthlyBudget) || 1000);
  document.getElementById('cfg-CODEX_PATH').textContent = (c.codex && (c.codex.path || c.codex.command)) || 'codex';
  document.getElementById('cfg-CODEX_MODEL').textContent = (c.codex && c.codex.model) || '(留空)';
  document.getElementById('cfg-CODEX_ALTERNATIVE_MODEL').textContent = (c.codex && c.codex.alternativeModel) || '(留空)';
  document.getElementById('cfg-CODEX_EFFORT').textContent = (c.codex && c.codex.effort) || '(留空)';
  document.getElementById('cfg-CODEX_FAST_MODE').textContent = c.codex && c.codex.fastMode === true ? '已启用' : '已禁用';
  document.getElementById('cfg-CCC_API_KEY').textContent = (c.ccc && c.ccc.DEEPSEEK_API_KEY) ? '***已设置***' : '(留空)';
  document.getElementById('cfg-CCC_BASE_URL').textContent = (c.ccc && c.ccc.DEEPSEEK_BASE_URL) || '(留空)';
  document.getElementById('cfg-CCC_PROVIDER').textContent = (c.ccc && c.ccc.provider) ? c.ccc.provider : '(跟随 DeepCCC 内核配置)';
  document.getElementById('cfg-CCC_MODEL').textContent = (c.ccc && c.ccc.model) || '(留空)';
  document.getElementById('cfg-CCC_SUB_MODEL').textContent = (c.ccc && c.ccc.subModel) || '(留空，跟随主模型)';
  document.getElementById('cfg-CCC_ALTERNATIVE_MODEL').textContent = (c.ccc && c.ccc.alternativeModel) || '(留空)';
  document.getElementById('cfg-CCC_EFFORT').textContent = (c.ccc && c.ccc.effort) || '(跟随 DeepCCC 内核配置)';
  document.getElementById('cfg-CCC_MAX_OUTPUT_TOKENS').textContent = c.ccc && c.ccc.maxOutputTokens
    ? String(c.ccc.maxOutputTokens)
    : '(跟随 DeepCCC 内核配置)';
  document.getElementById('cfg-CCC_GIT_COAUTHOR').textContent = !c.ccc || c.ccc.gitCoAuthor == null
    ? '跟随 DeepCCC 全局设置（缺省开启）'
    : (c.ccc.gitCoAuthor ? '强制开启' : '强制关闭');
  document.getElementById('cfg-DSH_API_KEY').textContent = (c.dsh && c.dsh.apiKey) ? '***已设置***' : '(留空)';
  document.getElementById('cfg-DSH_BASE_URL').textContent = (c.dsh && c.dsh.baseUrl) || 'https://api.deepseek.com/v1';
  document.getElementById('cfg-DSH_MODEL').textContent = (c.dsh && c.dsh.model) || 'deepseek-v4-flash';
  document.getElementById('cfg-DSH_SUB_MODEL').textContent = (c.dsh && c.dsh.subModel) || '(留空，跟随主模型)';
  document.getElementById('cfg-DSH_ALTERNATIVE_MODEL').textContent = (c.dsh && c.dsh.alternativeModel) || '(留空)';
  document.getElementById('cfg-DSH_PROVIDER').textContent = (c.dsh && c.dsh.provider) || 'deepseek-official';
  document.getElementById('cfg-DSH_MAX_TOKENS').textContent = String((c.dsh && c.dsh.maxTokens) || 49152);
  engineRefreshStatus('dsh');
}

function pollStatus() {
  setInterval(async function(){
    if (state.view !== 'dashboard') return;
    var s = await api('/api/status');
    state.running = s.running;
    state.pid = s.pid;
    updateDashboardUI();
  }, 5000);
}

async function stopService() {
  if (!confirm('确定要停止服务吗？停止后需要在终端重新运行 chatccc 来启动。')) return;
  document.getElementById('btn-stop').disabled = true;
  document.getElementById('btn-stop').textContent = '停止中...';
  await api('/api/stop', 'POST');
  state.running = false;
  state.pid = null;
  toast('服务已停止。请在终端运行 chatccc 重新启动。');
  updateDashboardUI();
}

async function restartService() {
  if (!confirm('确定要重启服务吗？')) return;
  document.getElementById('btn-restart').disabled = true;
  document.getElementById('btn-restart').textContent = '重启中...';
  await api('/api/restart', 'POST');
  pollUntilRunning();
}

async function pollUntilRunning() {
  for (var i = 0; i < 30; i++) {
    await new Promise(function(r) { setTimeout(r, 1000); });
    try {
      var s = await api('/api/status');
      if (s.running) { location.reload(); return; }
    } catch(e) {}
  }
  toast('重启超时，请在终端手动运行 chatccc', 'error');
  document.getElementById('btn-restart').disabled = false;
  document.getElementById('btn-restart').textContent = '重启';
}

// ---- Edit Modal ----
var editSectionType = null;

function editSection(section) {
  editSectionType = section;
  var fields;
  if (section === 'feishu') fields = FEISHU_FIELDS;
  else if (section === 'webUi') fields = WEB_UI_FIELDS;
  else if (section === 'chromeDevtools') fields = CHROME_DEVTOOLS_FIELDS;
  else fields = AGENT_FIELDS[section] || [];

  var titleMap = { feishu: '飞书', webUi: 'Web UI', chromeDevtools: 'Chrome CDP', claude: 'Claude Agent', cursor: 'Cursor Agent', codex: 'Codex Agent', ccc: 'CCC Agent', dsh: 'DeepSeek Harness' };
  document.getElementById('edit-modal-title').textContent = '编辑 ' + (titleMap[section] || section);

  document.getElementById('edit-modal-effect').textContent = configEffectHint(section);

  var html = '';
  var labelMap = {
    'CHATCCC_APP_ID': 'App ID', 'CHATCCC_APP_SECRET': 'App Secret',
    'CHATCCC_WEB_UI_OPEN_ON_START': '直接启动 ChatCCC 时自动打开 Web UI',
    'CHATCCC_CHROME_DEVTOOLS_ENABLED': '启用常驻 Chrome CDP（选填）',
    'CHATCCC_CHROME_DEVTOOLS_PORT': 'CDP 端口',
    'CHATCCC_CHROME_DEVTOOLS_PATH': 'Chrome 路径（选填）',
    'CHATCCC_ANTHROPIC_MODEL': '模型', 'CHATCCC_ANTHROPIC_SUBAGENT_MODEL': 'Subagent 模型', 'CHATCCC_ANTHROPIC_EFFORT': 'Effort',
    'CHATCCC_ANTHROPIC_API_KEY': 'API Key', 'CHATCCC_ANTHROPIC_BASE_URL': 'Base URL', 'CHATCCC_ANTHROPIC_MAX_TURN': 'Max Turns (0=无限制)',
    'CHATCCC_CURSOR_PATH': 'CLI 路径', 'CHATCCC_CURSOR_MODEL': '模型', 'CHATCCC_CURSOR_ALTERNATIVE_MODEL': '备选模型',
    'CHATCCC_CURSOR_AVATAR_BATTERY_MODE': '头像电池电量',
    'CHATCCC_CURSOR_ON_DEMAND_MONTHLY_BUDGET': '每月On demand use预算',
    'CHATCCC_CODEX_PATH': 'CLI 路径', 'CHATCCC_CODEX_MODEL': '模型', 'CHATCCC_CODEX_ALTERNATIVE_MODEL': '备选模型', 'CHATCCC_CODEX_EFFORT': 'Effort',
    'CHATCCC_CODEX_FAST_MODE': 'Fast 模式',
    'CHATCCC_CCC_API_KEY': 'API Key', 'CHATCCC_CCC_BASE_URL': 'Base URL',
    'CHATCCC_CCC_PROVIDER': 'API 协议（选填）',
    'CHATCCC_CCC_GIT_COAUTHOR': 'Git 提交共同作者',
    'CHATCCC_CCC_MODEL': '模型', 'CHATCCC_CCC_SUB_MODEL': '子模型', 'CHATCCC_CCC_ALTERNATIVE_MODEL': '备选模型', 'CHATCCC_CCC_EFFORT': 'Effort', 'CHATCCC_CCC_MAX_OUTPUT_TOKENS': '最大输出 Token', 'CHATCCC_CCC_CONTEXT_WINDOW': '上下文窗口',
    'CHATCCC_DSH_API_KEY': 'API Key', 'CHATCCC_DSH_BASE_URL': 'Base URL', 'CHATCCC_DSH_MODEL': '模型', 'CHATCCC_DSH_SUB_MODEL': '子模型', 'CHATCCC_DSH_ALTERNATIVE_MODEL': '备选模型', 'CHATCCC_DSH_PROVIDER': 'Provider 路由', 'CHATCCC_DSH_MAX_TOKENS': '单次最大输出 Tokens'
  };
  var hintMap = {
    'CHATCCC_WEB_UI_OPEN_ON_START': '关闭后可继续手动访问 http://localhost:<端口>/；/restart、/update 和 Web UI 重启无论此项为何值都不会自动打开。',
    'CHATCCC_CHROME_DEVTOOLS_ENABLED': '依赖：本机 Google Chrome；ChatGPT 订阅到期查询需要在该 CDP Chrome 中登录 ChatGPT。',
    'CHATCCC_CHROME_DEVTOOLS_PORT': '默认 15166，健康检查端点为 http://127.0.0.1:15166/json/version。',
    'CHATCCC_CHROME_DEVTOOLS_PATH': '选填。留空时自动探测 Google Chrome。',
    'CHATCCC_CCC_PROVIDER': '与 Base URL 强相关：OpenAI 兼容端点选 openai；Anthropic Messages 端点选 anthropic。留空 = 跟随 DeepCCC 内核配置（~/.deepccc/config.json 或 DEEPCCC_PROVIDER），改动需重启 ChatCCC 生效。',
    'CHATCCC_CCC_EFFORT': '留空 = 跟随 DeepCCC 内核配置（~/.deepccc/config.json 或 DEEPCCC_EFFORT）；内核也留空时使用模型服务端默认值。',
    'CHATCCC_CCC_MAX_OUTPUT_TOKENS': '正整数；留空 = 跟随 DeepCCC 内核配置（~/.deepccc/config.json 或 DEEPCCC_MAX_OUTPUT_TOKENS）；内核也未配置时使用模型服务端默认值。',
    'CHATCCC_CCC_GIT_COAUTHOR': '跟随全局时读取 ~/.deepccc/config.json 的 git.coAuthor.enabled（缺省为开启）。强制选项只影响 ChatCCC 内置 CCC Agent。',
    'CHATCCC_CCC_CONTEXT_WINDOW': '压缩阈值自动 = 窗口 × 80%（超出即把较早消息压缩为摘要）。⚠️ 超过模型/服务端实际上限时请求会被 API 直接拒绝（context length exceeded），实际窗口以模型与所用服务端为准（如 litellm 代理的 max_input_tokens）；单位 k = 1024 tokens，1M = 1,048,576 tokens。',
    'CHATCCC_CCC_SUB_MODEL': '用于 DeepCCC 内部轻量环节（上下文压缩摘要生成、task 子代理任务）。留空 = 跟随主模型；改动需重启 ChatCCC 生效。'
  };

  if (section === 'chromeDevtools') {
    html += '<div class="hint" style="margin-bottom:12px;line-height:1.6">常驻 Chrome CDP 用于维护本机 Chrome DevTools Protocol 端口。依赖：本机 Google Chrome；ChatGPT 订阅到期查询需要在该 CDP Chrome 中登录 ChatGPT。</div>';
  }

  fields.forEach(function(key){
    var val = state.config[key] || '';
    // Also check nested config
    if (!val) {
      if (section === 'feishu') {
        if (key === 'CHATCCC_APP_ID' && state.config.feishu) val = state.config.feishu.appId || '';
        else if (key === 'CHATCCC_APP_SECRET' && state.config.feishu) val = state.config.feishu.appSecret || '';
      } else if (section === 'webUi') {
        val = !state.config.webUi || state.config.webUi.openOnStart !== false ? 'true' : 'false';
      } else if (section === 'chromeDevtools' && state.config.chromeDevtools) {
        if (key === 'CHATCCC_CHROME_DEVTOOLS_ENABLED') val = state.config.chromeDevtools.enabled === true ? 'true' : 'false';
        else if (key === 'CHATCCC_CHROME_DEVTOOLS_PORT') val = state.config.chromeDevtools.port != null ? String(state.config.chromeDevtools.port) : '15166';
        else if (key === 'CHATCCC_CHROME_DEVTOOLS_PATH') val = state.config.chromeDevtools.chromePath || '';
      } else if (section === 'claude' && state.config.claude) {
        if (key === 'CHATCCC_ANTHROPIC_MODEL') val = state.config.claude.model || '';
        else if (key === 'CHATCCC_ANTHROPIC_SUBAGENT_MODEL') val = state.config.claude.subagentModel || '';
        else if (key === 'CHATCCC_ANTHROPIC_EFFORT') val = state.config.claude.effort || '';
        else if (key === 'CHATCCC_ANTHROPIC_API_KEY') val = state.config.claude.apiKey || '';
        else if (key === 'CHATCCC_ANTHROPIC_BASE_URL') val = state.config.claude.baseUrl || '';
        else if (key === 'CHATCCC_ANTHROPIC_MAX_TURN') val = (state.config.claude.maxTurn != null) ? String(state.config.claude.maxTurn) : '0';
      } else if (section === 'cursor' && state.config.cursor) {
        if (key === 'CHATCCC_CURSOR_PATH') val = state.config.cursor.path || state.config.cursor.command || '';
        else if (key === 'CHATCCC_CURSOR_MODEL') val = state.config.cursor.model || '';
        else if (key === 'CHATCCC_CURSOR_ALTERNATIVE_MODEL') val = state.config.cursor.alternativeModel || '';
        else if (key === 'CHATCCC_CURSOR_AVATAR_BATTERY_MODE') val = state.config.cursor.avatarBatteryMode || 'apiPercent';
        else if (key === 'CHATCCC_CURSOR_ON_DEMAND_MONTHLY_BUDGET') val = (state.config.cursor.onDemandMonthlyBudget != null) ? String(state.config.cursor.onDemandMonthlyBudget) : '1000';
      } else if (section === 'codex' && state.config.codex) {
        if (key === 'CHATCCC_CODEX_PATH') val = state.config.codex.path || state.config.codex.command || '';
        else if (key === 'CHATCCC_CODEX_MODEL') val = state.config.codex.model || '';
        else if (key === 'CHATCCC_CODEX_ALTERNATIVE_MODEL') val = state.config.codex.alternativeModel || '';
        else if (key === 'CHATCCC_CODEX_EFFORT') val = state.config.codex.effort || '';
        else if (key === 'CHATCCC_CODEX_FAST_MODE') val = state.config.codex.fastMode === true ? 'true' : 'false';
      } else if (section === 'ccc' && state.config.ccc) {
        if (key === 'CHATCCC_CCC_API_KEY') val = state.config.ccc.DEEPSEEK_API_KEY || '';
        else if (key === 'CHATCCC_CCC_BASE_URL') val = state.config.ccc.DEEPSEEK_BASE_URL || '';
        else if (key === 'CHATCCC_CCC_PROVIDER') val = state.config.ccc.provider || '';
        else if (key === 'CHATCCC_CCC_GIT_COAUTHOR') val = state.config.ccc.gitCoAuthor == null ? 'inherit' : (state.config.ccc.gitCoAuthor ? 'enabled' : 'disabled');
        else if (key === 'CHATCCC_CCC_MODEL') val = state.config.ccc.model || '';
        else if (key === 'CHATCCC_CCC_SUB_MODEL') val = state.config.ccc.subModel || '';
        else if (key === 'CHATCCC_CCC_ALTERNATIVE_MODEL') val = state.config.ccc.alternativeModel || '';
        else if (key === 'CHATCCC_CCC_EFFORT') val = state.config.ccc.effort || '';
        else if (key === 'CHATCCC_CCC_MAX_OUTPUT_TOKENS') val = state.config.ccc.maxOutputTokens || '';
        else if (key === 'CHATCCC_CCC_CONTEXT_WINDOW') val = state.config.ccc.contextWindow || '1048576';
      } else if (section === 'dsh' && state.config.dsh) {
        if (key === 'CHATCCC_DSH_API_KEY') val = state.config.dsh.apiKey || '';
        else if (key === 'CHATCCC_DSH_BASE_URL') val = state.config.dsh.baseUrl || '';
        else if (key === 'CHATCCC_DSH_MODEL') val = state.config.dsh.model || '';
        else if (key === 'CHATCCC_DSH_SUB_MODEL') val = state.config.dsh.subModel || '';
        else if (key === 'CHATCCC_DSH_ALTERNATIVE_MODEL') val = state.config.dsh.alternativeModel || '';
        else if (key === 'CHATCCC_DSH_PROVIDER') val = state.config.dsh.provider || '';
        else if (key === 'CHATCCC_DSH_MAX_TOKENS') val = state.config.dsh.maxTokens || '49152';
      }
    }
    var isSecret = key.includes('SECRET') || key.includes('API_KEY');
    if (key === 'CHATCCC_WEB_UI_OPEN_ON_START' || key === 'CHATCCC_CHROME_DEVTOOLS_ENABLED' || key === 'CHATCCC_CODEX_FAST_MODE') {
      var checked = val === true || val === 'true';
      var changeHandler = key === 'CHATCCC_CHROME_DEVTOOLS_ENABLED' ? ' onchange="toggleEditChromeDevtoolsFields(this.checked)"' : '';
      html += '<div class="form-group"><label style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="edit-' + key + '"' + (checked ? ' checked' : '') + changeHandler + '> ' + (labelMap[key] || key) + '</label>';
      if (hintMap[key]) html += '<div class="hint" style="margin-top:6px;line-height:1.5">' + hintMap[key] + '</div>';
      html += '</div>';
    } else if (key === 'CHATCCC_CURSOR_AVATAR_BATTERY_MODE') {
      var modeVal = val || 'apiPercent';
      html += '<div class="form-group"><label>' + (labelMap[key] || key) + '</label>';
      html += '<select id="edit-' + key + '" onchange="onCursorBatteryModeChange(\\'edit-\\', this.value)" style="width:100%;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;outline:none">';
      html += '<option value="apiPercent"' + (modeVal === 'apiPercent' ? ' selected' : '') + '>API 使用比例</option>';
      html += '<option value="onDemandUse"' + (modeVal === 'onDemandUse' ? ' selected' : '') + '>On demand use 金额</option>';
      html += '</select></div>';
    } else if (key === 'CHATCCC_CCC_GIT_COAUTHOR') {
      var coAuthorVal = val || 'inherit';
      html += '<div class="form-group"><label>' + (labelMap[key] || key) + '</label>';
      html += '<select id="edit-' + key + '" style="width:100%;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;outline:none">';
      html += '<option value="inherit"' + (coAuthorVal === 'inherit' ? ' selected' : '') + '>跟随 DeepCCC 全局设置（默认开启）</option>';
      html += '<option value="enabled"' + (coAuthorVal === 'enabled' ? ' selected' : '') + '>强制开启</option>';
      html += '<option value="disabled"' + (coAuthorVal === 'disabled' ? ' selected' : '') + '>强制关闭</option></select>';
      if (hintMap[key]) html += '<div class="hint" style="margin-top:6px;line-height:1.5">' + hintMap[key] + '</div>';
      html += '</div>';
    } else if (key === 'CHATCCC_CCC_PROVIDER') {
      var providerVal = val || '';
      html += '<div class="form-group"><label>' + (labelMap[key] || key) + '</label>';
      html += '<select id="edit-' + key + '" style="width:100%;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;outline:none">';
      html += '<option value=""' + (providerVal === '' ? ' selected' : '') + '>跟随 DeepCCC 内核配置（默认）</option>';
      html += '<option value="openai"' + (providerVal === 'openai' ? ' selected' : '') + '>openai - OpenAI 兼容协议</option>';
      html += '<option value="anthropic"' + (providerVal === 'anthropic' ? ' selected' : '') + '>anthropic - Anthropic Messages 协议</option>';
      html += '</select>';
      if (hintMap[key]) html += '<div class="hint" style="margin-top:6px;line-height:1.5">' + hintMap[key] + '</div>';
      html += '</div>';
    } else if (key === 'CHATCCC_CCC_CONTEXT_WINDOW') {
      var cwVal = val || '1048576';
      var cwPreset = contextWindowPresetFor(cwVal);
      html += '<div class="form-group"><label>' + (labelMap[key] || key) + '</label>';
      html += '<select id="edit-' + key + '" onchange="onContextWindowPresetChange(\\'edit-\\', this.value)" style="width:100%;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;outline:none">';
      html += '<option value="1m"' + (cwPreset === '1m' ? ' selected' : '') + '>1M（1,048,576 tokens，推荐）</option>';
      html += '<option value="512k"' + (cwPreset === '512k' ? ' selected' : '') + '>512K（524,288 tokens）</option>';
      html += '<option value="256k"' + (cwPreset === '256k' ? ' selected' : '') + '>256K（262,144 tokens）</option>';
      html += '<option value="128k"' + (cwPreset === '128k' ? ' selected' : '') + '>128K（131,072 tokens）</option>';
      html += '<option value="custom"' + (cwPreset === 'custom' ? ' selected' : '') + '>自定义（单位 k）</option>';
      html += '</select>';
      html += '<div id="edit-CHATCCC_CCC_CONTEXT_WINDOW_CUSTOM_ROW" style="margin-top:6px;display:' + (cwPreset === 'custom' ? '' : 'none') + '">';
      html += '<input type="number" id="edit-CHATCCC_CCC_CONTEXT_WINDOW_CUSTOM" min="1" placeholder="例如 768 表示 768K（786,432 tokens）" style="width:100%;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;outline:none" value="' + (cwPreset === 'custom' ? Math.round(Number(cwVal) / 1024) : '') + '">';
      html += '</div>';
      if (hintMap[key]) html += '<div class="hint" style="margin-top:6px;line-height:1.5">' + hintMap[key] + '</div>';
      html += '</div>';
    } else {
      var rowId = key === 'CHATCCC_CURSOR_ON_DEMAND_MONTHLY_BUDGET'
        ? ' id="edit-cursor-on-demand-budget-row"'
        : (section === 'chromeDevtools' && key !== 'CHATCCC_CHROME_DEVTOOLS_ENABLED' ? ' id="edit-row-' + key + '"' : '');
      var isNumber = key === 'CHATCCC_CURSOR_ON_DEMAND_MONTHLY_BUDGET' || key === 'CHATCCC_CHROME_DEVTOOLS_PORT' || key === 'CHATCCC_CCC_MAX_OUTPUT_TOKENS';
      var inputType = isNumber ? 'number' : (isSecret ? 'password' : 'text');
      var attrs = key === 'CHATCCC_CURSOR_ON_DEMAND_MONTHLY_BUDGET'
        ? ' min="1" step="1"'
        : key === 'CHATCCC_CHROME_DEVTOOLS_PORT'
          ? ' min="1" max="65535" step="1" placeholder="15166"'
          : key === 'CHATCCC_CCC_MAX_OUTPUT_TOKENS'
            ? ' min="1" step="1" placeholder="留空跟随 DeepCCC 内核配置"'
          : '';
      html += '<div class="form-group"' + rowId + '><label>' + (labelMap[key] || key) + '</label>';
      html += '<input type="' + inputType + '" id="edit-' + key + '"' + attrs + ' value="' + String(val).replace(/"/g,'&quot;') + '">';
      if (hintMap[key]) html += '<div class="hint" style="margin-top:6px;line-height:1.5">' + hintMap[key] + '</div>';
      html += '</div>';
    }
  });
  // 平台类型：feishu 编辑时额外渲染下拉选择框
  if (section === 'feishu') {
    var ptVal = (state.config.platforms && state.config.platforms.feishu && state.config.platforms.feishu.platformType) || 'feishu';
    html += '<div class="form-group"><label>平台类型</label>';
    html += '<select id="edit-CHATCCC_FEISHU_PLATFORM_TYPE" style="width:100%;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;outline:none">';
    html += '<option value="feishu"' + (ptVal === 'feishu' ? ' selected' : '') + '>飞书 (open.feishu.cn)</option>';
    html += '<option value="lark"' + (ptVal === 'lark' ? ' selected' : '') + '>Lark (open.larksuite.com)</option>';
    html += '</select></div>';
  }
  document.getElementById('edit-modal-fields').innerHTML = html;
  if (section === 'ccc') {
    prefillContextWindow('edit-', (state.config.ccc && state.config.ccc.contextWindow) || 1048576);
  }
  if (section === 'cursor') {
    var editModeEl = document.getElementById('edit-CHATCCC_CURSOR_AVATAR_BATTERY_MODE');
    onCursorBatteryModeChange('edit-', editModeEl ? editModeEl.value : 'apiPercent');
  } else if (section === 'chromeDevtools') {
    var editChromeDevtoolsEnabledEl = document.getElementById('edit-CHATCCC_CHROME_DEVTOOLS_ENABLED');
    toggleEditChromeDevtoolsFields(!!(editChromeDevtoolsEnabledEl && editChromeDevtoolsEnabledEl.checked));
  }
  document.getElementById('edit-modal').classList.remove('hidden');
  document.getElementById('edit-overlay').classList.remove('hidden');
}

function closeEditModal() {
  document.getElementById('edit-modal').classList.add('hidden');
  document.getElementById('edit-overlay').classList.add('hidden');
  editSectionType = null;
}

async function saveEdit() {
  var fields;
  if (editSectionType === 'feishu') fields = FEISHU_FIELDS;
  else if (editSectionType === 'webUi') fields = WEB_UI_FIELDS;
  else if (editSectionType === 'chromeDevtools') fields = CHROME_DEVTOOLS_FIELDS;
  else fields = AGENT_FIELDS[editSectionType] || [];

  var vars = {};
  fields.forEach(function(key){
    var el = document.getElementById('edit-' + key);
    if (!el) return;
    if (key === 'CHATCCC_WEB_UI_OPEN_ON_START' || key === 'CHATCCC_CHROME_DEVTOOLS_ENABLED' || key === 'CHATCCC_CODEX_FAST_MODE') vars[key] = !!el.checked;
    else if (key === 'CHATCCC_CCC_CONTEXT_WINDOW') {
      var cw = contextWindowToTokensValue('edit-');
      if (cw !== null) vars[key] = cw;
    }
    else vars[key] = el.value.trim();
  });
  if (editSectionType === 'chromeDevtools' && !vars.CHATCCC_CHROME_DEVTOOLS_PORT) {
    vars.CHATCCC_CHROME_DEVTOOLS_PORT = '15166';
  }
  if (editSectionType === 'cursor' && vars.CHATCCC_CURSOR_AVATAR_BATTERY_MODE === 'onDemandUse' && !vars.CHATCCC_CURSOR_ON_DEMAND_MONTHLY_BUDGET) {
    vars.CHATCCC_CURSOR_ON_DEMAND_MONTHLY_BUDGET = '1000';
  }
  // 平台类型：feishu 编辑时额外采集下拉选择框的值
  if (editSectionType === 'feishu') {
    var ptEl = document.getElementById('edit-CHATCCC_FEISHU_PLATFORM_TYPE');
    if (ptEl && ptEl.value.trim()) vars['CHATCCC_FEISHU_PLATFORM_TYPE'] = ptEl.value.trim();
  }
  var result = await saveConfig(vars, { quiet: true });
  if (result.ok !== true) return;
  try {
    var fresh = await api('/api/config');
    state.config = fresh.vars || state.config;
  } catch(e) {}
  closeEditModal();
  updateDashboardUI();
  toastConfigApplyResult(result, '修改已保存');
}

// ---- Other actions ----
function reconfigure() {
  if (!confirm('这将重新打开配置向导。现有配置不会丢失。')) return;
  state.view = 'wizard';
  state.wizardStep = 1;
  // agentsEnabled 留给 renderStep2() 按已有 config 重新判定
  showWizard().catch(function(){});
}

function validateCli(tool) {
  var resultEl = document.getElementById(tool + '-validate-result');
  resultEl.innerHTML = '<span style="color:#94a3b8">检测中...</span>';
  api('/api/validate', 'POST', { tool: tool }).then(function(r){
    if (r.ok) {
      resultEl.innerHTML = '<span style="color:#16a34a">已找到: ' + r.path + ' | ' + r.error + '</span>';
    } else {
      resultEl.innerHTML = '<span style="color:#ef4444">未找到: ' + r.path + ' — ' + r.error + '</span>';
    }
  });
}

// ---- 通用 Agent 引擎：一次点击，后端自动执行全部原子安装步骤 ----
var enginePollTimers = {};
function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function(char){
    return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[char];
  });
}

function onInstallableAgentToggle(engineId, el) {
  if (!el.checked) { onAgentToggle(engineId, false); return; }
  onAgentToggle(engineId, true);
  api('/api/engines/' + encodeURIComponent(engineId) + '/status', 'GET').then(function(status){
    renderEngineStatus(engineId, status);
    if (!status.installed && !status.running) installEngine(engineId);
    else if (status.running) scheduleEnginePoll(engineId);
  }).catch(function(error){
    el.checked = false;
    onAgentToggle(engineId, false);
    toast('引擎状态查询失败: ' + String(error), 'error');
  });
}

function renderEngineStatus(engineId, status) {
  var ids = [engineId + '-engine-status', engineId + '-dashboard-engine-status'];
  var job = status.job;
  var state = job && job.state;
  var text = status.installed ? ('已安装 v' + (status.version || '未知版本')) : '未安装';
  var color = status.installed ? '#15803d' : '#64748b';
  if (state === 'running') { text = '安装中 ' + (job.percent || 0) + '%'; color = '#1d4ed8'; }
  if (state === 'failed') { text = '安装失败'; color = '#dc2626'; }
  ids.forEach(function(id){
    var el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = '<span style="color:' + color + '">' + text + '</span>' +
      (job && job.error ? '<br><span style="color:#dc2626;font-size:12px">' + escapeHtml(job.error) + '</span>' : '');
  });
  [engineId + '-engine-steps', engineId + '-dashboard-engine-steps'].forEach(function(id){
    var root = document.getElementById(id);
    if (!root) return;
    root.innerHTML = job && job.steps ? job.steps.map(function(step){
      var icon = step.state === 'completed' ? '✓' : step.state === 'failed' ? '!' : step.state === 'running' ? '●' : '○';
      return '<div class="engine-step ' + step.state + '"><span class="engine-step-icon">' + icon + '</span><span>' +
        escapeHtml(step.label + (step.message && step.message !== '等待中' ? ' · ' + step.message : '')) +
        '</span><span class="engine-step-percent">' + (step.state === 'running' ? step.percent + '%' : '') + '</span></div>';
    }).join('') : '';
  });
  [engineId + '-engine-install-btn', engineId + '-dashboard-engine-install-btn'].forEach(function(id){
    var button = document.getElementById(id);
    if (!button) return;
    button.disabled = state === 'running';
    button.textContent = state === 'running' ? '自动安装中…' : state === 'failed' ? '重试' : status.installed ? '原子升级/重新安装' : '安装并启用';
  });
}

function scheduleEnginePoll(engineId) {
  if (enginePollTimers[engineId]) clearTimeout(enginePollTimers[engineId]);
  enginePollTimers[engineId] = setTimeout(function(){ engineRefreshStatus(engineId); }, 800);
}

function engineRefreshStatus(engineId) {
  return api('/api/engines/' + encodeURIComponent(engineId) + '/status', 'GET').then(function(status){
    renderEngineStatus(engineId, status);
    if (status.running || (status.job && status.job.state === 'running')) scheduleEnginePoll(engineId);
    return status;
  }).catch(function(){ scheduleEnginePoll(engineId); });
}

function installEngine(engineId) {
  var toggle = document.getElementById('agent-enable-' + engineId);
  if (toggle && !toggle.checked) {
    toggle.checked = true;
    onAgentToggle(engineId, true);
  }
  return api('/api/engines/' + encodeURIComponent(engineId) + '/install', 'POST').then(function(result){
    if (!result.ok) throw new Error(result.error || '启动安装失败');
    renderEngineStatus(engineId, { installed: false, running: true, job: result.job });
    scheduleEnginePoll(engineId);
    return result;
  }).catch(function(error){
    renderEngineStatus(engineId, { installed: false, running: false, job: { state: 'failed', error: String(error), steps: [] } });
    toast('引擎安装失败: ' + String(error), 'error');
  });
}

// ---- Start ----
async function openDeepCccWeb() {
  try {
    var result = await api('/api/deepccc-web/start', 'POST');
    if (!result.ok) throw new Error(result.error || '启动失败');
    window.open(result.url, '_blank', 'noopener');
  } catch (error) {
    toast('DeepCCC Web 启动失败: ' + String(error), 'error');
  }
}

init();

// 页面刷新后从持久化任务文件恢复每一步的安装进度。
setTimeout(function(){ engineRefreshStatus('claude'); engineRefreshStatus('dsh'); }, 300);
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";
  const pathname = url.split("?", 1)[0];

  if (extraApiHandler && await extraApiHandler(req, res)) return;
  if (await handleAgentTeamRequest(req, res)) return;

  // API routes
  if (url === "/api/check" && method === "GET") return handleApiCheck(req, res);
  if (url === "/api/config" && method === "GET") return handleGetConfig(req, res);
  if (url === "/api/config" && method === "POST") return handlePostConfig(req, res);
  if (url === "/api/status" && method === "GET") return handleGetStatus(req, res);
  if (url === "/api/start" && method === "POST") return handleStartService(req, res);
  if (url === "/api/stop" && method === "POST") return handleStopService(req, res);
  if (url === "/api/restart" && method === "POST") return handleRestartService(req, res);
  if (url === "/api/deepccc-web/start" && method === "POST") {
    const { launchDeepCccWebProcess } = await import("../deepccc-agent/src/web-server.ts");
    const handle = await launchDeepCccWebProcess({ reuseExisting: true, openBrowser: false, defaultCwd: process.cwd() });
    return jsonReply(res, 200, { ok: true, url: handle.url, port: handle.port, reused: handle.reused });
  }
  if (url === "/api/validate" && method === "POST") return handleValidate(req, res);
  if (url === "/api/ilink/forget" && method === "POST") return handleForgetIlink(req, res);
  const engineStatusMatch = pathname.match(/^\/api\/engines\/([^/]+)\/status$/);
  if (engineStatusMatch && method === "GET") return handleEngineStatus(decodeURIComponent(engineStatusMatch[1]), res);
  const engineInstallMatch = pathname.match(/^\/api\/engines\/([^/]+)\/install$/);
  if (engineInstallMatch && method === "POST") return handleEngineInstall(decodeURIComponent(engineInstallMatch[1]), res);

  if (method === "GET" && (pathname === "/agent-team" || pathname === "/agent-team/")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(AGENT_TEAM_PAGE_HTML);
    return;
  }

  if (pathname.startsWith("/api/")) {
    jsonReply(res, 404, { error: "Not found" });
    return;
  }

  // Serve HTML page for all other GET requests
  if (method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PAGE_HTML);
    return;
  }

  jsonReply(res, 404, { error: "Not found" });
}

export function createUiRouter(): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error(`[WEB-UI] Unhandled error: ${(err as Error).message}`);
      if (!res.headersSent) jsonReply(res, 500, { error: "Internal error" });
    });
  };
}

// ---------------------------------------------------------------------------
// Setup mode entry point — called from index.ts when no credentials
// ---------------------------------------------------------------------------

/**
 * setup → service「在线切换」回调签名：
 *   - 入参 httpServer：setup 模式当前监听的 HTTP server，会被复用为 service 的
 *     relay server（避免 close + recreate 的端口竞态）。
 *   - 返回 { ok: true } 表示原地启动成功，前端会刷新进 dashboard。
 *   - 返回 { ok: false, error } 表示启动失败，前端会 toast 错误。
 *     setup HTTP server **必须仍然可用**，让用户改完 config 再试一次。
 */
export type SetupActivateHook = (
  httpServer: ReturnType<typeof createServer>,
) => Promise<{ ok: true } | { ok: false; error: string }>;

export interface StartSetupModeOptions {
  onActivate?: SetupActivateHook;
  /** 内部重启进入 setup 模式时设为 false，避免重复弹出系统浏览器。 */
  openBrowser?: boolean;
}

// setup HTTP server + onActivate 回调通过模块级变量暴露给 handleStartService。
// 一旦 onActivate 成功执行，setupActivateHook 会被清空——避免 dashboard 模式下
// 用户再点"启动"时还走 inplace 路径（service 已经在跑了）。
let setupHttpServer: ReturnType<typeof createServer> | null = null;
let setupActivateHook: SetupActivateHook | null = null;

// reload-config 回调：dashboard 模式下用户点"保存并启动"时，service 已经在跑，
// 仅需要把磁盘上刚保存的 config.json 刷进进程内的 export let 常量（live binding）。
// 由 index.ts 注入，因为 web-ui.ts 自身**不应**直接 import config.ts——后者顶层
// 有 loadConfig 副作用，被 web-ui.ts 间接 import 会污染所有依赖 web-ui.ts 的单测。
let reloadConfigHook: (() => void) | null = null;
type ExtraApiHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean> | boolean;
let extraApiHandler: ExtraApiHandler | null = null;

/**
 * 注册"reload config"回调。约定：
 * - 由 index.ts 在 main() 中一次性调用，传入 () => reloadConfigFromDisk()。
 * - handleStartService 在 path="reload" 分支会 await 调用一次；hook 抛错会被
 *   捕获并以 500 回前端，避免 service 死锁。
 */
export function setReloadConfigHook(hook: () => void | Promise<void>): void {
  reloadConfigHook = hook;
}

export function setExtraApiHandler(handler: ExtraApiHandler): void {
  extraApiHandler = handler;
}

export function startSetupMode(
  port: number,
  options: StartSetupModeOptions = {},
): ReturnType<typeof createServer> {
  const router = createUiRouter();
  const server = createServer(router);
  setupHttpServer = server;
  setupActivateHook = options.onActivate ?? null;

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`\n[WEB-UI] 端口 ${port} 已被占用。请检查是否有其他 ChatCCC 实例在运行。`);
      console.error("  可以先停止旧进程，或修改 config.json 中的 port 为其他端口。");
    } else {
      console.error(`\n[WEB-UI] HTTP 服务器错误: ${err.message}`);
    }
    process.exit(1);
  });

  server.listen(port, "127.0.0.1", () => {
    const url = buildWebUiUrl(port);
    console.log("");
    console.log("=".repeat(60));
    console.log("  ChatCCC — 首次配置向导");
    console.log("=".repeat(60));
    console.log("  未检测到已配置的飞书凭证，已启动配置界面。");
    if (options.openBrowser !== false) {
      console.log(`  已启用启动时自动打开浏览器: ${url}`);
    } else {
      console.log(`  内部重启不会自动打开浏览器，请按需访问: ${url}`);
    }
    console.log("  若浏览器未自动弹出，请手动访问上面的地址。");
    console.log("");
    console.log("  在向导里填好 App ID / App Secret 后点「保存并启动」，");
    console.log("  服务会在当前进程内直接激活，不需要重新运行 chatccc。");
    console.log("=".repeat(60));
    console.log("");
    if (options.openBrowser !== false) openWebUiInDefaultBrowser(port);
  });
  return server;
}
