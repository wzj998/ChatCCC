import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";

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

export const CLAUDE_MODEL =
  process.env.CHATCCC_ANTHROPIC_MODEL?.trim() || "dashscope/deepseek-v4-pro-anthropic";

export const CLAUDE_EFFORT =
  process.env.CHATCCC_ANTHROPIC_EFFORT?.trim() || "max";

export const WORKING_DIR_FILE = join(PROJECT_ROOT, ".claude", "working_dir.txt");

export async function getWorkingDir(): Promise<string> {
  try {
    const content = await readFile(WORKING_DIR_FILE, "utf-8");
    const dir = content.trim();
    if (dir) return dir;
  } catch { /* file doesn't exist yet */ }
  return PROJECT_ROOT;
}

export async function setWorkingDir(dir: string): Promise<void> {
  await writeFile(WORKING_DIR_FILE, dir, "utf-8");
}

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

export function ts(): string {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

export const SESSION_DESC_PREFIX = "Claude Session:";