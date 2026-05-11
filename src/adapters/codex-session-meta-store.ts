// =============================================================================
// codex-session-meta-store.ts — Codex 会话 sessionId → meta 持久化映射
// =============================================================================
// Codex CLI 没有 SDK 可查询会话元数据，ChatCCC 内部维护 sessionId → { cwd, threadId } 映射。
// threadId 在首次 prompt 时才生成（Codex 不支持"空会话"创建），存储用于后续 resume。
// =============================================================================

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { PROJECT_ROOT } from "../config.ts";

export const CODEX_SESSION_META_FILE = join(
  PROJECT_ROOT,
  "state",
  "codex-session-meta.json",
);

export interface CodexSessionMeta {
  cwd: string;
  threadId?: string;
}

export interface CodexSessionMetaStore {
  get(sessionId: string): Promise<CodexSessionMeta | undefined>;
  set(sessionId: string, partial: Partial<CodexSessionMeta>): Promise<void>;
  /**
   * 只更新 threadId（高频操作：prompt 首次调用时写入）。
   * 与 set 的区别：不重新读写完整文件，内联到已有的 load→merge→save 流程。
   */
  setThreadId(sessionId: string, threadId: string): Promise<void>;
}

interface RawEntry {
  cwd?: string;
  threadId?: string;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function parseEntry(raw: unknown): RawEntry | null {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const out: RawEntry = {};
    if (isNonEmptyString(obj.cwd)) out.cwd = obj.cwd;
    if (isNonEmptyString(obj.threadId)) out.threadId = obj.threadId;
    return out;
  }
  return null;
}

export function createCodexSessionMetaStore(
  filePath: string = CODEX_SESSION_META_FILE,
): CodexSessionMetaStore {
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
      // 文件不存在或损坏
    }
    cache = {};
    return cache;
  }

  async function save(map: Record<string, RawEntry>): Promise<void> {
    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, JSON.stringify(map, null, 2), "utf-8");
    } catch (err) {
      console.error(
        `[codex-session-meta] failed to persist ${filePath}: ${(err as Error).message}`,
      );
    }
  }

  return {
    async get(sessionId: string): Promise<CodexSessionMeta | undefined> {
      const map = await load();
      const entry = map[sessionId];
      if (!entry || !isNonEmptyString(entry.cwd)) return undefined;
      return entry.threadId
        ? { cwd: entry.cwd, threadId: entry.threadId }
        : { cwd: entry.cwd };
    },

    async set(
      sessionId: string,
      partial: Partial<CodexSessionMeta>,
    ): Promise<void> {
      const map = await load();
      const existing = map[sessionId] ?? {};
      const merged: RawEntry = { ...existing };
      if (isNonEmptyString(partial.cwd)) merged.cwd = partial.cwd;
      if (isNonEmptyString(partial.threadId)) merged.threadId = partial.threadId;

      if (existing.cwd === merged.cwd && existing.threadId === merged.threadId) return;

      map[sessionId] = merged;
      await save(map);
    },

    async setThreadId(
      sessionId: string,
      threadId: string,
    ): Promise<void> {
      const map = await load();
      const existing = map[sessionId] ?? {};
      if (existing.threadId === threadId) return;
      const merged: RawEntry = { ...existing, threadId };
      map[sessionId] = merged;
      await save(map);
    },
  };
}

export const defaultCodexSessionMetaStore = createCodexSessionMetaStore();