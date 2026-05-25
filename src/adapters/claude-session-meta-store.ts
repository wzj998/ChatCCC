// =============================================================================
// claude-session-meta-store.ts — Claude 会话 sessionId → meta 持久化映射
// =============================================================================
// 背景：切换到直接调用 Claude CLI 后，不再有 SDK 的 getSessionInfo 可用。
// ChatCCC 必须自己维护 sessionId → { cwd, model } 映射。
//
// 存储：
//   文件 state/claude-session-meta.json，结构：
//     { "<sessionId>": { "cwd": "...", "model": "..." } }
//
// API 设计：
//   set(sid, partial) → 部分合并写入；只更新非空字段，不会清空其他字段
// =============================================================================

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { USER_DATA_DIR } from "../config.ts";

export const CLAUDE_SESSION_META_FILE = join(
  USER_DATA_DIR,
  "state",
  "claude-session-meta.json",
);

export interface ClaudeSessionMeta {
  cwd: string;
  model?: string;
}

export interface ClaudeSessionMetaStore {
  get(sessionId: string): Promise<ClaudeSessionMeta | undefined>;
  set(sessionId: string, partial: Partial<ClaudeSessionMeta>): Promise<void>;
}

interface RawEntry {
  cwd?: string;
  model?: string;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function parseEntry(raw: unknown): RawEntry | null {
  if (typeof raw === "string" && raw.length > 0) {
    return { cwd: raw };
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const out: RawEntry = {};
    if (isNonEmptyString(obj.cwd)) out.cwd = obj.cwd;
    if (isNonEmptyString(obj.model)) out.model = obj.model;
    return out;
  }
  return null;
}

export function createClaudeSessionMetaStore(
  filePath: string = CLAUDE_SESSION_META_FILE,
): ClaudeSessionMetaStore {
  let cache: Record<string, RawEntry> | null = null;

  async function load(): Promise<Record<string, RawEntry>> {
    if (cache) return cache;
    try {
      const raw = await readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const out: Record<string, RawEntry> = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          const entry = parseEntry(v);
          if (entry) out[k] = entry;
        }
        cache = out;
        return out;
      }
    } catch {
      // 文件不存在 / JSON 损坏 → 视为空映射
    }
    cache = {};
    return cache;
  }

  return {
    async get(sessionId: string): Promise<ClaudeSessionMeta | undefined> {
      const map = await load();
      const entry = map[sessionId];
      if (!entry || !isNonEmptyString(entry.cwd)) return undefined;
      return entry.model
        ? { cwd: entry.cwd, model: entry.model }
        : { cwd: entry.cwd };
    },

    async set(
      sessionId: string,
      partial: Partial<ClaudeSessionMeta>,
    ): Promise<void> {
      const map = await load();
      const existing = map[sessionId] ?? {};
      const merged: RawEntry = { ...existing };
      if (isNonEmptyString(partial.cwd)) merged.cwd = partial.cwd;
      if (isNonEmptyString(partial.model)) merged.model = partial.model;

      if (existing.cwd === merged.cwd && existing.model === merged.model) return;

      map[sessionId] = merged;
      try {
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, JSON.stringify(map, null, 2), "utf-8");
      } catch (err) {
        console.error(
          `[claude-session-meta] failed to persist ${filePath}: ${(err as Error).message}`,
        );
      }
    },
  };
}

export const defaultClaudeSessionMetaStore = createClaudeSessionMetaStore();