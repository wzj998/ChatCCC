import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";

import { printServiceDidNotStart } from "./exit-banner.ts";
import { appendStartupTrace, setupFileLogging } from "./shared.ts";

// ---------------------------------------------------------------------------
// Paths & logging
// ---------------------------------------------------------------------------

export const __dirname = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = join(__dirname, "..");
export const PID_FILE = join(PROJECT_ROOT, ".claude", "runtime.pid");

export const LOG_DIR = join(PROJECT_ROOT, "logs");
export const fileLog = setupFileLogging(LOG_DIR, "index");

export const CHAT_LOGS_DIR = join(PROJECT_ROOT, ".claude", "chat_logs");

export async function appendChatLog(chatId: string, sender: string, text: string): Promise<void> {
  try {
    await mkdir(CHAT_LOGS_DIR, { recursive: true });
    const line = JSON.stringify({ ts: Date.now(), sender, text: text.slice(0, 200) }) + "\n";
    await appendFile(join(CHAT_LOGS_DIR, `${chatId}.jsonl`), line);
  } catch {
    // 静默失败，不影响主流程
  }
}

// ---------------------------------------------------------------------------
// Environment & config
// ---------------------------------------------------------------------------

export const USE_LOCAL = process.argv.includes("--local");
export const APP_ID: string = process.env.CHATCCC_APP_ID ?? "";
export const APP_SECRET: string = process.env.CHATCCC_APP_SECRET ?? "";

/** 当前工作目录下的 .env（全局 chatccc 会尝试用 tsx --env-file 加载此文件） */
export const ENV_FILE_CWD = join(process.cwd(), ".env");

export const BASE_URL = "https://open.feishu.cn/open-apis";

export const CHATCCC_PORT = parseInt(process.env.CHATCCC_PORT?.trim() ?? "18080", 10);

/** 与 CHATCCC_PORT 一致，供 --local 连接本机中继 */
export const LOCAL_RELAY_URL = `ws://127.0.0.1:${CHATCCC_PORT}`;

/** 未设置时为 `default`；不区分大小写的 `default` 表示交给 SDK/CLI，调用时不传对应字段 */
export function isSdkAnthropicDefault(value: string): boolean {
  return value.trim().toLowerCase() === "default";
}

/** 状态展示用：default 族一律显示为小写 `default` */
export function anthropicConfigDisplay(value: string): string {
  return isSdkAnthropicDefault(value) ? "default" : value;
}

export const CLAUDE_MODEL = process.env.CHATCCC_ANTHROPIC_MODEL?.trim() || "default";

export const CLAUDE_EFFORT = process.env.CHATCCC_ANTHROPIC_EFFORT?.trim() || "default";

/** 探测 cursor-agent 安装路径（优先环境变量，其次 LocalAppData，最后默认 agent） */
function detectCursorAgent(): string {
  if (process.env.CHATCCC_CURSOR_COMMAND?.trim()) return process.env.CHATCCC_CURSOR_COMMAND.trim();
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const defaultPath = join(localAppData, "cursor-agent", "agent.cmd");
    if (existsSync(defaultPath)) return defaultPath;
  }
  return "agent";
}
export const CURSOR_AGENT_COMMAND = detectCursorAgent();
/** Cursor agent 参数：-p 非交互模式，stream-json 流式 JSONL 输出 */
export const CURSOR_AGENT_ARGS = (process.env.CHATCCC_CURSOR_ARGS?.trim() || "-p --output-format stream-json --stream-partial-output").split(/\s+/).filter(Boolean);

// 新建会话的默认工作路径（/cd 命令设置，持久化到本地文件）
// 该路径仅影响通过 /new 新建的会话，不影响已有会话的 resume。
export const DEFAULT_CWD_FILE = join(PROJECT_ROOT, ".claude", "working_dir.txt");

/** 会话工具类型持久化文件 */
export const SESSIONS_FILE = join(PROJECT_ROOT, ".claude", "sessions.json");

/** 最近成功新建会话的工作路径记录（最多 10 条） */
export const RECENT_DIRS_FILE = join(PROJECT_ROOT, ".claude", "recent_dirs.json");
export const MAX_RECENT_DIRS = 10;

/** 读取最近使用过的工作路径列表（最新的在前） */
export async function getRecentDirs(): Promise<string[]> {
  try {
    const raw = await readFile(RECENT_DIRS_FILE, "utf-8");
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr.filter((d: unknown) => typeof d === "string");
  } catch { /* file doesn't exist or corrupted */ }
  return [];
}

