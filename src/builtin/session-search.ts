/**
 * session-search.ts — DeepCCC 历史会话关键词检索
 *
 * 供 agent 通过 session_search 工具按需查找很久以前的原始消息/工具调用：
 * - 主数据源：~/.deepccc/sessions/<sessionId>/context.json（明文 JSON，含 summary、
 *   messages.content 与结构化 toolCalls）
 * - 可选数据源：~/.deepccc/raw-stream-logs/deepccc/<sessionId>/*.jsonl.gz（gzip 原始流，
 *   逐行解压检索，默认关闭）
 *
 * 纯关键词匹配（多词 AND、大小写不敏感），不依赖向量索引。
 */

import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";

import { RAW_STREAM_LOGS_DIR } from "./config.js";
import { DEFAULT_BUILTIN_CONTEXT_DIR, type BuiltinContextRole } from "./context.js";

export interface SessionSearchOptions {
  /** 会话目录，默认 ~/.deepccc/sessions */
  contextDir?: string;
  /** raw-stream-logs 根目录，默认 ~/.deepccc/raw-stream-logs */
  rawLogsDir?: string;
  /** 是否搜索 gzip 原始流日志（默认 false，较慢） */
  includeRawLogs?: boolean;
  /** 只搜索指定 sessionId（目录名或 state.sessionId 匹配） */
  sessionId?: string;
  /** 结果上限（默认 20，上限 50） */
  maxResults?: number;
  /** 单条命中片段最大字符数（默认 400） */
  maxSnippetChars?: number;
  /** 单个 raw log 文件最多解压检索的字节数（默认 4MB） */
  maxRawLogBytesPerFile?: number;
}

export interface SessionSearchInput {
  query: string;
  session_id?: string;
  include_raw_logs?: boolean;
  max_results?: number;
}

export interface SessionSearchMatch {
  sessionId: string;
  source: "context" | "summary" | "raw-log";
  role?: BuiltinContextRole;
  /** 在 messages 数组中的下标 */
  messageIndex?: number;
  /** 在 message.toolCalls 数组中的下标（仅结构化工具调用命中时） */
  toolCallIndex?: number;
  toolCallName?: string;
  snippet: string;
  filePath: string;
}

export interface SessionSearchOutput {
  query: string;
  terms: string[];
  matches: SessionSearchMatch[];
  truncated: boolean;
  scannedSessions: number;
  scannedRawLogFiles: number;
}

const DEFAULT_MAX_RESULTS = 20;
const MAX_RESULTS_CAP = 50;
const DEFAULT_MAX_SNIPPET_CHARS = 400;
const MAX_SNIPPET_CHARS_CAP = 2_000;
const DEFAULT_MAX_RAW_LOG_BYTES_PER_FILE = 4 * 1024 * 1024;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
}

/** 多词 AND、大小写不敏感：候选文本必须包含全部关键词 */
function matchesTerms(text: string, terms: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return terms.every((term) => lower.includes(term));
}

