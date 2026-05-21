// =============================================================================
// codex-adapter.ts — OpenAI Codex CLI 适配器
// =============================================================================
// 通过 codex exec --json 与 Codex CLI 交互。
// - createSession: 生成 UUID sessionId，记录 cwd，不创建 Codex 线程（延迟到首次 prompt）
// - prompt: 首次调用用 codex exec 创建线程，后续用 codex exec resume 恢复
// - getSessionInfo: 从持久化映射读取 cwd / threadId
// =============================================================================

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

import type {
  ToolAdapter,
  UnifiedBlock,
  UnifiedStreamMessage,
  CreateSessionResult,
  SessionInfo,
} from "./adapter-interface.ts";
import {
  defaultCodexSessionMetaStore,
  type CodexSessionMetaStore,
} from "./codex-session-meta-store.ts";
import { killProcessTree } from "./proc-tree-kill.ts";
import { config } from "../config.ts";

// ---------------------------------------------------------------------------
// 命令与参数
// ---------------------------------------------------------------------------

/** 可通过 config.json codex.path 自定义 Codex 可执行文件路径 */
function detectCodexCommand(): string {
  return config.codex.path || "codex";
}
const CODEX_COMMAND = detectCodexCommand();

/** exec 模式共用参数：JSONL 输出、绕过沙盒和确认、跳过 git 仓库检查 */
const CODEX_BASE_ARGS = [
  "exec",
  "--json",
  "--dangerously-bypass-approvals-and-sandbox",
  "--skip-git-repo-check",
];

/** codex 模型；留空（""）表示不传 --model，由 codex config.toml 决定 */
function resolveCodexModel(): string | null {
  const m = config.codex.model;
  return m.trim() !== "" ? m : null;
}

/** codex 努力程度（映射为 -c model_reasoning_effort=<value>）；留空表示不传 */
function resolveCodexEffort(): string | null {
  const e = config.codex.effort;
  return e.trim() !== "" ? e : null;
}

// ---------------------------------------------------------------------------
// 类型：Codex JSONL 消息行
// ---------------------------------------------------------------------------

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
}

interface CodexEvent {
  type: string;
  thread_id?: string;
  item?: CodexItem;
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
}

// ---------------------------------------------------------------------------
// normalizeCodexMessage — Codex 事件 → UnifiedStreamMessage | null
// ---------------------------------------------------------------------------

export function normalizeCodexMessage(
  msg: CodexEvent,
): UnifiedStreamMessage | null {
  // agent_message 文本回复
  if (
    msg.type === "item.completed" &&
    msg.item?.type === "agent_message" &&
    msg.item.text
  ) {
    return {
      type: "assistant",
      blocks: [{ type: "text", text: msg.item.text }],
    };
  }

  // command_execution 工具调用开始
  if (
    msg.type === "item.started" &&
    msg.item?.type === "command_execution" &&
    msg.item.command
  ) {
    return {
      type: "assistant",
      blocks: [
        {
          type: "tool_use",
          name: "Bash",
          input: { command: msg.item.command },
        },
      ],
    };
  }

  // command_execution 工具调用完成
  if (
    msg.type === "item.completed" &&
    msg.item?.type === "command_execution"
  ) {
    const exitCode = msg.item.exit_code;
    return {
      type: "assistant",
      blocks: [
        {
          type: "tool_result",
          tool_use_id: msg.item.id ?? "",
          content: msg.item.aggregated_output ?? "",
          is_error: exitCode != null && exitCode !== 0 ? true : undefined,
        },
      ],
    };
  }

  // thread.started / turn.started / turn.completed → 不映射为用户可见消息
  return null;
}

// ---------------------------------------------------------------------------
// 子进程辅助函数
// ---------------------------------------------------------------------------

