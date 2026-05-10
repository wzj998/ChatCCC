// =============================================================================
// cursor-session-meta-store.ts — Cursor 会话 sessionId → meta 持久化映射
// =============================================================================
// 背景：Claude Adapter 通过 SDK 的 getSessionInfo 能拿到会话的真实 cwd（SDK
// 内部已持久化）。Cursor CLI 没有等价机制，因此 ChatCCC 必须自己维护一份
// sessionId → { cwd, model } 映射，否则：
//   1. /git、/cd 等需要"会话真实工作目录"的命令将在 Cursor 会话上 100% 失败
//   2. /status、/sessions 显示的"模型"只能硬塞 ChatCCC 的 ANTHROPIC 环境变量，
//      与 Cursor 实际跑的 Composer 2 Fast 等真实模型无关
//
// 存储：
//   文件 .claude/cursor-session-meta.json，结构：
//     { "<sessionId>": { "cwd": "...", "model": "..." } }
//
// API 设计：
//   set(sid, partial) → 部分合并写入；只更新非空字段，不会清空其他字段
//   这样 createSession（拿到 cwd+model）与 prompt（resume 时再次学习）都用同一
//   接口，但若某次 init 事件少了某字段也不会破坏已记录值。
//
// 鲁棒性：文件不存在/损坏/IO 失败一律视为空映射，仅打日志，不阻断主流程。
// =============================================================================

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { PROJECT_ROOT } from "../config.ts";

/** 持久化文件默认路径（生产）。测试可通过 createCursorSessionMetaStore(filePath) 注入。 */
export const CURSOR_SESSION_META_FILE = join(
  PROJECT_ROOT,
  ".claude",
  "cursor-session-meta.json",
);

/**
 * 单条会话元数据。cwd 为必填（无 cwd 的记录视为不完整，get 返回 undefined）；
 * model 可选（cursor agent init 事件理论上一定带，留可选是为防御性兜底）。
 */
export interface CursorSessionMeta {
  cwd: string;
  model?: string;
}

export interface CursorSessionMetaStore {
  /** 查询某 sessionId 对应的元数据；未记录或 cwd 缺失返回 undefined。 */
  get(sessionId: string): Promise<CursorSessionMeta | undefined>;
  /**
   * 部分合并写入：仅写入非 undefined / 非空字段；其他字段保持原值。
   * - 第一次写入若不含 cwd，记录视为不完整，get 仍返回 undefined
   * - 同 sessionId 重复写入完全相同值时跳过 IO（性能优化）
   */
  set(sessionId: string, partial: Partial<CursorSessionMeta>): Promise<void>;
}

interface RawEntry {
  cwd?: string;
  model?: string;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/**
 * 解析持久化文件中的单条记录，兼容历史 schema：
 *   - 新版：{ cwd: string, model?: string }
 *   - 历史 v1：纯字符串（直接是 cwd 值）—— 升级前旧数据兼容
 * 非法形态返回 null。
 */
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

/**
 * 创建一个基于 JSON 文件的 store 实例。
 *
 * - 首次访问时懒加载文件到内存缓存；后续读全部走缓存
 * - 写时先合并到缓存再落盘（写失败仅 console.error，不抛异常）
 * - 同一 sessionId 重复 set 完全相同值时跳过 IO
 */
export function createCursorSessionMetaStore(
  filePath: string = CURSOR_SESSION_META_FILE,
): CursorSessionMetaStore {
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
      // 文件不存在 / JSON 损坏 / 读权限失败 → 视为空映射，不阻断主流程
    }
    cache = {};
    return cache;
  }

  return {
    async get(sessionId: string): Promise<CursorSessionMeta | undefined> {
      const map = await load();
      const entry = map[sessionId];
      if (!entry || !isNonEmptyString(entry.cwd)) return undefined;
      return entry.model
        ? { cwd: entry.cwd, model: entry.model }
        : { cwd: entry.cwd };
    },

    async set(
      sessionId: string,
      partial: Partial<CursorSessionMeta>,
    ): Promise<void> {
      const map = await load();
      const existing = map[sessionId] ?? {};
      const merged: RawEntry = { ...existing };
      if (isNonEmptyString(partial.cwd)) merged.cwd = partial.cwd;
      if (isNonEmptyString(partial.model)) merged.model = partial.model;

      // 与原值完全相同时跳过 IO
      if (existing.cwd === merged.cwd && existing.model === merged.model) return;

      map[sessionId] = merged;
      try {
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, JSON.stringify(map, null, 2), "utf-8");
      } catch (err) {
        console.error(
          `[cursor-session-meta] failed to persist ${filePath}: ${(err as Error).message}`,
        );
      }
    },
  };
}

/** 生产环境共享的全局默认实例（指向 .claude/cursor-session-meta.json）。 */
export const defaultCursorSessionMetaStore = createCursorSessionMetaStore();