/** 添加一个路径到最近使用列表（去重、限制数量、最新的在前） */
export async function addRecentDir(dir: string): Promise<void> {
  const dirs = await getRecentDirs();
  const filtered = dirs.filter(d => d !== dir);
  filtered.unshift(dir);
  const trimmed = filtered.slice(0, MAX_RECENT_DIRS);
  try {
    await mkdir(dirname(RECENT_DIRS_FILE), { recursive: true });
    await writeFile(RECENT_DIRS_FILE, JSON.stringify(trimmed, null, 2), "utf-8");
  } catch (err) {
    console.error(`[${ts()}] Failed to save recent_dirs.json: ${(err as Error).message}`);
    fileLog.flush();
  }
}

/** 读取 /cd 设置的默认工作路径。若文件不存在或路径已失效，回退到用户主目录。 */
export async function getDefaultCwd(): Promise<string> {
  try {
    const content = await readFile(DEFAULT_CWD_FILE, "utf-8");
    const dir = content.trim();
    if (dir) {
      try {
        const s = await stat(dir);
        if (s.isDirectory()) return dir;
      } catch { /* path gone, fall through */ }
    }
  } catch { /* file doesn't exist yet */ }
  // 用户未通过 /cd 设置过工作路径时，回退到操作系统用户主目录
  // Windows: C:\Users\<用户名>   Linux: /home/<用户名>
  return homedir();
}

/** 设置新建会话的默认工作路径（由 /cd 命令调用） */
export async function setDefaultCwd(dir: string): Promise<void> {
  await writeFile(DEFAULT_CWD_FILE, dir, "utf-8");
}

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

