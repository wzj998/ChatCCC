// =============================================================================
// web-ui.ts — Setup Wizard & Management Dashboard HTTP Server
// =============================================================================
// Serves on the same port as the WebSocket relay (18080 default).
// - Setup mode: no config.json → show setup wizard, skip Feishu connection
// - Dashboard mode: config.json exists → serve management page alongside WS relay
// =============================================================================

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, writeFile, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const CONFIG_FILE = join(PROJECT_ROOT, "config.json");
const CONFIG_SAMPLE_FILE = join(PROJECT_ROOT, "config.sample.json");
const PID_FILE = join(PROJECT_ROOT, "state", "runtime.pid");

// ---------------------------------------------------------------------------
// Helpers — config.json parsing & generation
// ---------------------------------------------------------------------------

interface AppConfig {
  feishu?: { appId?: string; appSecret?: string };
  port?: number;
  gitTimeoutSeconds?: number;
  claude?: { enabled?: boolean; model?: string; effort?: string; apiKey?: string; baseUrl?: string };
  // `command` 是已废弃的旧字段名，保留只读以兼容升级前的 config.json
  cursor?: { enabled?: boolean; path?: string; command?: string; model?: string };
  codex?: { enabled?: boolean; path?: string; command?: string; model?: string; effort?: string };
}

// ---------------------------------------------------------------------------
// Claude API 模式（"official" / "thirdparty"）
// ---------------------------------------------------------------------------
// 用户在 Wizard / Dashboard 上选择的"官方 API（Anthropic 直连）"或"第三方 API
// （自定义网关）"模式：
//   - "official" → 强制把 claude.apiKey / claude.baseUrl 视为空，永远写入 ""
//     （即使前端漏传也按此处理，作为服务端兌底）；
//   - "thirdparty" → 保留前端提交的 apiKey / baseUrl 原值，由用户填写。
//
// 这两个纯函数被前端 JS 与服务端 handlePostConfig 同时使用，单测在
// src/__tests__/web-ui.test.ts 里锁定它们的契约。

export type ClaudeApiMode = "official" | "thirdparty";

/**
 * 加载已有 config.json 时，决定 UI 应初始展现哪种模式：
 * 只要 apiKey 或 baseUrl 任一非空（trim 后），即视为第三方模式；否则官方。
 */
export function detectClaudeApiMode(
  claude: { apiKey?: string; baseUrl?: string } | undefined,
): ClaudeApiMode {
  const apiKey = (claude?.apiKey ?? "").trim();
  const baseUrl = (claude?.baseUrl ?? "").trim();
  if (apiKey || baseUrl) return "thirdparty";
  return "official";
}

/**
 * 服务端在写入 config.json 前按用户选择的模式归一化扁平 vars：
 *   - mode = "thirdparty"：保留 vars 中的 CLAUDE_API_KEY / CLAUDE_BASE_URL 原值
 *     （包括 ""——用户也可能主动清空一项）。
 *   - mode = "official" 或未传 mode：强制把 CLAUDE_API_KEY / CLAUDE_BASE_URL
 *     设为 ""，即使前端漏传这两个键也要主动加上 ""，覆盖 config.json 里旧值。
 *
 * 这里"未传 mode 默认按 official 处理"是有意为之的兌底：旧版前端可能不传
 * mode 字段，按更安全的方向（不保留可能误填的密钥）落地。
 */
