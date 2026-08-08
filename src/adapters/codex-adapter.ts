// =============================================================================
// codex-adapter.ts — OpenAI Codex CLI 适配器
// =============================================================================
// 通过 codex exec --json 与 Codex CLI 交互。
// - createSession: 生成 UUID sessionId，记录 cwd，不创建 Codex 线程（延迟到首次 prompt）
// - prompt: 首次调用用 codex exec 创建线程，后续用 codex exec resume 恢复
// - getSessionInfo: 从持久化映射读取 cwd / threadId
// =============================================================================

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type {
  ToolAdapter,
  ToolPromptOptions,
  UnifiedBlock,
  UnifiedStreamMessage,
  CreateSessionResult,
  SessionInfo,
} from "./adapter-interface.ts";
import { parseUserCommand } from "./adapter-interface.ts";
import {
  defaultCodexSessionMetaStore,
  type CodexSessionMetaStore,
} from "./codex-session-meta-store.ts";
import { killProcessTree } from "./proc-tree-kill.ts";
import { config, PROJECT_ROOT, RAW_STREAM_LOGS_DIR } from "../config.ts";
import {
  createRawStreamLog,
  type RawStreamLogHandle,
} from "./raw-stream-log.ts";
import { readJsonLinesWithBadJsonIdleWatchdog } from "./jsonl-stream.ts";

// ---------------------------------------------------------------------------
// 特殊注入提示
// ---------------------------------------------------------------------------

const CODEX_SPECIFIC_PROMPT_PATH = join(
  PROJECT_ROOT,
  "agent-prompts",
  "codex_specific.md",
);

function readCodexSpecificInjectionPrompt(): string | null {
  try {
    if (!existsSync(CODEX_SPECIFIC_PROMPT_PATH)) return null;
    const prompt = readFileSync(CODEX_SPECIFIC_PROMPT_PATH, "utf-8").trim();
    return prompt.length > 0 ? prompt : null;
  } catch {
    return null;
  }
}