export function ts(): string {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

/** 仅用于日志确认「已读到某个 App」，不泄露 Secret */
export function maskAppId(id: string): string {
  if (!id) return "(空)";
  if (id.length <= 10) return `${id.slice(0, 4)}***`;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

/**
 * 启动时逐项说明环境变量：成功=已从进程环境读入非空值；失败=必填缺失；默认=未设置则使用内置默认。
 * （.env 需由 tsx --env-file 或系统注入到 process.env 后才算「已读入」。）
 */
export function reportEnvironmentVariableReadout(): void {
  const get = (key: string): string => process.env[key]?.trim() ?? "";

  const rawId = get("CHATCCC_APP_ID");
  const rawSecret = get("CHATCCC_APP_SECRET");
  const rawPort = process.env.CHATCCC_PORT?.trim();
  const rawModel = process.env.CHATCCC_ANTHROPIC_MODEL?.trim();
  const rawEffort = process.env.CHATCCC_ANTHROPIC_EFFORT?.trim();

  const portBad =
    rawPort !== undefined &&
    rawPort !== "" &&
    (Number.isNaN(CHATCCC_PORT) || CHATCCC_PORT < 1 || CHATCCC_PORT > 65535);

  const row = (label: string, name: string, kind: "必填" | "可选", ok: boolean, detail: string): void => {
    const state = ok ? "成功" : "失败";
    console.log(`  [${state}] [${kind}] ${name}`);
    console.log(`         ${label}: ${detail}`);
  };

  console.log("  --- 环境变量读取结果（成功=已读入；失败=必填缺失或格式错误；默认=未设置则用内置值）---");

  const envExists = existsSync(ENV_FILE_CWD);
  console.log(
    `  [信息] 工作目录下 .env: ${envExists ? "存在" : "不存在"} → ${ENV_FILE_CWD}`
  );
  if (!envExists) {
    console.log(
      "         若使用全局 chatccc：当前目录无 .env 时不会自动加载；请 cd 到含 .env 的目录或设置系统环境变量。"
    );
  }

  row(
    "飞书应用",
    "CHATCCC_APP_ID",
    "必填",
    Boolean(rawId),
    rawId ? `已读入，摘要 ${maskAppId(rawId)}` : "未读入或为空"
  );
  row(
    "飞书应用",
    "CHATCCC_APP_SECRET",
    "必填",
    Boolean(rawSecret),
    rawSecret ? "已读入（内容不在日志中显示）" : "未读入或为空"
  );

  if (portBad) {
    row("监听端口", "CHATCCC_PORT", "可选", false, `值无效 "${rawPort}"，解析得到 ${CHATCCC_PORT}，请填写 1–65535 的整数`);
  } else if (rawPort) {
    row("监听端口", "CHATCCC_PORT", "可选", true, `已读入，使用 ${CHATCCC_PORT}`);
  } else {
    console.log(`  [默认] [可选] CHATCCC_PORT`);
    console.log(`         监听端口: 未在环境中设置，使用内置默认 ${CHATCCC_PORT}`);
  }

  if (rawModel) {
    row("Claude 模型", "CHATCCC_ANTHROPIC_MODEL", "可选", true, `已读入 → ${rawModel}`);
  } else {
    console.log(`  [默认] [可选] CHATCCC_ANTHROPIC_MODEL`);
    console.log(
      `         Claude 模型: 未设置 → ${anthropicConfigDisplay(CLAUDE_MODEL)}（不区分大小写的 default 时不传入 SDK）`
    );
  }

  if (rawEffort) {
    row("思考深度", "CHATCCC_ANTHROPIC_EFFORT", "可选", true, `已读入 → ${rawEffort}`);
  } else {
    console.log(`  [默认] [可选] CHATCCC_ANTHROPIC_EFFORT`);
    console.log(
      `         思考深度: 未设置 → ${anthropicConfigDisplay(CLAUDE_EFFORT)}（不区分大小写的 default 时不传入 SDK）`
    );
  }

  console.log("  ------------------------------------------------------------------");
}

/** 飞书凭证缺失时打印可操作的说明并退出 */
export function explainMissingFeishuCredentialsAndExit(): never {
  appendStartupTrace("explainMissingFeishuCredentialsAndExit: exiting", {
    hasAppId: Boolean(APP_ID.trim()),
    hasAppSecret: Boolean(APP_SECRET.trim()),
  });
  const hasEnvFile = existsSync(ENV_FILE_CWD);
  const missing: string[] = [];
  if (!APP_ID.trim()) missing.push("CHATCCC_APP_ID");
  if (!APP_SECRET.trim()) missing.push("CHATCCC_APP_SECRET");

  console.error("\n" + "=".repeat(64));
  console.error("  ChatCCC 启动失败：飞书应用凭证未就绪");
  console.error("=".repeat(64));
  console.error("\n【失败步骤】环境与变量检查（在连接飞书之前）");
  console.error(`\n【未配置的环境变量】\n  - ${missing.join("\n  - ")}`);
  console.error(`\n【当前工作目录】\n  ${process.cwd()}`);
  console.error(`\n【.env 文件】\n  路径: ${ENV_FILE_CWD}`);
  if (hasEnvFile) {
    console.error(
      "  状态: 文件存在，但上述变量仍为空。请打开 .env 检查：\n" +
        "    - 变量名是否完全一致（区分大小写）\n" +
        "    - 等号两侧不要加引号除非值里需要\n" +
        "    - 保存为 UTF-8，避免错误编码\n" +
        "    - 若用全局命令 chatccc：必须在放 .env 的目录下执行（先 cd 到项目根）"
    );
  } else {
    console.error(
      "  状态: 文件不存在。\n" +
        "  处理: 复制 .env.example 为 .env 并填入飞书开放平台的 App ID / App Secret；\n" +
        "        或在系统环境变量中设置上述两个变量后重开终端。\n" +
        "  若使用全局 chatccc：请先 cd 到项目根目录再运行，以便加载该目录下的 .env。"
    );
  }
  console.error(`\n【程序包根目录（与「工作目录」可能不同）】\n  ${PROJECT_ROOT}`);
  console.error("\n" + "=".repeat(64) + "\n");
  printServiceDidNotStart(`未配置: ${missing.join("、")}`);
  process.exit(1);
}

/** 群描述中用于识别 Claude Code 会话的前缀 */
export const CLAUDE_SESSION_PREFIX = "Claude Code Session:";
/** 群描述中用于识别 Cursor 会话的前缀 */
export const CURSOR_SESSION_PREFIX = "Cursor Session:";

/** 根据 tool 名称返回对应的群描述前缀 */
export function sessionPrefixForTool(tool: string): string {
  if (tool === "cursor") return CURSOR_SESSION_PREFIX;
  return CLAUDE_SESSION_PREFIX;
}

/** 根据 tool 名称返回用于状态展示的标签 */
export function toolDisplayName(tool: string): string {
  if (tool === "cursor") return "Cursor";
  return "Claude Code";
}