// =============================================================================
// cursor-adapter.ts — Cursor Agent CLI 适配器
// =============================================================================
// 通过 agent -p --output-format stream-json 与 Cursor agent 交互。
// 命令行可通过 config.json cursor.path / cursor.model 自定义。
// =============================================================================

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import type {
  ToolAdapter,
  ToolPromptOptions,
  UnifiedBlock,
  UnifiedStreamMessage,
  CreateSessionResult,
  SessionInfo,
} from "./adapter-interface.ts";
import { parseUserCommand } from "./adapter-interface.ts";
import { config, CURSOR_AGENT_COMMAND, CURSOR_AGENT_ARGS, RAW_STREAM_LOGS_DIR } from "../config.ts";
import {
  defaultCursorSessionMetaStore,
  type CursorSessionMetaStore,
} from "./cursor-session-meta-store.ts";
import { killProcessTree } from "./proc-tree-kill.ts";
import {
  createRawStreamLog,
  type RawStreamLogHandle,
} from "./raw-stream-log.ts";

// ---------------------------------------------------------------------------
// 特殊注入提示
// ---------------------------------------------------------------------------

const PROJECT_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const CURSOR_SPECIFIC_PROMPT_PATH = join(
  PROJECT_ROOT,
  "agent-prompts",
  "cursor_specific.md",
);

function readCursorSpecificInjectionPrompt(): string | null {
  try {
    if (!existsSync(CURSOR_SPECIFIC_PROMPT_PATH)) return null;
    const prompt = readFileSync(CURSOR_SPECIFIC_PROMPT_PATH, "utf-8").trim();
    return prompt.length > 0 ? prompt : null;
  } catch {
    return null;
  }
}