function makeSnippet(text: string, terms: readonly string[], maxChars: number): string {
  if (text.length <= maxChars) return text;
  const lower = text.toLowerCase();
  let hitIndex = -1;
  for (const term of terms) {
    const index = lower.indexOf(term);
    if (index !== -1) {
      hitIndex = index;
      break;
    }
  }
  const half = Math.floor(maxChars / 2);
  if (hitIndex === -1) {
    return `${text.slice(0, half)}…${text.slice(-half)}`;
  }
  const start = Math.max(0, hitIndex - half);
  const end = Math.min(text.length, hitIndex + half);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

interface ContextSearchResult {
  matches: SessionSearchMatch[];
  scannedSessions: number;
  /** 命中总数（含被 maxResults 截断的部分），用于精确的 truncated 判定 */
  totalHits: number;
}

function searchContextDir(
  query: string,
  options: SessionSearchOptions,
  maxResults: number,
  maxSnippetChars: number,
): ContextSearchResult {
  const dir = options.contextDir ?? DEFAULT_BUILTIN_CONTEXT_DIR;
  const terms = tokenize(query);
  const matches: SessionSearchMatch[] = [];
  if (terms.length === 0 || !existsSync(dir)) {
    return { matches, scannedSessions: 0, totalHits: 0 };
  }

  const restrictTo = options.sessionId?.trim();

  let scannedSessions = 0;
  let totalHits = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (restrictTo && entry.name !== restrictTo) continue;
    const filePath = join(dir, entry.name, "context.json");
    if (!existsSync(filePath)) continue;

    let state: {
      sessionId?: unknown;
      summary?: unknown;
      messages?: unknown;
    };
    try {
      state = JSON.parse(readFileSync(filePath, "utf8")) as typeof state;
    } catch {
      continue; // 损坏或非 JSON 的会话文件跳过
    }
    if (!state || typeof state !== "object") continue;
    if (restrictTo && state.sessionId !== restrictTo && entry.name !== restrictTo) continue;
    scannedSessions += 1;
    const sessionId = typeof state.sessionId === "string" ? state.sessionId : entry.name;

    if (typeof state.summary === "string" && matchesTerms(state.summary, terms)) {
      totalHits += 1;
      matches.push({
        sessionId,
        source: "summary",
        snippet: makeSnippet(state.summary, terms, maxSnippetChars),
        filePath,
      });
    }

    if (Array.isArray(state.messages)) {
      state.messages.forEach((message, messageIndex) => {
        if (!message || typeof message !== "object") return;
        const raw = message as { role?: unknown; content?: unknown; toolCalls?: unknown };
        const role: BuiltinContextRole | undefined =
          raw.role === "user" || raw.role === "assistant" ? raw.role : undefined;

        if (typeof raw.content === "string" && matchesTerms(raw.content, terms)) {
          totalHits += 1;
          matches.push({
            sessionId,
            source: "context",
            role,
            messageIndex,
            snippet: makeSnippet(raw.content, terms, maxSnippetChars),
            filePath,
          });
        }

        if (Array.isArray(raw.toolCalls)) {
          raw.toolCalls.forEach((call, toolCallIndex) => {
            if (!call || typeof call !== "object") return;
            const callRaw = call as { name?: unknown; input?: unknown; output?: unknown };
            const name = typeof callRaw.name === "string" ? callRaw.name : "";
            const input = typeof callRaw.input === "string" ? callRaw.input : "";
            const output = typeof callRaw.output === "string" ? callRaw.output : "";
            if (name.length === 0 && input.length === 0 && output.length === 0) return;
            const haystack = [name, input, output].join("\n");
            if (!matchesTerms(haystack, terms)) return;
            totalHits += 1;
            const source = output || input || name;
            matches.push({
              sessionId,
              source: "context",
              role,
              messageIndex,
              toolCallIndex,
              toolCallName: name,
              snippet: makeSnippet(source, terms, maxSnippetChars),
              filePath,
            });
          });
        }
      });
    }
  }

  return { matches: matches.slice(0, maxResults), scannedSessions, totalHits };
}

interface RawLogSearchResult {
  matches: SessionSearchMatch[];
  scannedFiles: number;
  /** raw log 流式解压提前截断（达到 maxResults 停止扫描剩余文件） */
  truncated: boolean;
}