function buildCodexPromptText(userText: string): string {
  const prompt = readCodexSpecificInjectionPrompt();
  if (!prompt) return userText;

  return [
    "[ChatCCC Codex-specific injection prompt]",
    prompt,
    "[/ChatCCC Codex-specific injection prompt]",
    "",
    userText,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 命令与参数
// ---------------------------------------------------------------------------

/** 可通过 config.json codex.path 自定义 Codex 可执行文件路径 */
function detectCodexCommand(): string {
  return config.codex.path || "codex";
}

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
  // agent_message 只是 Codex 的一条阶段性文本 item。即使内容看起来像完整答复，
  // 后面仍可能继续发出工具调用，因此不能用它关闭 response-stall watchdog。
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

  // turn.completed 是 Codex 对整轮完成的权威确认。正文已经由之前的
  // agent_message 累计，这里只发送空终态信号，避免重复追加最终文本。
  if (msg.type === "turn.completed") {
    return {
      type: "assistant",
      blocks: [],
      isFinalResponse: true,
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
          id: msg.item.id,
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

  // thread.started / turn.started → 不映射为用户可见消息
  return null;
}

// ---------------------------------------------------------------------------
// 子进程辅助函数
// ---------------------------------------------------------------------------

export function buildCodexInvocationArgs(
  args: string[],
  modelOverride?: string,
  effortOverride?: string,
  fastModeOverride?: boolean,
): string[] {
  const allArgs = [...args];
  const model = modelOverride ?? resolveCodexModel();
  if (model) {
    // 把 -m 插在 exec 后面、其他参数前面
    const execIdx = allArgs.indexOf("exec");
    allArgs.splice(execIdx + 1, 0, "-m", model);
  }
  const effort = effortOverride ?? resolveCodexEffort();
  if (effort) {
    allArgs.push("-c", `model_reasoning_effort="${effort}"`);
  }
  const fastMode = fastModeOverride ?? config.codex.fastMode;
  allArgs.push("-c", `service_tier="${fastMode ? "fast" : "default"}"`);
  return allArgs;
}

function spawnCodex(
  args: string[],
  cwd?: string,
  stdinText?: string,
  modelOverride?: string,
  effortOverride?: string,
  fastModeOverride?: boolean,
): ChildProcess {
  const allArgs = buildCodexInvocationArgs(
    args,
    modelOverride,
    effortOverride,
    fastModeOverride,
  );

  const proc = spawn(detectCodexCommand(), allArgs, {
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
  rawLog?: RawStreamLogHandle | null,
): AsyncGenerator<CodexEvent> {
  yield* readJsonLinesWithBadJsonIdleWatchdog<CodexEvent>({
    input: proc.stdout!,
    tool: "codex",
    tag: "codex",
    signal,
    rawLog,
    parse: (line) => JSON.parse(line) as CodexEvent,
  });
}

// ---------------------------------------------------------------------------
// 适配器实现
// ---------------------------------------------------------------------------

class CodexAdapter implements ToolAdapter {
  readonly displayName = "Codex";
  readonly sessionDescPrefix = "Codex Session:";
  private metaStore: CodexSessionMetaStore;
  private modelOverride: string | undefined;
  private effortOverride: string | undefined;
  private fastModeOverride: boolean | undefined;

  constructor(
    metaStore: CodexSessionMetaStore,
    modelOverride?: string,
    effortOverride?: string,
    fastModeOverride?: boolean,
  ) {
    this.metaStore = metaStore;
    this.modelOverride = modelOverride;
    this.effortOverride = effortOverride;
    this.fastModeOverride = fastModeOverride;
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
    options?: ToolPromptOptions,
  ): AsyncIterable<UnifiedStreamMessage> {
    let meta = await this.metaStore.get(sessionId);
    const threadId = meta?.threadId;
    const isFirstPrompt = !threadId;

    // 首次 prompt: codex exec 创建新线程
    // 后续 prompt: codex exec resume 恢复已有线程（resume 不接受 -C，cwd 继承自原线程）
    const cmd = parseUserCommand(userText);
    const baseArgs = cmd.mode
      ? ["exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check"]
      : CODEX_BASE_ARGS;
    const args = isFirstPrompt
      ? [...baseArgs, "-C", cwd, "-"]
      : [...baseArgs, "resume", threadId, "-"];

    const proc = spawnCodex(
      args,
      cwd,
      buildCodexPromptText(userText),
      this.modelOverride,
      this.effortOverride,
      this.fastModeOverride,
    );
    if (proc.pid !== undefined) options?.onProcessStart?.({ pid: proc.pid });

    const rawLogConfig = config.rawStreamLogs.codex;
    let rawLog: RawStreamLogHandle | null = null;
    try {
      rawLog = await createRawStreamLog({
        enabled: rawLogConfig.enabled,
        rootDir: RAW_STREAM_LOGS_DIR,
        tool: "codex",
        sessionId,
        label: "prompt",
        maxBytesPerTurn: rawLogConfig.maxBytesPerTurn,
        retentionDays: rawLogConfig.retentionDays,
      });
    } catch (err) {
      console.error(`[Codex raw stream log] create failed: ${(err as Error).message}`);
    }

    // 关键：spawn 用了 shell:true，proc.pid 指向的是壳进程（cmd.exe / sh）。
    // 真正干活的是壳的孙子 codex.exe。普通 proc.kill() 在 Windows 上只杀第一层，
    // 会留下幽灵 node + codex.exe 继续烧 token、stream-state 永远停在 running。
    // 因此 abort 与 finally 都必须用 killProcessTree 整棵进程树一起收尸。
    const onAbort = () => { void killProcessTree(proc.pid); };
    signal?.addEventListener("abort", onAbort, { once: true });
    let completed = false;

    try {
      for await (const raw of readJsonLines(proc, signal, rawLog)) {
        if (signal?.aborted) break;
        if (raw.type === "turn.completed") completed = true;

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
      await rawLog?.close({ keep: rawLogConfig.keepCompleted || signal?.aborted === true || !completed });
      if (proc.pid !== undefined) options?.onProcessExit?.({ pid: proc.pid });
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
  /** per-session 模型覆盖（/model 命令）；传了就用，不传走全局 codex.model */
  model?: string;
  effort?: string;
  fastMode?: boolean;
}

export function createCodexAdapter(
  options: CreateCodexAdapterOptions = {},
): ToolAdapter {
  return new CodexAdapter(
    options.metaStore ?? defaultCodexSessionMetaStore,
    options.model,
    options.effort,
    options.fastMode,
  );
}
