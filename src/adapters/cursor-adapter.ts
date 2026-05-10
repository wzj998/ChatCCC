// =============================================================================
// cursor-adapter.ts — Cursor Agent CLI 适配器
// =============================================================================
// 通过 agent -p --output-format stream-json 与 Cursor agent 交互。
// 命令行可通过 CHATCCC_CURSOR_COMMAND / CHATCCC_CURSOR_ARGS 环境变量自定义。
// =============================================================================

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

import type {
  ToolAdapter,
  UnifiedBlock,
  UnifiedStreamMessage,
  CreateSessionResult,
  SessionInfo,
} from "./adapter-interface.ts";
import { CURSOR_AGENT_COMMAND, CURSOR_AGENT_ARGS } from "../config.ts";

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

// ---------------------------------------------------------------------------
// normalizeCursorMessage — Cursor 消息 → UnifiedStreamMessage | null
// ---------------------------------------------------------------------------

export function normalizeCursorMessage(
  msg: CursorMessageLine,
): UnifiedStreamMessage | null {
  if (msg.type === "assistant" && msg.message?.content) {
    const blocks: UnifiedBlock[] = [];
    for (const block of msg.message.content) {
      if (block.type === "thinking" && block.thinking) {
        blocks.push({ type: "thinking", thinking: block.thinking });
      } else if (block.type === "tool_use") {
        blocks.push({
          type: "tool_use",
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
        blocks.push({ type: "text", text: block.text });
      }
    }
    return { type: "assistant", blocks };
  }

  if (msg.type === "user" && msg.message?.content) {
    const blocks: UnifiedBlock[] = [];
    for (const block of msg.message.content) {
      if (block.type === "tool_result") {
        blocks.push({
          type: "tool_result",
          tool_use_id: block.tool_use_id ?? "",
          content: block.content,
          is_error: block.is_error,
        });
      } else if (block.type === "text" && block.text) {
        blocks.push({ type: "text", text: block.text });
      }
    }
    return { type: "user", blocks };
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
): ChildProcess {
  const allArgs = [...CURSOR_AGENT_ARGS, ...extraArgs];
  return spawn(CURSOR_AGENT_COMMAND, allArgs, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: true,
  });
}

async function* readJsonLines(
  proc: ChildProcess,
  signal?: AbortSignal,
): AsyncGenerator<CursorMessageLine> {
  const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });
  for await (const line of rl) {
    if (signal?.aborted) break;
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed) as CursorMessageLine;
    } catch { /* 非 JSON 行静默跳过 */ }
  }
}

// ---------------------------------------------------------------------------
// 适配器实现
// ---------------------------------------------------------------------------

class CursorAdapter implements ToolAdapter {
  readonly displayName = "Cursor";
  readonly sessionDescPrefix = "Cursor Session:";
  private activeProcs = new Set<ChildProcess>();

  async createSession(cwd: string): Promise<CreateSessionResult> {
    const proc = spawnAgent(["ok"], cwd);
    this.activeProcs.add(proc);

    for await (const msg of readJsonLines(proc)) {
      if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
        const sessionId = msg.session_id;
        this.activeProcs.delete(proc);
        proc.kill();
        return { sessionId };
      }
    }

    proc.kill();
    this.activeProcs.delete(proc);
    throw new Error("No session ID in Cursor init event");
  }

  async *prompt(
    sessionId: string,
    userText: string,
    cwd: string,
    signal?: AbortSignal,
  ): AsyncIterable<UnifiedStreamMessage> {
    const proc = spawnAgent(["--resume", sessionId, userText], cwd);
    this.activeProcs.add(proc);

    try {
      for await (const raw of readJsonLines(proc, signal)) {
        if (signal?.aborted) break;
        const normalized = normalizeCursorMessage(raw);
        if (normalized) yield normalized;
      }
    } finally {
      proc.kill();
      this.activeProcs.delete(proc);
    }
  }

  async getSessionInfo(
    _sessionId: string,
  ): Promise<SessionInfo | undefined> {
    return { sessionId: _sessionId };
  }

  async closeSession(_sessionId: string): Promise<void> {
    // 子进程由 prompt 的 finally 自动 kill
  }
}

// ---------------------------------------------------------------------------
// 工厂函数
// ---------------------------------------------------------------------------

export function createCursorAdapter(): ToolAdapter {
  return new CursorAdapter();
}