function buildCursorPromptText(userText: string): string {
  const prompt = readCursorSpecificInjectionPrompt();
  if (!prompt) return userText;

  return [
    "[ChatCCC Cursor-specific injection prompt]",
    prompt,
    "[/ChatCCC Cursor-specific injection prompt]",
    "",
    userText,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 类型：Cursor JSONL 消息行
// ---------------------------------------------------------------------------

interface CursorMessageLine {
  type?: string;
  subtype?: string;
  session_id?: string;
  cwd?: string;
  model?: string;
  message?: {
    role?: string;
    content?: CursorContentBlock[];
  };
  result?: string;
  duration_ms?: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  /**
   * 三类 assistant 事件的判定字段之一。详见 normalizeCursorMessage。
   * 官方文档：cursor.com/docs/cli/reference/output-format
   */
  timestamp_ms?: number;
  /**
   * 三类 assistant 事件的判定字段之一：
   *   - has timestamp_ms, no model_call_id  → Streaming delta（真增量）
   *   - has timestamp_ms, has model_call_id → Buffered flush before tool call（重复快照）
   *   - no  timestamp_ms                    → Final flush at end of turn（重复快照）
   */
  model_call_id?: string;
  /** thinking delta 消息的文本内容 */
  text?: string;
  /** tool_call 消息的 call_id */
  call_id?: string;
  /** tool_call 消息的 tool_call 载荷 */
  tool_call?: Record<string, unknown>;
}

interface CursorContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  query?: string;
  [key: string]: unknown;
}

interface CursorProcessCloseInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

interface CursorProcessHandle {
  proc: ChildProcess;
  getStderr(): string;
  waitForClose(): Promise<CursorProcessCloseInfo>;
}

interface CursorStreamStats {
  stdoutLength: number;
  rawLineCount: number;
  parsedLineCount: number;
}

type CursorSpawn = typeof spawn;

function createCursorStreamStats(): CursorStreamStats {
  return { stdoutLength: 0, rawLineCount: 0, parsedLineCount: 0 };
}

function isCursorAuthRelatedError(stderr: string): boolean {
  const text = stderr.toLowerCase();
  return (
    text.includes("authentication required") ||
    text.includes("not logged in") ||
    text.includes("login") ||
    text.includes("sign in") ||
    text.includes("unauthorized") ||
    text.includes("401") ||
    text.includes("cursor_api_key") ||
    text.includes("api key")
  );
}

export function formatCursorAgentEmptyOutputMessage(args: {
  exitCode: number | null;
  stdoutLength: number;
  stderr: string;
}): string | null {
  if (args.exitCode === 0) return null;
  if (args.stdoutLength !== 0) return null;
  if (args.stderr.trim().length === 0) return null;

  if (isCursorAuthRelatedError(args.stderr)) {
    return "Cursor Agent 没有返回内容。检测到认证相关错误，可能需要重新登录 Cursor Agent，或配置 CURSOR_API_KEY。请在本机运行 agent status 检查状态；如未登录，请运行 agent login 后重试。";
  }

  return "Cursor Agent 没有返回内容。底层命令异常退出，请检查本机 Cursor Agent 状态后重试。";
}

function createCursorAgentFailureError(info: CursorProcessCloseInfo): Error {
  const stderr = info.stderr.trim().slice(0, 500);
  return new Error(
    `Cursor Agent exited without stream-json output (exit=${info.code ?? "unknown"}, stderr=${stderr})`,
  );
}

// ---------------------------------------------------------------------------
// normalizeCursorMessage — Cursor 消息 → UnifiedStreamMessage | null
// ---------------------------------------------------------------------------

/** Cursor tool_call 内部 key → 统一工具名 */
function mapToolCallKey(key: string): string {
  const KEY_MAP: Record<string, string> = {
    globToolCall: "Glob",
    shellToolCall: "Bash",
    readToolCall: "Read",
    writeToolCall: "Write",
    editToolCall: "Edit",
    grepToolCall: "Grep",
    webSearchToolCall: "WebSearch",
    webFetchToolCall: "WebFetch",
    taskToolCall: "Agent",
    notebookEditToolCall: "NotebookEdit",
  };
  return KEY_MAP[key] ?? key;
}

export function normalizeCursorMessage(
  msg: CursorMessageLine,
): UnifiedStreamMessage | null {
  if (msg.type === "assistant" && msg.message?.content) {
    // 按 cursor 官方 stream-json 规范区分三类 assistant 事件，避免 text 重复累加：
    //   ┌────────────────┬───────────────┬─────────────────┐
    //   │ 种类            │ timestamp_ms  │ model_call_id   │
    //   ├────────────────┼───────────────┼─────────────────┤
    //   │ Streaming delta│ 有             │ 无               │ → 唯一带新文本（text）
    //   │ Buffered flush │ 有             │ 有               │ → 工具调用前完整快照（text_final）
    //   │ Final flush    │ 无             │ 无               │ → 回合末完整快照（text_final）
    //   └────────────────┴───────────────┴─────────────────┘
    // 文档：cursor.com/docs/cli/reference/output-format
    const isStreamingDelta =
      msg.timestamp_ms !== undefined && msg.model_call_id === undefined;
    const blocks: UnifiedBlock[] = [];
    for (const block of msg.message.content) {
      if (block.type === "thinking" && block.thinking) {
        blocks.push({ type: "thinking", thinking: block.thinking });
      } else if (block.type === "tool_use") {
        blocks.push({
          type: "tool_use",
          id: block.tool_use_id,
          name: block.name ?? "unknown",
          input: block.input,
        });
      } else if (block.type === "tool_result") {
        blocks.push({
          type: "tool_result",
          tool_use_id: block.tool_use_id ?? "",
          content: block.content,
          is_error: block.is_error,
        });
      } else if (block.type === "redacted_thinking") {
        blocks.push({ type: "redacted_thinking" });
      } else if (block.type === "search_result") {
        blocks.push({
          type: "search_result",
          query: block.query ?? "",
        });
      } else if (block.type === "text" && block.text) {
        blocks.push(
          isStreamingDelta
            ? { type: "text", text: block.text }
            : { type: "text_final", text: block.text },
        );
      }
    }
    return { type: "assistant", blocks };
  }

  // Cursor agent 发出的独立 thinking delta 消息
  if (msg.type === "thinking" && msg.subtype === "delta" && msg.text) {
    return {
      type: "assistant",
      blocks: [{ type: "thinking", thinking: msg.text }],
    };
  }

  // Cursor agent 发出的独立 tool_call 消息（tool_call.started / tool_call.completed）
  if (msg.type === "tool_call" && msg.call_id && msg.tool_call) {
    const toolKey = Object.keys(msg.tool_call)[0];
    if (!toolKey) return null;
    const toolData = msg.tool_call[toolKey] as {
      args?: Record<string, unknown>;
      result?: Record<string, unknown>;
      description?: string;
    } | undefined;
    if (!toolData) return null;

    if (msg.subtype === "started") {
      return {
        type: "assistant",
        blocks: [
          {
            type: "tool_use",
            name: mapToolCallKey(toolKey),
            input: toolData.args ?? {},
          },
        ],
      };
    }

    if (msg.subtype === "completed") {
      const resultRaw = toolData.result as Record<string, unknown> | undefined;
      const hasSuccess = resultRaw && "success" in resultRaw;
      const hasError = resultRaw && "error" in resultRaw;
      return {
        type: "assistant",
        blocks: [
          {
            type: "tool_result",
            tool_use_id: msg.call_id,
            content: hasSuccess
              ? (resultRaw!.success as Record<string, unknown>)?.stdout ??
                resultRaw!.success
              : hasError
                ? resultRaw!.error
                : resultRaw ?? {},
            is_error: hasError || undefined,
          },
        ],
      };
    }

    return null;
  }

  if (msg.type === "user" && msg.message?.content) {
    // Cursor resume 模式会先 echo 一条用户输入消息（text 块就是用户原始输入），
    // 不应混入 assistant 输出累加。这里只保留 tool_result（工具调用反馈）。
    const blocks: UnifiedBlock[] = [];
    for (const block of msg.message.content) {
      if (block.type === "tool_result") {
        blocks.push({
          type: "tool_result",
          tool_use_id: block.tool_use_id ?? "",
          content: block.content,
          is_error: block.is_error,
        });
      }
    }
    return { type: "user", blocks };
  }

  // result 消息：cursor 官方推荐的"权威最终文本"来源（流末发出，含完整一段文字）。
  // 提取为 assistant 的 text_final 块，由 session.ts 累积到 finalCompleteText。
  if (msg.type === "result" && typeof msg.result === "string" && msg.result.length > 0) {
    return {
      type: "assistant",
      blocks: [{ type: "text_final", text: msg.result }],
    };
  }

  if (msg.type === "system" && msg.subtype === "compact_boundary") {
    const meta = (msg as Record<string, unknown>).compact_metadata as
      | { trigger?: "manual" | "auto"; pre_tokens?: number; post_tokens?: number }
      | undefined;
    if (!meta) return null;
    return {
      type: "system",
      blocks: [
        {
          type: "compact_boundary",
          trigger: meta.trigger ?? "auto",
          pre_tokens: meta.pre_tokens ?? 0,
          post_tokens: meta.post_tokens,
        },
      ],
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// 子进程辅助函数
// ---------------------------------------------------------------------------

function spawnAgent(
  extraArgs: string[],
  cwd?: string,
  stdinText?: string,
  modelOverride?: string,
  mode?: "plan" | "ask",
  spawnImpl: CursorSpawn = spawn,
): CursorProcessHandle {
  let allArgs: string[];
  if (mode) {
    // plan/ask 模式：移除 --force/--yolo，添加 --mode plan/ask
    allArgs = CURSOR_AGENT_ARGS.filter(a => a !== "--force" && a !== "--yolo");
    allArgs.push("--mode", mode);
    allArgs.push(...extraArgs);
  } else {
    allArgs = [...CURSOR_AGENT_ARGS, ...extraArgs];
  }
  if (modelOverride) {
    // 替换全局 --model 为 per-session override
    const modelIdx = allArgs.findIndex((a, i) => a === "--model" && i + 1 < allArgs.length);
    if (modelIdx >= 0) {
      allArgs[modelIdx + 1] = modelOverride;
    } else {
      allArgs.push("--model", modelOverride);
    }
  }
  const proc = spawnImpl(CURSOR_AGENT_COMMAND, allArgs, {
    cwd,
    stdio: [stdinText !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: true,
  });

  console.log(`[Cursor debug] spawn: cmd=${CURSOR_AGENT_COMMAND}, args=[${allArgs.join(", ")}], cwd=${cwd ?? "(none)"}, stdinLen=${stdinText?.length ?? 0}, pid=${proc.pid}`);

  // 收集 stderr，子进程异常退出时输出到日志，方便排查静默失败
  let stderr = "";
  let closeInfo: CursorProcessCloseInfo | null = null;
  let resolveClose: (info: CursorProcessCloseInfo) => void = () => {};
  const closePromise = new Promise<CursorProcessCloseInfo>((resolve) => {
    resolveClose = resolve;
  });
  const settleClose = (code: number | null, signal: NodeJS.Signals | null) => {
    if (closeInfo) return;
    closeInfo = { code, signal, stderr };
    if (stderr.trim()) {
      console.error(`[Cursor stderr] exit=${code}: ${stderr.trim().slice(0, 2000)}`);
    }
    resolveClose(closeInfo);
  };
  proc.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  proc.once("error", (err) => {
    stderr += `${stderr ? "\n" : ""}${(err as Error).message}`;
    settleClose(null, null);
  });
  proc.once("close", (code, signal) => { settleClose(code, signal); });

  if (stdinText !== undefined) {
    proc.stdin!.write(stdinText);
    proc.stdin!.end();
  }
  return {
    proc,
    getStderr: () => stderr,
    waitForClose: async () => {
      if (closeInfo) return { ...closeInfo, stderr };
      const info = await closePromise;
      return { ...info, stderr };
    },
  };
}

async function* readJsonLines(
  proc: ChildProcess,
  signal?: AbortSignal,
  debugTag?: string,
  rawLog?: RawStreamLogHandle | null,
  stats?: CursorStreamStats,
): AsyncGenerator<CursorMessageLine> {
  const tag = debugTag ?? "cursor";
  const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });
  // abort 时主动 close readline，避免等待 Windows 管道自然关闭（可能延迟数分钟）
  const onAbort = () => { rl.close(); };
  signal?.addEventListener("abort", onAbort, { once: true });
  let lineCount = 0;
  try {
    for await (const line of rl) {
      if (signal?.aborted) break;
      lineCount++;
      if (stats) {
        stats.rawLineCount++;
        stats.stdoutLength += Buffer.byteLength(line, "utf-8") + 1;
      }
      const trimmed = line.trim();
      if (!trimmed) continue;
      rawLog?.writeLine(trimmed);
      try {
        const parsed = JSON.parse(trimmed) as CursorMessageLine;
        if (stats) stats.parsedLineCount++;
        yield parsed;
      } catch { /* 非 JSON 行静默跳过 */ }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    rl.close();
    console.log(`[Cursor debug] ${tag} readJsonLines done: ${lineCount} raw lines, signalAborted=${signal?.aborted ?? false}`);
  }
}

// ---------------------------------------------------------------------------
// 适配器实现
// ---------------------------------------------------------------------------

class CursorAdapter implements ToolAdapter {
  readonly displayName = "Cursor";
  readonly sessionDescPrefix = "Cursor Session:";
  private activeProcs = new Set<ChildProcess>();
  private metaStore: CursorSessionMetaStore;
  private modelOverride: string | undefined;
  private spawnImpl: CursorSpawn;

  constructor(metaStore: CursorSessionMetaStore, modelOverride?: string, spawnImpl: CursorSpawn = spawn) {
    this.metaStore = metaStore;
    this.modelOverride = modelOverride;
    this.spawnImpl = spawnImpl;
  }

  async createSession(cwd: string): Promise<CreateSessionResult> {
    const handle = spawnAgent(["ok"], cwd, undefined, this.modelOverride, undefined, this.spawnImpl);
    const proc = handle.proc;
    const stats = createCursorStreamStats();
    this.activeProcs.add(proc);

    for await (const msg of readJsonLines(proc, undefined, "createSession", null, stats)) {
      if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
        const sessionId = msg.session_id;
        await this.metaStore
          .set(sessionId, { cwd: msg.cwd ?? cwd, model: msg.model })
          .catch(() => {});
        this.activeProcs.delete(proc);
        await killProcessTree(proc.pid);
        return { sessionId };
      }
    }

    await killProcessTree(proc.pid);
    this.activeProcs.delete(proc);
    const closeInfo = await handle.waitForClose();
    const visibleMessage = formatCursorAgentEmptyOutputMessage({
      exitCode: closeInfo.code,
      stdoutLength: stats.stdoutLength,
      stderr: closeInfo.stderr,
    });
    if (visibleMessage) throw new Error(visibleMessage);
    throw new Error("No session ID in Cursor init event");
  }

  async *prompt(
    sessionId: string,
    userText: string,
    cwd: string,
    signal?: AbortSignal,
    options?: ToolPromptOptions,
  ): AsyncIterable<UnifiedStreamMessage> {
    console.log(`[Cursor debug] prompt start: sessionId=${sessionId}, cwd=${cwd}, userTextLen=${userText.length}`);
    const cmd = parseUserCommand(userText);
    const handle = spawnAgent(
      ["--resume", sessionId],
      cwd,
      buildCursorPromptText(userText),
      this.modelOverride,
      cmd.mode ?? undefined,
      this.spawnImpl,
    );
    const proc = handle.proc;
    this.activeProcs.add(proc);
    if (proc.pid !== undefined) options?.onProcessStart?.({ pid: proc.pid });

    const rawLogConfig = config.rawStreamLogs.cursor;
    let rawLog: RawStreamLogHandle | null = null;
    try {
      rawLog = await createRawStreamLog({
        enabled: rawLogConfig.enabled,
        rootDir: RAW_STREAM_LOGS_DIR,
        tool: "cursor",
        sessionId,
        label: "prompt",
        maxBytesPerTurn: rawLogConfig.maxBytesPerTurn,
        retentionDays: rawLogConfig.retentionDays,
      });
    } catch (err) {
      console.error(`[Cursor raw stream log] create failed: ${(err as Error).message}`);
    }

    // 见 codex-adapter.ts 同位置注释：spawn 用了 shell:true，必须杀整棵树，
    // 否则 abort 后真正在跑的孙进程 cursor-agent 还会继续输出 & 占用资源。
    const onAbort = () => { void killProcessTree(proc.pid); };
    signal?.addEventListener("abort", onAbort, { once: true });
    let sawResult = false;
    const stats = createCursorStreamStats();

    try {
      for await (const raw of readJsonLines(proc, signal, sessionId, rawLog, stats)) {
        if (signal?.aborted) break;
        if (
          raw.type === "system" &&
          raw.subtype === "init" &&
          raw.session_id &&
          (raw.cwd || raw.model)
        ) {
          this.metaStore
            .set(raw.session_id, { cwd: raw.cwd, model: raw.model })
            .catch(() => {});
        }
        const normalized = normalizeCursorMessage(raw);
        if (normalized) yield normalized;

        // result 是流末事件，收到后立即结束进程，防止 CLI 僵死导致 readline 挂起。
        if (raw.type === "result") {
          sawResult = true;
          void killProcessTree(proc.pid);
          break;
        }
      }
      if (!signal?.aborted && !sawResult) {
        const closeInfo = await handle.waitForClose();
        const visibleMessage = formatCursorAgentEmptyOutputMessage({
          exitCode: closeInfo.code,
          stdoutLength: stats.stdoutLength,
          stderr: closeInfo.stderr,
        });
        if (visibleMessage) {
          yield {
            type: "assistant",
            blocks: [{ type: "text_final", text: visibleMessage }],
          };
          throw createCursorAgentFailureError(closeInfo);
        }
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      await killProcessTree(proc.pid);
      await rawLog?.close({ keep: rawLogConfig.keepCompleted || signal?.aborted === true || !sawResult });
      this.activeProcs.delete(proc);
      if (proc.pid !== undefined) options?.onProcessExit?.({ pid: proc.pid });
      console.log(`[Cursor debug] prompt end: sessionId=${sessionId}, signalAborted=${signal?.aborted ?? false}`);
    }
  }

  async getSessionInfo(
    sessionId: string,
  ): Promise<SessionInfo | undefined> {
    const meta = await this.metaStore.get(sessionId);
    if (!meta) return { sessionId };
    return meta.model
      ? { sessionId, cwd: meta.cwd, model: meta.model }
      : { sessionId, cwd: meta.cwd };
  }

  async closeSession(_sessionId: string): Promise<void> {
    // 子进程由 prompt 的 finally 自动 kill
  }
}

// ---------------------------------------------------------------------------
// 工厂函数
// ---------------------------------------------------------------------------

export interface CreateCursorAdapterOptions {
  /** 注入自定义 meta 持久化 store（测试用）；未提供时使用全局默认实例。 */
  metaStore?: CursorSessionMetaStore;
  /** per-session 模型覆盖（/model 命令）；传了就用，不传走全局 cursor.model */
  model?: string;
  /** 注入自定义 spawn 实现（测试用）。 */
  spawn?: CursorSpawn;
}

export function createCursorAdapter(
  options: CreateCursorAdapterOptions = {},
): ToolAdapter {
  return new CursorAdapter(
    options.metaStore ?? defaultCursorSessionMetaStore,
    options.model,
    options.spawn,
  );
}
