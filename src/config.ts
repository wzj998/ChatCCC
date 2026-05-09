import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";

import { setupFileLogging } from "./shared.ts";

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
export const APP_ID: string = process.env.FEISHU_CLAUDER_APP_ID ?? "";
export const APP_SECRET: string = process.env.FEISHU_CLAUDER_APP_SECRET ?? "";

export const BASE_URL = "https://open.feishu.cn/open-apis";
export const LOCAL_RELAY_URL = "ws://127.0.0.1:18080";

export const CHATCCC_PORT = parseInt(process.env.CHATCCC_PORT?.trim() ?? "18080", 10);

export const CLAUDE_MODEL =
  process.env.CHATCCC_ANTHROPIC_MODEL?.trim() || "dashscope/deepseek-v4-pro-anthropic";

export const CLAUDE_EFFORT =
  process.env.CHATCCC_ANTHROPIC_EFFORT?.trim() || "max";

// 新建会话的默认工作路径（/cd 命令设置，持久化到本地文件）
// 该路径仅影响通过 /new 新建的 Claude 会话，不影响已有会话的 resume。
export const DEFAULT_CWD_FILE = join(PROJECT_ROOT, ".claude", "working_dir.txt");

/** 读取 /cd 设置的默认工作路径。若文件不存在或路径已失效，回退到 PROJECT_ROOT。 */
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
  return PROJECT_ROOT;
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

export const SESSION_DESC_PREFIX = "Claude Session:";