function spawnCodex(
  args: string[],
  cwd?: string,
  stdinText?: string,
): ChildProcess {
  const allArgs = [...args];
  const model = resolveCodexModel();
  if (model) {
    // 把 -m 插在 exec 后面、其他参数前面
    const execIdx = allArgs.indexOf("exec");
    allArgs.splice(execIdx + 1, 0, "-m", model);
  }
  const effort = resolveCodexEffort();
  if (effort) {
    allArgs.push("-c", `model_reasoning_effort="${effort}"`);
  }

  const proc = spawn(CODEX_COMMAND, allArgs, {
    cwd,
    stdio: [stdinText !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: true,
  });

  let stderr = "";
  proc.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  proc.on("close", (code) => {
    if (code !== 0 && stderr.trim()) {
      console.error(
        `[Codex stderr] exit=${code}: ${stderr.trim().slice(0, 2000)}`,
      );
    }
  });

  if (stdinText !== undefined) {
    proc.stdin!.write(stdinText);
    proc.stdin!.end();
  }
  return proc;
}

async function* readJsonLines(
  proc: ChildProcess,
  signal?: AbortSignal,
): AsyncGenerator<CodexEvent> {
  const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });
  // abort 时主动 close readline，避免等待 Windows 管道自然关闭（可能延迟数分钟）
  const onAbort = () => { rl.close(); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for await (const line of rl) {
      if (signal?.aborted) break;
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        yield JSON.parse(trimmed) as CodexEvent;
      } catch {
        // 非 JSON 行静默跳过（如 "Reading prompt from stdin..."）
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// 适配器实现
// ---------------------------------------------------------------------------

class CodexAdapter implements ToolAdapter {
  readonly displayName = "Codex";
  readonly sessionDescPrefix = "Codex Session:";
  private metaStore: CodexSessionMetaStore;

  constructor(metaStore: CodexSessionMetaStore) {
    this.metaStore = metaStore;
  }

  // createSession: 生成 sessionId，记录 cwd，不创建 Codex 线程（延迟到首次 prompt）
  async createSession(cwd: string): Promise<CreateSessionResult> {
    const sessionId = randomUUID();
    await this.metaStore.set(sessionId, { cwd });
    return { sessionId };
  }

  async *prompt(
    sessionId: string,
    userText: string,
    cwd: string,
    signal?: AbortSignal,
  ): AsyncIterable<UnifiedStreamMessage> {
    let meta = await this.metaStore.get(sessionId);
    const threadId = meta?.threadId;
    const isFirstPrompt = !threadId;

    // 首次 prompt: codex exec 创建新线程
    // 后续 prompt: codex exec resume 恢复已有线程（resume 不接受 -C，cwd 继承自原线程）
    const args = isFirstPrompt
      ? [...CODEX_BASE_ARGS, "-C", cwd, "-"]
      : [...CODEX_BASE_ARGS, "resume", threadId, "-"];

    const proc = spawnCodex(args, cwd, userText);

    // 关键：spawn 用了 shell:true，proc.pid 指向的是壳进程（cmd.exe / sh）。
    // 真正干活的是壳的孙子 codex.exe。普通 proc.kill() 在 Windows 上只杀第一层，
    // 会留下幽灵 node + codex.exe 继续烧 token、stream-state 永远停在 running。
    // 因此 abort 与 finally 都必须用 killProcessTree 整棵进程树一起收尸。
    const onAbort = () => { void killProcessTree(proc.pid); };
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      for await (const raw of readJsonLines(proc, signal)) {
        if (signal?.aborted) break;

        if (
          isFirstPrompt &&
          raw.type === "thread.started" &&
          raw.thread_id
        ) {
          void this.metaStore
            .setThreadId(sessionId, raw.thread_id)
            .catch(() => {});
        }

        const normalized = normalizeCodexMessage(raw);
        if (normalized) yield normalized;
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      await killProcessTree(proc.pid);
    }
  }

  async getSessionInfo(
    sessionId: string,
  ): Promise<SessionInfo | undefined> {
    const meta = await this.metaStore.get(sessionId);
    if (!meta) return undefined;
    return { sessionId, cwd: meta.cwd };
  }

  async closeSession(_sessionId: string): Promise<void> {
    // no-op：子进程由 prompt 的 finally 自动 kill
  }
}

// ---------------------------------------------------------------------------
// 工厂函数
// ---------------------------------------------------------------------------

export interface CreateCodexAdapterOptions {
  metaStore?: CodexSessionMetaStore;
}

export function createCodexAdapter(
  options: CreateCodexAdapterOptions = {},
): ToolAdapter {
  return new CodexAdapter(
    options.metaStore ?? defaultCodexSessionMetaStore,
  );
}