export function applyClaudeApiMode(
  vars: Record<string, unknown>,
  mode: string | undefined,
): Record<string, unknown> {
  if (mode === "thirdparty") return vars;
  return { ...vars, CLAUDE_API_KEY: "", CLAUDE_BASE_URL: "" };
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
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveConfig(cfg: AppConfig): void {
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf8");
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
  const indexPath = join(PROJECT_ROOT, "src", "index.ts");
  if (!existsSync(indexPath)) {
    return { ok: false, error: `Entry not found: ${indexPath}` };
  }
  try {
    const child = spawn("npx", ["tsx", "src/index.ts"], {
      cwd: PROJECT_ROOT,
      detached: true,
      stdio: "ignore",
      shell: true,
    });
    child.unref();
    return { ok: true, pid: child.pid ?? undefined };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
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
  const hasCreds = hasConfig && (() => {
    const c = loadConfig();
    return Boolean(c.feishu?.appId?.trim() && c.feishu?.appSecret?.trim());
  })();
  jsonReply(res, 200, { hasConfig, hasCreds, configPath: CONFIG_FILE });
}

async function handleGetConfig(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const running = isServiceRunning();
  const pid = getServicePid();
  const vars = loadConfig();
  jsonReply(res, 200, { vars, running, pid });
}

async function handlePostConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readRequestBody(req);
  let updates: Record<string, unknown>;
  let claudeApiMode: string | undefined;
  try {
    const parsed = JSON.parse(body);
    updates = parsed.vars ?? {};
    // 前端可选传 claudeApiMode："official" / "thirdparty"；未传时 applyClaudeApiMode
    // 会按 official 兌底清空 apiKey/baseUrl，避免把误填的密钥落到 config.json。
    claudeApiMode = typeof parsed.claudeApiMode === "string" ? parsed.claudeApiMode : undefined;
  } catch {
    jsonReply(res, 400, { ok: false, error: "Invalid JSON" });
    return;
  }
  const normalized = applyClaudeApiMode(updates, claudeApiMode);
  const existing = loadConfig();
  // AppConfig 是闭合接口（无 index signature），但运行时本质就是 JSON 对象，
  // 这里通过 unknown 桥接到 Record 让 deepMerge 能复用；写回前断言回 AppConfig。
  const merged = deepMerge(
    existing as unknown as Record<string, unknown>,
    unflattenConfig(normalized),
  ) as AppConfig;
  try {
    saveConfig(merged);
    jsonReply(res, 200, { ok: true });
  } catch (err) {
    jsonReply(res, 500, { ok: false, error: (err as Error).message });
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
function unflattenConfig(flat: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(flat)) {
    if (key === "CHATCCC_APP_ID") {
      result.feishu = result.feishu || {};
      (result.feishu as Record<string, unknown>).appId = val;
    } else if (key === "CHATCCC_APP_SECRET") {
      result.feishu = result.feishu || {};
      (result.feishu as Record<string, unknown>).appSecret = val;
    } else if (key === "CHATCCC_PORT") {
      result.port = parseInt(val as string, 10) || 18080;
    } else if (key === "CHATCCC_GIT_TIMEOUT_SECONDS") {
      result.gitTimeoutSeconds = parseInt(val as string, 10) || 180;
    } else if (key === "CLAUDE_API_KEY") {
      result.claude = result.claude || {};
      (result.claude as Record<string, unknown>).apiKey = val;
    } else if (key === "CLAUDE_BASE_URL") {
      result.claude = result.claude || {};
      (result.claude as Record<string, unknown>).baseUrl = val;
    } else if (key === "CHATCCC_ANTHROPIC_MODEL") {
      result.claude = result.claude || {};
      (result.claude as Record<string, unknown>).model = val;
    } else if (key === "CHATCCC_ANTHROPIC_EFFORT") {
      result.claude = result.claude || {};
      (result.claude as Record<string, unknown>).effort = val;
    } else if (key === "CHATCCC_CLAUDE_ENABLED") {
      result.claude = result.claude || {};
      (result.claude as Record<string, unknown>).enabled = val === true || val === "true";
    } else if (key === "CHATCCC_CURSOR_PATH") {
      result.cursor = result.cursor || {};
      (result.cursor as Record<string, unknown>).path = val;
    } else if (key === "CHATCCC_CURSOR_MODEL") {
      result.cursor = result.cursor || {};
      (result.cursor as Record<string, unknown>).model = val;
    } else if (key === "CHATCCC_CURSOR_ENABLED") {
      result.cursor = result.cursor || {};
      (result.cursor as Record<string, unknown>).enabled = val === true || val === "true";
    } else if (key === "CHATCCC_CODEX_PATH") {
      result.codex = result.codex || {};
      (result.codex as Record<string, unknown>).path = val;
    } else if (key === "CHATCCC_CODEX_MODEL") {
      result.codex = result.codex || {};
      (result.codex as Record<string, unknown>).model = val;
    } else if (key === "CHATCCC_CODEX_EFFORT") {
      result.codex = result.codex || {};
      (result.codex as Record<string, unknown>).effort = val;
    } else if (key === "CHATCCC_CODEX_ENABLED") {
      result.codex = result.codex || {};
      (result.codex as Record<string, unknown>).enabled = val === true || val === "true";
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
    // service 已经在跑（通常就是当前进程自己）。仅把磁盘上刚保存的 config.json
    // 刷进进程内的 export let 常量，不走真重启。下次创建会话时新值即生效。
    if (!reloadConfigHook) {
      // 没注册 reload hook 视为编程错误：index.ts 必须在 main() 里调用
      // setReloadConfigHook()；返回 500 让前端有提示，避免静默"看似生效但没生效"。
      jsonReply(res, 500, {
        ok: false,
        error: "reload hook 未注册（应在 main() 调用 setReloadConfigHook）",
      });
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

async function handleRestartService(req: IncomingMessage, res: ServerResponse): Promise<void> {
  jsonReply(res, 200, { ok: true, message: "Restarting..." });
  setImmediate(() => {
    stopService();
    setTimeout(() => {
      spawnService();
    }, 1000);
  });
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

// ---------------------------------------------------------------------------
// HTML page (embedded template)
// ---------------------------------------------------------------------------

const PAGE_HTML = `<!DOCTYPE html>
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
</style>
</head>
<body>
<header>
  <h1>ChatCCC</h1>
  <span id="header-badge" class="badge badge-stopped">未启动</span>
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

    <!-- Step 1: 飞书应用（首次必填） -->
    <div id="step-1" class="card">
      <h2>飞书应用</h2>
      <p style="color:#64748b;font-size:14px;margin-bottom:16px">先填写飞书自建应用凭证。从飞书开放平台「凭证与基础信息」复制 App ID 与 App Secret。</p>

      <div class="form-group">
        <label>CHATCCC_APP_ID *</label>
        <input type="text" id="field-CHATCCC_APP_ID" placeholder="cli_xxxxxxxxxxxx">
        <div class="hint">必填</div>
      </div>
      <div class="form-group">
        <label>CHATCCC_APP_SECRET *</label>
        <input type="password" id="field-CHATCCC_APP_SECRET" placeholder="...">
        <div class="hint">必填</div>
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

        <!-- Claude 卡片 -->
        <div class="agent-card" id="agent-card-claude">
          <div class="agent-card-header">
            <input type="checkbox" class="agent-toggle" id="agent-enable-claude" onchange="onAgentToggle('claude', this.checked)">
            <div class="meta">
              <div class="name">Claude Code</div>
              <div class="desc">Anthropic Claude Agent SDK<br>官方/第三方 API 均可</div>
            </div>
          </div>
          <fieldset class="agent-body" id="agent-body-claude" disabled>
            <div class="form-group" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px 14px">
              <label style="margin-bottom:8px;font-weight:600;color:#334155">API 来源</label>
              <div style="display:flex;flex-direction:column;gap:6px">
                <label style="display:flex;align-items:center;gap:6px;font-weight:500;cursor:pointer">
                  <input type="radio" name="claude-api-mode" value="official" id="claude-api-mode-official" checked onchange="onClaudeApiModeChange('official')">
                  官方 API（Anthropic 直连）
                </label>
                <label style="display:flex;align-items:center;gap:6px;font-weight:500;cursor:pointer">
                  <input type="radio" name="claude-api-mode" value="thirdparty" id="claude-api-mode-thirdparty" onchange="onClaudeApiModeChange('thirdparty')">
                  第三方 API（自定义网关）
                </label>
              </div>
              <div class="hint" style="margin-top:6px">官方模式不需 API Key / Base URL；第三方模式需填写。<strong>切回官方后保存会清空已填的密钥。</strong></div>
            </div>

            <div id="claude-thirdparty-fields" class="hidden">
              <div class="form-group">
                <label>API Key</label>
                <input type="password" id="field-CLAUDE_API_KEY" placeholder="sk-...">
                <div class="hint">第三方网关 API 密钥，对应 <code>claude.apiKey</code></div>
              </div>
              <div class="form-group">
                <label>Base URL</label>
                <input type="text" id="field-CLAUDE_BASE_URL" placeholder="https://api.deepseek.com/anthropic">
                <div class="hint">Anthropic 兼容端点，对应 <code>claude.baseUrl</code></div>
              </div>
            </div>

            <div class="form-group">
              <label>模型</label>
              <input type="text" id="field-CHATCCC_ANTHROPIC_MODEL" placeholder="留空表示不向 SDK 传 model">
            </div>
            <div class="form-group">
              <label>思考深度 (Effort)</label>
              <input type="text" id="field-CHATCCC_ANTHROPIC_EFFORT" placeholder="留空表示不向 SDK 传 effort">
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
              <label>努力程度 (Effort)</label>
              <input type="text" id="field-CHATCCC_CODEX_EFFORT" placeholder="留空由 codex config.toml 决定">
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
      <summary>飞书应用</summary>
      <div class="section-detail">
        <div class="config-row"><span class="key">App ID</span><span class="val" id="cfg-APP_ID">-</span></div>
        <div class="config-row"><span class="key">App Secret</span><span class="val" id="cfg-APP_SECRET">-</span></div>
        <button class="btn btn-outline" style="margin-top:8px" onclick="editSection('feishu')">编辑</button>
      </div>
    </details>

    <details class="card config-section" id="dash-claude">
      <summary>Claude Agent</summary>
      <div class="section-detail">
        <div class="config-row"><span class="key">API 来源</span><span class="val" id="cfg-CLAUDE_API_MODE">-</span></div>
        <div class="config-row" id="cfg-row-CLAUDE_API_KEY"><span class="key">API Key</span><span class="val" id="cfg-CLAUDE_API_KEY">-</span></div>
        <div class="config-row" id="cfg-row-CLAUDE_BASE_URL"><span class="key">Base URL</span><span class="val" id="cfg-CLAUDE_BASE_URL">-</span></div>
        <div class="config-row"><span class="key">模型</span><span class="val" id="cfg-ANTHROPIC_MODEL">-</span></div>
        <div class="config-row"><span class="key">Effort</span><span class="val" id="cfg-ANTHROPIC_EFFORT">-</span></div>
        <button class="btn btn-outline" style="margin-top:8px" onclick="editSection('claude')">编辑</button>
      </div>
    </details>

    <details class="card config-section" id="dash-cursor">
      <summary>Cursor Agent</summary>
      <div class="section-detail">
        <div class="config-row"><span class="key">CLI 路径</span><span class="val" id="cfg-CURSOR_PATH">-</span></div>
        <div class="config-row"><span class="key">模型</span><span class="val" id="cfg-CURSOR_MODEL">-</span></div>
        <button class="btn btn-outline" style="margin-top:8px" onclick="editSection('cursor')">编辑</button>
      </div>
    </details>

    <details class="card config-section" id="dash-codex">
      <summary>Codex Agent</summary>
      <div class="section-detail">
        <div class="config-row"><span class="key">CLI 路径</span><span class="val" id="cfg-CODEX_PATH">-</span></div>
        <div class="config-row"><span class="key">模型</span><span class="val" id="cfg-CODEX_MODEL">-</span></div>
        <div class="config-row"><span class="key">Effort</span><span class="val" id="cfg-CODEX_EFFORT">-</span></div>
        <button class="btn btn-outline" style="margin-top:8px" onclick="editSection('codex')">编辑</button>
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
  // 三个 Agent 各自的启用开关；初始全 false，renderStep2() 会按已存在 config 自动打开
  agentsEnabled: { claude: false, cursor: false, codex: false },
  wizardStep: 1,
  config: {},
  running: false,
  pid: null
};

// Step 2 输入事件是否已绑（避免每次 goStep(2) 重复绑定）
var step2InputBound = false;

const AGENT_FIELDS = {
  claude: ['CLAUDE_API_KEY','CLAUDE_BASE_URL','CHATCCC_ANTHROPIC_MODEL','CHATCCC_ANTHROPIC_EFFORT'],
  cursor: ['CHATCCC_CURSOR_PATH','CHATCCC_CURSOR_MODEL'],
  codex: ['CHATCCC_CODEX_PATH','CHATCCC_CODEX_MODEL','CHATCCC_CODEX_EFFORT']
};
const FEISHU_FIELDS = ['CHATCCC_APP_ID','CHATCCC_APP_SECRET'];

// 当前选中的 Claude API 模式（"official" / "thirdparty"）
// Wizard / Dashboard 都通过这个变量驱动 UI 显隐和提交时的 mode 字段
var claudeApiMode = 'official';

// model / effort 输入框 placeholder：仅第三方模式下举例典型取值（网关五花八门，
// 示例只是引导）；官方模式不列举任何具体值，避免给出过期/不支持的取值产生误导。
var CLAUDE_MODEL_PLACEHOLDER = {
  official: '留空表示不向 SDK 传 model',
  thirdparty: 'deepseek-v4-pro'
};
var CLAUDE_EFFORT_PLACEHOLDER = {
  official: '留空表示不向 SDK 传 effort',
  thirdparty: 'low / medium / high / max（留空不向 SDK 传 effort）'
};

function onClaudeApiModeChange(mode) {
  claudeApiMode = mode;
  var thirdPartyEl = document.getElementById('claude-thirdparty-fields');
  if (thirdPartyEl) {
    thirdPartyEl.classList.toggle('hidden', mode !== 'thirdparty');
  }
  // Edit Modal 内的同名容器（如果当前打开的是 Claude 编辑模态框）
  var editThirdPartyEl = document.getElementById('edit-claude-thirdparty-fields');
  if (editThirdPartyEl) {
    editThirdPartyEl.classList.toggle('hidden', mode !== 'thirdparty');
  }
  // 同步 model / effort 输入框的 placeholder（Wizard + Edit Modal 两处都更新）
  var modelPlaceholder = CLAUDE_MODEL_PLACEHOLDER[mode] || CLAUDE_MODEL_PLACEHOLDER.official;
  var effortPlaceholder = CLAUDE_EFFORT_PLACEHOLDER[mode] || CLAUDE_EFFORT_PLACEHOLDER.official;
  var wizardModelEl = document.getElementById('field-CHATCCC_ANTHROPIC_MODEL');
  if (wizardModelEl) wizardModelEl.placeholder = modelPlaceholder;
  var editModelEl = document.getElementById('edit-CHATCCC_ANTHROPIC_MODEL');
  if (editModelEl) editModelEl.placeholder = modelPlaceholder;
  var wizardEffortEl = document.getElementById('field-CHATCCC_ANTHROPIC_EFFORT');
  if (wizardEffortEl) wizardEffortEl.placeholder = effortPlaceholder;
  var editEffortEl = document.getElementById('edit-CHATCCC_ANTHROPIC_EFFORT');
  if (editEffortEl) editEffortEl.placeholder = effortPlaceholder;
  // Claude 切换 API 模式可能改变"是否填对"的判定（第三方需要 apiKey+baseUrl）
  updateStep2NextBtn();
}

/** 切换某个 Agent 的启用状态：联动卡片高亮 + fieldset 禁用 + 下一步按钮校验 */
function onAgentToggle(agent, enabled) {
  state.agentsEnabled[agent] = enabled;
  var card = document.getElementById('agent-card-' + agent);
  if (card) card.classList.toggle('enabled', enabled);
  var body = document.getElementById('agent-body-' + agent);
  if (body) body.disabled = !enabled;
  updateStep2NextBtn();
}

/** Claude 启用时"填对"的判定：第三方模式需 apiKey + baseUrl 都非空，其他情况一律算填对 */
function isClaudeFieldsValid() {
  if (claudeApiMode !== 'thirdparty') return true;
  var apiKey = (document.getElementById('field-CLAUDE_API_KEY') || {}).value || '';
  var baseUrl = (document.getElementById('field-CLAUDE_BASE_URL') || {}).value || '';
  return Boolean(apiKey.trim() && baseUrl.trim());
}

/**
 * "下一步"按钮启用条件：至少一个 Agent 开关打开且本身填写满足要求
 * - claude：第三方模式必须 apiKey + baseUrl 都填；官方模式视为已填对
 * - cursor / codex：开关打开即视为填对（path 留空时运行时会自动探测/退回 PATH）
 */
function updateStep2NextBtn() {
  var btn = document.getElementById('btn-step2-next');
  if (!btn) return;
  var validCount = 0;
  if (state.agentsEnabled.claude && isClaudeFieldsValid()) validCount++;
  if (state.agentsEnabled.cursor) validCount++;
  if (state.agentsEnabled.codex) validCount++;
  btn.disabled = validCount === 0;
}

/** 加载已有 config 时按 detectClaudeApiMode 契约判定初始模式 */
function detectClaudeApiModeFromConfig(claude) {
  if (!claude) return 'official';
  var apiKey = (claude.apiKey || '').toString().trim();
  var baseUrl = (claude.baseUrl || '').toString().trim();
  return (apiKey || baseUrl) ? 'thirdparty' : 'official';
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
  var appId = (document.getElementById('field-CHATCCC_APP_ID').value || '').trim();
  var appSecret = (document.getElementById('field-CHATCCC_APP_SECRET').value || '').trim();
  if (!appId || !appSecret) {
    toast('请先填写飞书 App ID 和 App Secret', 'error');
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

var CLAUDE_FALLBACK_KEYS = ['apiKey','baseUrl','model','effort'];
var CURSOR_FALLBACK_KEYS = ['path','command','model'];
var CODEX_FALLBACK_KEYS = ['path','command','model','effort'];

function renderStep2() {
  var c = state.config || {};
  if (c.claude) {
    prefillNested('field-CLAUDE_API_KEY', c.claude.apiKey);
    prefillNested('field-CLAUDE_BASE_URL', c.claude.baseUrl);
    prefillNested('field-CHATCCC_ANTHROPIC_MODEL', c.claude.model);
    prefillNested('field-CHATCCC_ANTHROPIC_EFFORT', c.claude.effort);
  }
  // 按已有 apiKey/baseUrl 判定初始 API 模式，并相应显示/隐藏字段
  var initialMode = detectClaudeApiModeFromConfig(c.claude);
  var radio = document.getElementById('claude-api-mode-' + initialMode);
  if (radio) radio.checked = true;
  onClaudeApiModeChange(initialMode);
  if (c.cursor) {
    prefillNested('field-CHATCCC_CURSOR_PATH', c.cursor.path || c.cursor.command);
    prefillNested('field-CHATCCC_CURSOR_MODEL', c.cursor.model);
  }
  if (c.codex) {
    prefillNested('field-CHATCCC_CODEX_PATH', c.codex.path || c.codex.command);
    prefillNested('field-CHATCCC_CODEX_MODEL', c.codex.model);
    prefillNested('field-CHATCCC_CODEX_EFFORT', c.codex.effort);
  }

  // 按已有 config 决定每个 Agent 默认是否开启：优先 enabled 字段，缺省时按"任一字段非空"
  var claudeOn = isAgentEnabled(c.claude, CLAUDE_FALLBACK_KEYS);
  var cursorOn = isAgentEnabled(c.cursor, CURSOR_FALLBACK_KEYS);
  var codexOn = isAgentEnabled(c.codex, CODEX_FALLBACK_KEYS);
  document.getElementById('agent-enable-claude').checked = claudeOn;
  document.getElementById('agent-enable-cursor').checked = cursorOn;
  document.getElementById('agent-enable-codex').checked = codexOn;
  onAgentToggle('claude', claudeOn);
  onAgentToggle('cursor', cursorOn);
  onAgentToggle('codex', codexOn);

  // Cursor path placeholder/hint：把已探测到的路径显示为占位
  var hint = document.getElementById('cursor-path-hint');
  var detected = c.cursor && (c.cursor.path || c.cursor.command);
  if (detected) {
    var inp = document.getElementById('field-CHATCCC_CURSOR_PATH');
    if (inp && !inp.value) inp.placeholder = detected;
    if (hint) hint.textContent = '已自动探测到';
  }

  // 字段输入时实时刷新"下一步"按钮（Claude 第三方模式 apiKey/baseUrl 必填）
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
 * - 三个 Agent 的 enabled 状态都显式下发，让 config.json 持久化用户的最新开关偏好
 * - Agent 字段仅在该 Agent 开关启用时收集；未启用的 Agent 不下发其它字段，
 *   服务端 deepMerge 会保留 config.json 中已有值（避免关闭开关时误清空旧配置）
 * - Claude 启用且当前 mode=official 时显式置空 apiKey/baseUrl，覆盖 config.json 旧值
 */
function collectAllFields() {
  var vars = {};
  FEISHU_FIELDS.forEach(function(key){
    var el = document.getElementById('field-' + key);
    if (el && el.value.trim()) vars[key] = el.value.trim();
  });
  vars.CHATCCC_CLAUDE_ENABLED = !!state.agentsEnabled.claude;
  vars.CHATCCC_CURSOR_ENABLED = !!state.agentsEnabled.cursor;
  vars.CHATCCC_CODEX_ENABLED = !!state.agentsEnabled.codex;
  if (state.agentsEnabled.claude) {
    AGENT_FIELDS.claude.forEach(function(key){
      var el = document.getElementById('field-' + key);
      if (el && el.value.trim()) vars[key] = el.value.trim();
    });
    if (claudeApiMode !== 'thirdparty') {
      vars.CLAUDE_API_KEY = '';
      vars.CLAUDE_BASE_URL = '';
    }
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
      if (el && el.value.trim()) vars[key] = el.value.trim();
    });
  }
  return vars;
}

function renderStep3() {
  var vars = collectAllFields();
  var lines = [];
  lines.push('<h3 style="margin-bottom:8px">飞书应用</h3>');
  lines.push('<div class="config-row"><span class="key">CHATCCC_APP_ID</span><span class="val">' + (vars.CHATCCC_APP_ID || '<span style="color:#ef4444">未填写</span>') + '</span></div>');
  lines.push('<div class="config-row"><span class="key">CHATCCC_APP_SECRET</span><span class="val">' + (vars.CHATCCC_APP_SECRET ? '***已设置***' : '<span style="color:#ef4444">未填写</span>') + '</span></div>');

  lines.push('<h3 style="margin:16px 0 8px">已启用的 AI Agent</h3>');
  var enabledList = [];
  if (state.agentsEnabled.claude) enabledList.push('claude');
  if (state.agentsEnabled.cursor) enabledList.push('cursor');
  if (state.agentsEnabled.codex) enabledList.push('codex');
  if (enabledList.length === 0) {
    lines.push('<div style="color:#ef4444">未启用任何 AI Agent</div>');
  }
  enabledList.forEach(function(t){
    if (t === 'claude') {
      lines.push('<h4 style="margin:10px 0 4px;color:#334155">Claude Code</h4>');
      var modeLabel = claudeApiMode === 'thirdparty' ? '第三方 API（自定义网关）' : '官方 API（Anthropic 直连）';
      lines.push('<div class="config-row"><span class="key">API 来源</span><span class="val">' + modeLabel + '</span></div>');
      if (claudeApiMode === 'thirdparty') {
        lines.push('<div class="config-row"><span class="key">API Key</span><span class="val">' + (vars.CLAUDE_API_KEY ? '***已设置***' : '(未设置)') + '</span></div>');
        if (vars.CLAUDE_BASE_URL) lines.push('<div class="config-row"><span class="key">Base URL</span><span class="val">' + vars.CLAUDE_BASE_URL + '</span></div>');
      }
      lines.push('<div class="config-row"><span class="key">模型</span><span class="val">' + (vars.CHATCCC_ANTHROPIC_MODEL || '(留空)') + '</span></div>');
      lines.push('<div class="config-row"><span class="key">Effort</span><span class="val">' + (vars.CHATCCC_ANTHROPIC_EFFORT || '(留空)') + '</span></div>');
    } else if (t === 'cursor') {
      lines.push('<h4 style="margin:10px 0 4px;color:#334155">Cursor</h4>');
      if (vars.CHATCCC_CURSOR_PATH) lines.push('<div class="config-row"><span class="key">CLI 路径</span><span class="val">' + vars.CHATCCC_CURSOR_PATH + '</span></div>');
      lines.push('<div class="config-row"><span class="key">模型</span><span class="val">' + (vars.CHATCCC_CURSOR_MODEL || '(留空)') + '</span></div>');
    } else if (t === 'codex') {
      lines.push('<h4 style="margin:10px 0 4px;color:#334155">Codex</h4>');
      if (vars.CHATCCC_CODEX_PATH) lines.push('<div class="config-row"><span class="key">CLI 路径</span><span class="val">' + vars.CHATCCC_CODEX_PATH + '</span></div>');
      lines.push('<div class="config-row"><span class="key">模型</span><span class="val">' + (vars.CHATCCC_CODEX_MODEL || '(留空)') + '</span></div>');
      lines.push('<div class="config-row"><span class="key">Effort</span><span class="val">' + (vars.CHATCCC_CODEX_EFFORT || '(留空)') + '</span></div>');
    }
  });
  document.getElementById('review-content').innerHTML = lines.join('');
}

async function saveConfig(vars) {
  // 同时把当前 claudeApiMode 传给服务端：服务端 applyClaudeApiMode() 会按
  // mode 强制清空 apiKey/baseUrl（即使前端 vars 没传也会兌底，详见 web-ui.test.ts）。
  //
  // 当 wizard 中 claude 开关未启用时，前端不打算修改 claude 的任何字段——但服务端
  // 默认按 official 兌底会清空 apiKey/baseUrl。这里按"当前 config 的模式"上送，
  // 让已存在的 thirdparty 凭证保留不被清空。
  var modeToSend = claudeApiMode;
  if (state.view === 'wizard' && state.agentsEnabled && state.agentsEnabled.claude === false) {
    modeToSend = detectClaudeApiModeFromConfig(state.config && state.config.claude);
  }
  var result = await api('/api/config', 'POST', { vars: vars, claudeApiMode: modeToSend });
  if (result.ok) {
    state.config = Object.assign({}, state.config, vars);
    toast('配置已保存');
  } else {
    toast('保存失败: ' + (result.error || '未知错误'), 'error');
  }
  return result.ok;
}

async function saveAndStart() {
  var vars = collectAllFields();
  if (!vars.CHATCCC_APP_ID || !vars.CHATCCC_APP_SECRET) {
    toast('请先填写飞书 App ID 和 App Secret', 'error');
    return;
  }
  var ok = await saveConfig(vars);
  if (!ok) return;
  document.getElementById('btn-save-start').disabled = true;
  document.getElementById('btn-save-start').innerHTML = '<span class="spinner"></span> 应用中...';
  var result = await api('/api/start', 'POST');
  if (result.ok) {
    // 后端按 mode 区分场景，前端给出更贴切的 toast：
    //   - inplace：setup → service 首次激活，进程内启动飞书 service
    //   - reload ：service 已经在跑，仅刷新进程内 config（不真重启）
    //   - spawn  ：旧 service 已退出，spawn 新子进程
    var msg;
    if (result.mode === 'reload') {
      msg = '配置已保存并生效（无须重启）';
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
  document.getElementById('cfg-APP_ID').textContent = c.feishu && c.feishu.appId ? c.feishu.appId.slice(0,8) + '...' + c.feishu.appId.slice(-4) : '-';
  document.getElementById('cfg-APP_SECRET').textContent = c.feishu && c.feishu.appSecret ? '***已设置***' : '-';

  // 只显示已启用的 Agent 卡片（按 enabled 字段；缺省时退回到"任一字段非空"兼容旧 config）
  var claudeOn = isAgentEnabled(c.claude, CLAUDE_FALLBACK_KEYS);
  var cursorOn = isAgentEnabled(c.cursor, CURSOR_FALLBACK_KEYS);
  var codexOn = isAgentEnabled(c.codex, CODEX_FALLBACK_KEYS);
  document.getElementById('dash-claude').style.display = claudeOn ? '' : 'none';
  document.getElementById('dash-cursor').style.display = cursorOn ? '' : 'none';
  document.getElementById('dash-codex').style.display = codexOn ? '' : 'none';
  // 三个都未启用时给一个空态提示，引导用户去配置向导启用
  var emptyHint = document.getElementById('dash-no-agent-hint');
  if (emptyHint) emptyHint.style.display = (!claudeOn && !cursorOn && !codexOn) ? '' : 'none';

  // 按 detectClaudeApiMode 的契约判定 API 来源（apiKey/baseUrl 任一非空 → 第三方）
  var claudeApiKey = (c.claude && c.claude.apiKey ? String(c.claude.apiKey) : '').trim();
  var claudeBaseUrl = (c.claude && c.claude.baseUrl ? String(c.claude.baseUrl) : '').trim();
  var isThirdPartyClaude = !!(claudeApiKey || claudeBaseUrl);
  document.getElementById('cfg-CLAUDE_API_MODE').textContent = isThirdPartyClaude ? '第三方 API（自定义网关）' : '官方 API（Anthropic 直连）';
  // 官方模式下 API Key / Base URL 行整体隐藏，避免显示无意义的 "-"
  document.getElementById('cfg-row-CLAUDE_API_KEY').style.display = isThirdPartyClaude ? '' : 'none';
  document.getElementById('cfg-row-CLAUDE_BASE_URL').style.display = isThirdPartyClaude ? '' : 'none';
  document.getElementById('cfg-CLAUDE_API_KEY').textContent = claudeApiKey ? '***已设置***' : '-';
  document.getElementById('cfg-CLAUDE_BASE_URL').textContent = claudeBaseUrl || '-';
  document.getElementById('cfg-ANTHROPIC_MODEL').textContent = (c.claude && c.claude.model) || '(留空)';
  document.getElementById('cfg-ANTHROPIC_EFFORT').textContent = (c.claude && c.claude.effort) || '(留空)';
  document.getElementById('cfg-CURSOR_PATH').textContent = (c.cursor && (c.cursor.path || c.cursor.command)) || '-';
  document.getElementById('cfg-CURSOR_MODEL').textContent = (c.cursor && c.cursor.model) || '(留空)';
  document.getElementById('cfg-CODEX_PATH').textContent = (c.codex && (c.codex.path || c.codex.command)) || 'codex';
  document.getElementById('cfg-CODEX_MODEL').textContent = (c.codex && c.codex.model) || '(留空)';
  document.getElementById('cfg-CODEX_EFFORT').textContent = (c.codex && c.codex.effort) || '(留空)';
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
  await api('/api/start', 'POST');
  // Wait and refresh
  setTimeout(async function(){
    var s = await api('/api/status');
    state.running = s.running;
    state.pid = s.pid;
    updateDashboardUI();
    document.getElementById('btn-restart').disabled = false;
    document.getElementById('btn-restart').textContent = '重启';
  }, 2000);
}

// ---- Edit Modal ----
var editSectionType = null;

function editSection(section) {
  editSectionType = section;
  var fields;
  if (section === 'feishu') fields = FEISHU_FIELDS;
  else fields = AGENT_FIELDS[section] || [];

  var titleMap = { feishu: '飞书应用', claude: 'Claude Agent', cursor: 'Cursor Agent', codex: 'Codex Agent' };
  document.getElementById('edit-modal-title').textContent = '编辑 ' + (titleMap[section] || section);

  var html = '';
  var labelMap = {
    'CHATCCC_APP_ID': 'App ID', 'CHATCCC_APP_SECRET': 'App Secret',
    'CLAUDE_API_KEY': 'API Key', 'CLAUDE_BASE_URL': 'Base URL',
    'CHATCCC_ANTHROPIC_MODEL': '模型', 'CHATCCC_ANTHROPIC_EFFORT': 'Effort',
    'CHATCCC_CURSOR_PATH': 'CLI 路径', 'CHATCCC_CURSOR_MODEL': '模型',
    'CHATCCC_CODEX_PATH': 'CLI 路径', 'CHATCCC_CODEX_MODEL': '模型', 'CHATCCC_CODEX_EFFORT': 'Effort'
  };

  // Claude Agent 编辑：先按当前 config 决定初始 mode，并在 modal 顶部插入切换器；
  // 把 API Key / Base URL 的输入框装进同一个 .hidden 容器，按 mode 显隐与 Wizard 一致。
  if (section === 'claude') {
    var initialMode = detectClaudeApiModeFromConfig(state.config && state.config.claude);
    claudeApiMode = initialMode;
    html += '<div class="form-group" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px 14px">';
    html += '  <label style="margin-bottom:8px;font-weight:600;color:#334155">API 来源</label>';
    html += '  <div style="display:flex;gap:18px;flex-wrap:wrap">';
    html += '    <label style="display:flex;align-items:center;gap:6px;font-weight:500;cursor:pointer">';
    html += '      <input type="radio" name="edit-claude-api-mode" value="official"' + (initialMode === 'official' ? ' checked' : '') + ' onchange="onClaudeApiModeChange(\\'official\\')">';
    html += '      官方 API（Anthropic 直连）';
    html += '    </label>';
    html += '    <label style="display:flex;align-items:center;gap:6px;font-weight:500;cursor:pointer">';
    html += '      <input type="radio" name="edit-claude-api-mode" value="thirdparty"' + (initialMode === 'thirdparty' ? ' checked' : '') + ' onchange="onClaudeApiModeChange(\\'thirdparty\\')">';
    html += '      第三方 API（自定义网关）';
    html += '    </label>';
    html += '  </div>';
    html += '  <div class="hint" style="margin-top:6px">切回官方模式后保存，已填的密钥会被清空。</div>';
    html += '</div>';
  }

  var thirdPartyOpened = false;
  fields.forEach(function(key){
    var val = state.config[key] || '';
    // Also check nested config
    if (!val) {
      if (section === 'feishu') {
        if (key === 'CHATCCC_APP_ID' && state.config.feishu) val = state.config.feishu.appId || '';
        else if (key === 'CHATCCC_APP_SECRET' && state.config.feishu) val = state.config.feishu.appSecret || '';
      } else if (section === 'claude' && state.config.claude) {
        if (key === 'CLAUDE_API_KEY') val = state.config.claude.apiKey || '';
        else if (key === 'CLAUDE_BASE_URL') val = state.config.claude.baseUrl || '';
        else if (key === 'CHATCCC_ANTHROPIC_MODEL') val = state.config.claude.model || '';
        else if (key === 'CHATCCC_ANTHROPIC_EFFORT') val = state.config.claude.effort || '';
      } else if (section === 'cursor' && state.config.cursor) {
        if (key === 'CHATCCC_CURSOR_PATH') val = state.config.cursor.path || state.config.cursor.command || '';
        else if (key === 'CHATCCC_CURSOR_MODEL') val = state.config.cursor.model || '';
      } else if (section === 'codex' && state.config.codex) {
        if (key === 'CHATCCC_CODEX_PATH') val = state.config.codex.path || state.config.codex.command || '';
        else if (key === 'CHATCCC_CODEX_MODEL') val = state.config.codex.model || '';
        else if (key === 'CHATCCC_CODEX_EFFORT') val = state.config.codex.effort || '';
      }
    }
    var isSecret = key.includes('SECRET') || key.includes('API_KEY');
    var isClaudeThirdPartyField = section === 'claude' && (key === 'CLAUDE_API_KEY' || key === 'CLAUDE_BASE_URL');

    if (isClaudeThirdPartyField && !thirdPartyOpened) {
      html += '<div id="edit-claude-thirdparty-fields"' + (claudeApiMode === 'thirdparty' ? '' : ' class="hidden"') + '>';
      thirdPartyOpened = true;
    }

    html += '<div class="form-group"><label>' + (labelMap[key] || key) + '</label>';
    html += '<input type="' + (isSecret ? 'password' : 'text') + '" id="edit-' + key + '" value="' + String(val).replace(/"/g,'&quot;') + '">';
    html += '</div>';
  });

  if (thirdPartyOpened) html += '</div>';

  document.getElementById('edit-modal-fields').innerHTML = html;
  document.getElementById('edit-modal').classList.remove('hidden');
  document.getElementById('edit-overlay').classList.remove('hidden');

  // Edit Modal 的 input 是 innerHTML 现写入的，需要在 DOM 就绪后再触发一次同步：
  // 让 model 输入框的 placeholder / 第三方字段容器的显隐状态，跟当前 claudeApiMode 对齐。
  if (section === 'claude') onClaudeApiModeChange(claudeApiMode);
}

function closeEditModal() {
  document.getElementById('edit-modal').classList.add('hidden');
  document.getElementById('edit-overlay').classList.add('hidden');
  editSectionType = null;
}

async function saveEdit() {
  var fields;
  if (editSectionType === 'feishu') fields = FEISHU_FIELDS;
  else fields = AGENT_FIELDS[editSectionType] || [];

  var vars = {};
  fields.forEach(function(key){
    var el = document.getElementById('edit-' + key);
    if (el) vars[key] = el.value.trim();
  });
  // 编辑 Claude 时按当前 mode 强制清空 apiKey/baseUrl（与 collectAllFields 保持一致）；
  // 服务端 applyClaudeApiMode 也会兌底，但这里前端先做能让 state.config 立即同步。
  if (editSectionType === 'claude' && claudeApiMode !== 'thirdparty') {
    vars.CLAUDE_API_KEY = '';
    vars.CLAUDE_BASE_URL = '';
  }
  await saveConfig(vars);
  closeEditModal();
  // 本地 state.config.claude 也按 mode 同步清空，避免 dashboard UI 残留旧值
  if (editSectionType === 'claude' && claudeApiMode !== 'thirdparty') {
    state.config.claude = state.config.claude || {};
    state.config.claude.apiKey = '';
    state.config.claude.baseUrl = '';
  }
  updateDashboardUI();
  toast('修改已保存。若服务正在运行，需重启生效。');
}

// ---- Other actions ----
function reconfigure() {
  if (!confirm('这将重新打开配置向导。现有配置不会丢失。')) return;
  state.view = 'wizard';
  state.wizardStep = 1;
  // agentsEnabled / claudeApiMode 都留给 renderStep2() 按已有 config 重新判定
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

// ---- Start ----
init();
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  // API routes
  if (url === "/api/check" && method === "GET") return handleApiCheck(req, res);
  if (url === "/api/config" && method === "GET") return handleGetConfig(req, res);
  if (url === "/api/config" && method === "POST") return handlePostConfig(req, res);
  if (url === "/api/status" && method === "GET") return handleGetStatus(req, res);
  if (url === "/api/start" && method === "POST") return handleStartService(req, res);
  if (url === "/api/stop" && method === "POST") return handleStopService(req, res);
  if (url === "/api/validate" && method === "POST") return handleValidate(req, res);

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
 * 跨平台调起本地浏览器。
 * - Windows：cmd /c start "" <url>。注意 start 把第一个被引号包裹的参数当成"窗口标题"，
 *   所以这里需要传一个空标题占位，否则当 url 被引号包住时它会被错误地当成标题。
 * - macOS：open <url>
 * - Linux：xdg-open <url>
 *
 * 任何失败都不抛——主流程不依赖浏览器是否真的弹起来，console 已经打印了 url。
 */
function openInBrowser(url: string): void {
  try {
    if (process.platform === "win32") {
      const child = spawn("cmd.exe", ["/c", "start", "", url], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.on("error", () => { /* 浏览器未弹起来不影响主流程 */ });
      child.unref();
    } else if (process.platform === "darwin") {
      const child = spawn("open", [url], { detached: true, stdio: "ignore" });
      child.on("error", () => {});
      child.unref();
    } else {
      const child = spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
      child.on("error", () => {});
      child.unref();
    }
  } catch (err) {
    console.error(`[WEB-UI] 自动打开浏览器失败: ${(err as Error).message}`);
  }
}

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

/**
 * 注册"reload config"回调。约定：
 * - 由 index.ts 在 main() 中一次性调用，传入 () => reloadConfigFromDisk()。
 * - handleStartService 在 path="reload" 分支会 await 调用一次；hook 抛错会被
 *   捕获并以 500 回前端，避免 service 死锁。
 */
export function setReloadConfigHook(hook: () => void | Promise<void>): void {
  reloadConfigHook = hook;
}

export function startSetupMode(port: number, options: StartSetupModeOptions = {}): void {
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
    const url = `http://127.0.0.1:${port}`;
    console.log("");
    console.log("=".repeat(60));
    console.log("  ChatCCC — 首次配置向导");
    console.log("=".repeat(60));
    console.log("  未检测到已配置的飞书凭证，已启动配置界面。");
    console.log(`  正在自动打开浏览器: ${url}`);
    console.log("  若浏览器未自动弹出，请手动访问上面的地址。");
    console.log("");
    console.log("  在向导里填好 App ID / App Secret 后点「保存并启动」，");
    console.log("  服务会在当前进程内直接激活，不需要重新运行 chatccc。");
    console.log("=".repeat(60));
    console.log("");
    openInBrowser(url);
  });
}