async function searchRawLogs(
  query: string,
  options: SessionSearchOptions,
  maxResults: number,
  maxSnippetChars: number,
): Promise<RawLogSearchResult> {
  const terms = tokenize(query);
  const rootDir = options.rawLogsDir ?? RAW_STREAM_LOGS_DIR;
  const matches: SessionSearchMatch[] = [];
  if (terms.length === 0 || !existsSync(rootDir)) {
    return { matches, scannedFiles: 0, truncated: false };
  }

  const toolRoot = join(rootDir, "deepccc");
  if (!existsSync(toolRoot)) return { matches, scannedFiles: 0, truncated: false };

  const restrictTo = options.sessionId?.trim();
  const maxBytesPerFile = Math.max(0, options.maxRawLogBytesPerFile ?? DEFAULT_MAX_RAW_LOG_BYTES_PER_FILE);

  // 收集所有 .jsonl.gz 文件，按 mtime 新→旧排序（最新轮次优先）
  const files: { path: string; sessionId: string; mtimeMs: number }[] = [];
  for (const sessionEntry of readdirSync(toolRoot, { withFileTypes: true })) {
    if (!sessionEntry.isDirectory()) continue;
    if (restrictTo && sessionEntry.name !== restrictTo) continue;
    const sessionDir = join(toolRoot, sessionEntry.name);
    let entries;
    try {
      entries = readdirSync(sessionDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const fileEntry of entries) {
      if (!fileEntry.isFile() || !fileEntry.name.endsWith(".jsonl.gz")) continue;
      const filePath = join(sessionDir, fileEntry.name);
      try {
        const info = statSync(filePath);
        files.push({ path: filePath, sessionId: sessionEntry.name, mtimeMs: info.mtimeMs });
      } catch {
        // 无法 stat 的文件跳过
      }
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);

  let scannedFiles = 0;
  let truncated = false;
  for (const file of files) {
    if (matches.length >= maxResults) {
      truncated = true;
      break;
    }
    scannedFiles += 1;
    const snippets = await searchGzipFileLines(file.path, terms, maxBytesPerFile, maxSnippetChars);
    for (const snippet of snippets) {
      matches.push({
        sessionId: file.sessionId,
        source: "raw-log",
        snippet,
        filePath: file.path,
      });
      if (matches.length >= maxResults) break;
    }
  }

  return { matches: matches.slice(0, maxResults), scannedFiles, truncated };
}

async function searchGzipFileLines(
  filePath: string,
  terms: readonly string[],
  maxBytes: number,
  maxSnippetChars: number,
): Promise<string[]> {
  const hits: string[] = [];
  let bytes = 0;
  try {
    const source = createReadStream(filePath);
    const gunzip = createGunzip();
    // 防崩溃（线上事故）：截断/损坏的 gzip 会在 zlib 层 emit 'error'（如
    // "unexpected end of file"）。若无人监听，错误事件会升级为 uncaughtException
    // 直接杀死整个服务（崩溃黑匣子 exit(1)）。显式挂监听把错误降级为
    // “跳过该文件”：destroy 流让 for await 正常结束，不再冒泡。
    source.on("error", () => gunzip.destroy());
    gunzip.on("error", () => gunzip.destroy());
    const reader = createInterface({ input: source.pipe(gunzip), crlfDelay: Infinity });
    // readline 会把 input 流的 error 转发到自己身上，同样需要监听避免冒泡
    reader.on("error", () => {});
    for await (const line of reader) {
      bytes += Buffer.byteLength(line, "utf-8");
      if (bytes > maxBytes) break;
      if (!matchesTerms(line, terms)) continue;
      hits.push(makeSnippet(line, terms, maxSnippetChars));
      if (hits.length >= 50) break;
    }
  } catch {
    // 损坏的 gzip 文件按 best-effort 跳过
  }
  return hits;
}

/**
 * 关键词检索历史会话存档。context.json 为同步扫描；raw-stream-logs 为
 * gzip 逐行解压（异步，仅 options.includeRawLogs 时启用）。
 */
export async function searchBuiltinSessions(
  query: string,
  options: SessionSearchOptions = {},
): Promise<SessionSearchOutput> {
  const terms = tokenize(query);
  const maxResults = clamp(options.maxResults ?? DEFAULT_MAX_RESULTS, 1, MAX_RESULTS_CAP);
  const maxSnippetChars = clamp(
    options.maxSnippetChars ?? DEFAULT_MAX_SNIPPET_CHARS,
    80,
    MAX_SNIPPET_CHARS_CAP,
  );

  if (terms.length === 0) {
    return {
      query,
      terms,
      matches: [],
      truncated: false,
      scannedSessions: 0,
      scannedRawLogFiles: 0,
    };
  }

  const contextResult = searchContextDir(query, options, maxResults, maxSnippetChars);
  let rawResult: RawLogSearchResult = { matches: [], scannedFiles: 0, truncated: false };
  if (options.includeRawLogs) {
    rawResult = await searchRawLogs(query, options, maxResults, maxSnippetChars);
  }

  const matches = [...contextResult.matches, ...rawResult.matches].slice(0, maxResults);
  const truncated =
    contextResult.totalHits > maxResults || rawResult.truncated || rawResult.matches.length > maxResults;

  return {
    query,
    terms,
    matches,
    truncated,
    scannedSessions: contextResult.scannedSessions,
    scannedRawLogFiles: rawResult.scannedFiles,
  };
}
