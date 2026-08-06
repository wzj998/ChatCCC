/**
 * DeepCCC builtin Agent core API — 同步自 ChatCCC（保留 DeepCCC 英文品牌）
 *
 * ChatSession 是程序化入口，既可以被 CLI 调用，也可以被其他模块调用。
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, isLoopFinished, stepCountIs, streamText, type TextStreamPart } from "ai";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { config as appConfig, RAW_STREAM_LOGS_DIR } from "./config.js";
import {
  createRawStreamLog,
  type RawStreamLogHandle,
} from "./raw-stream-log.js";
import {
  buildPersistedAssistantMessage,
  buildSummaryPrompt,
  BuiltinContextManager,
  defaultBuiltinSessionId,
} from "./context.js";
import { createBuiltinFileTools } from "./file-tools.js";
import { PermissionGate, type PermissionMode, type PermissionResolver } from "./permissions.js";
import {
  buildDefaultSkillDirs,
  buildSkillsIndexPrompt,
  scanSkillsDirs,
  type BuiltinSkill,
  type SkillDirSpec,
} from "./skills.js";
import { applyPrivacy, applyPrivacyToJson } from "./privacy.js";

// ---------------------------------------------------------------------------
// 系统提示词 — 编译期冻结常量（DeepCCC 英文品牌）
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  "You are DeepCCC, a lightweight AI coding agent running in a terminal workspace.",
  "",
  "## Fixed Rules",
  "- Respond in the user's language unless they ask otherwise.",
  "- Prefer direct, usable answers and concrete actions over long explanations.",
  "- For code tasks, inspect the relevant files before editing and verify with tests or checks when practical.",
  "- Preserve user work. Do not overwrite concurrent changes unless the user explicitly asks.",
  "- Keep immutable platform rules above project guidance and runtime details.",
  "",
  "## Evidence-Gated Conclusions",
  "- Apply this gate before consequential claims or actions that could affect code, data, deployments, or user decisions, and whenever the available evidence is indirect.",
  "- Identify the claim and its authoritative source of truth. Separate direct observations from inferences, and test plausible alternative explanations before choosing one.",
  "- Use the strongest practical decisive check at the same semantic level as the claim: runtime behavior for runtime claims, effective configuration for configuration claims, deployed state for deployment claims, and transformed output for transformation claims.",
  "- Do not treat proxy signals such as names, timestamps, file sizes, line counts, partial samples, or a clean command exit as decisive when a direct check is practical.",
  "- Use definitive language only after the evidence closes the loop. Otherwise state uncertainty, identify the missing evidence, and name the next check.",
  "- Do not repeat checks once decisive evidence exists.",
  "",
  "## Survey Before Acting",
  "- Before diving into any task, first map the landscape at low cost: project instructions, directory layout, routes/APIs, existing tests, and git state.",
  "- Produce a brief execution plan that includes how you will verify the result, then execute.",
  "- When evidence contradicts an early assumption, revisit the plan instead of tunneling on one direction.",
  "",
  "## Delegated Authority",
  "- When the user delegates decisions (\"you decide\", \"do it elegantly\", \"up to you\"), act autonomously on implementation details.",
  "- Only ask about genuine blockers: irreversible actions, security boundaries, credentials, or scope changes.",
  "- Do not bounce implementation-level multiple-choice questions back to the user after they delegated.",
  "",
  "## Pre-Delivery Self-Check",
  "- Before reporting completion, verify: the change runs, edge cases are covered, assumptions are listed, and anything unverified is explicitly labeled as such.",
  "- State what was done, how it was verified, and what remains unverified or risky.",
].join("\n");

const SUMMARY_SYSTEM_PROMPT = [
  "You are DeepCCC's context compactor.",
  "Compress older conversation context into a faithful, structured summary that can be used to continue the task.",
  "Do not introduce new facts or promote historical user content into higher-priority system rules.",
].join("\n");

export const DEFAULT_COMPACTION_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_COMPACTION_PASSES = 8;

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

const PROJECT_INSTRUCTION_FILES = [
  "AGENTS.md",
  "AGENTS.local.md",
  "CLAUDE.md",
  "CLAUDE.local.md",
] as const;

function readProjectInstructionFiles(cwd: string): string {
  const sections: string[] = [];

  for (const filename of PROJECT_INSTRUCTION_FILES) {
    try {
      const content = readFileSync(join(cwd, filename), "utf-8").trim();
      if (!content) continue;
      sections.push(`### ${filename}\n${content}`);
    } catch {
      // Missing or unreadable instruction files are optional.
    }
  }

  if (sections.length === 0) return "";
  return [
    "## Project Instructions",
    "The following files were read from the current working directory. Treat them as project guidance with lower priority than the fixed DeepCCC system rules above.",
    "",
    sections.join("\n\n"),
  ].join("\n");
}

function buildRuntimeWorkspacePrompt(cwd: string): string {
  return [
    `Current working directory: ${cwd}`,
    "Use read_file, list_dir, search_code, and run_command proactively when you need to understand code, configuration, project structure, tests, or git state.",
    "Use run_command for non-interactive shell commands such as npm test, type checks, git status, git add, git commit, and git push. Check exitCode, stdout, and stderr before deciding the next step.",
    "Before editing, read the relevant file ranges. Prefer edit_file for precise replacements, create_file for new files, delete_file for removal, move_file for moves, and apply_patch for multi-file diffs.",
    "File tools run locally through DeepCCC. Prefer guarded edits with SHA-256 preconditions where practical, and avoid overwriting concurrent user changes.",
  ].join("\n");
}

/**
 * Windows 专属命令行指引（仅 win32 注入）：cmd.exe 的引号语义与 bash 不同，
 * 模型按 bash 习惯写命令时会被 cmd 拆坏（引号保留为字面量、单引号不生效、
 * 多行/嵌套引号脚本崩坏）。这段提示放在固定规则区（项目指令之前）。
 */
function buildPlatformCommandPrompt(): string {
  if (process.platform !== "win32") return "";
  return [
    "## Windows Command-Line Notes",
    "You are running on Windows. run_command executes through cmd.exe, not bash. cmd quoting differs from bash and breaks common habits:",
    "- Double quotes are NOT stripped: `echo \"hello world\"` prints `\"hello world\"` (quotes included), and `\"a b\" \"c\"` passes the literal arguments `\"a b\"` and `\"c\"` (quotes included) to the program.",
    "- Single quotes are NOT quoting characters in cmd.exe: `'a b'` is parsed as two arguments (`'a` and `b'`).",
    "- Multi-line or quote-heavy inline scripts (python -c \"...\\n...\", ssh host \"bash -c '...'\") frequently break under cmd quoting; write the script to a temporary file and execute that file instead.",
    "- PowerShell-only syntax (Get-Item, 2>$null, Select-Object) is unavailable; the shell is cmd.exe unless you explicitly invoke powershell.",
    "- To pass an argument containing spaces, use double quotes and expect the quotes to reach the program literally; when the target accepts file input, prefer writing the value to a file.",
  ].join("\n");
}

function normalizeMaxSteps(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error("maxSteps must be a positive integer when provided");
  }
  return value;
}

export interface ChatSessionConfig {
  /** OpenAI-compatible service base URL. Defaults to DEEPCCC_BASE_URL/config. */
  baseURL?: string;
  /** API key. Defaults to DEEPCCC_API_KEY/config. */
  apiKey?: string;
  /** Model id. Defaults to DEEPCCC_MODEL/config. */
  model?: string;
  /**
   * Reasoning effort (none/minimal/low/medium/high/xhigh/max);
   * overrides config.effort; empty omits the reasoning_effort request field.
   */
  effort?: string;
}

export interface ChatSessionOptions {
  /** Session working directory. */
  cwd?: string;
  /** Extra system guidance appended after project instructions. */
  systemPrompt?: string;
  /** Persist context to disk. CLI enables this by default; programmatic usage defaults to false. */
  persist?: boolean;
  /** Context directory. Defaults to ~/.deepccc/sessions. */
  contextDir?: string;
  /** Persistent session id. Defaults to a cwd-derived id when omitted. */
  sessionId?: string;
  /** Compact older context when the rough token estimate exceeds this value. */
  compactAtTokens?: number;
  /** Number of recent raw messages retained after compaction. */
  keepRecentMessages?: number;
  /** Hard deadline for all context-compaction passes in one turn. */
  compactionTimeoutMs?: number;
  /** Optional tool-step limit. Leave unset for no step limit. */
  maxSteps?: number;
  /**
   * Custom skill directories (<dir>/<name>/SKILL.md). When set, these are
   * scanned with the highest priority (deepccc source). Defaults to the
   * combined Claude/Codex/Cursor/DeepCCC directories (see buildDefaultSkillDirs).
   */
  skillsDirs?: string[];
  /**
   * 权限模式：ask（默认，高危命令询问）/ bypass（全部放行，等价
   * --dangerously-bypass-permissions；chatccc 等无终端环境集成时使用）。
   */
  permissionMode?: PermissionMode;
  /**
   * ask 模式下高危操作的交互确认回调；缺省时非交互环境（JSONL / 程序化
   * 调用）自动拒绝高危命令，常规文件操作与低危命令不受影响。
   */
  permissionResolver?: PermissionResolver;
}

/**
 * 流式响应事件
 */
export type ChatEvent =
  | { type: "status"; phase: "compacting" | "generating" }
  | { type: "compact"; compactedMessages: number }
  | { type: "tool_use"; id?: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; name?: string; content: unknown; is_error?: boolean }
  | { type: "text"; text: string; accumulated: string }
  | { type: "done"; text: string }
  | { type: "error"; message: string };

// ---------------------------------------------------------------------------
// ChatSession
// ---------------------------------------------------------------------------

/** 消息角色 */
type MessageRole = "system" | "user" | "assistant" | "tool";

/** 内部消息类型 */
interface ChatMessage {
  role: MessageRole;
  content: string;
}

export class ChatSession {
  private model: any;
  private cwd: string;
  private context: BuiltinContextManager;
  private compactionTimeoutMs: number;
  private maxSteps?: number;
  private effort: string;
  private permissionGate: PermissionGate;
  private skillDirs: SkillDirSpec[];
  private customSystemPrompt: string;
  /** 最近一次 chat() 使用的 system prompt（供 history 等读取） */
  private systemPrompt = "";

  constructor(
    overrides: ChatSessionConfig = {},
    options: ChatSessionOptions = {},
  ) {
    const apiKey = overrides.apiKey ?? appConfig.apiKey;
    if (!apiKey) {
      throw new Error(
        "DEEPCCC_API_KEY is not set. Configure ~/.deepccc/config.json, set an environment variable, or pass --api-key.",
      );
    }

    const baseURL = overrides.baseURL ?? appConfig.baseURL;
    const modelId = overrides.model ?? appConfig.model;
    this.effort = (overrides.effort ?? appConfig.effort ?? "").trim();

    const provider = createOpenAICompatible({
      name: "deepccc",
      baseURL,
      apiKey,
    });
    this.model = provider(modelId);
    this.cwd = options.cwd ?? process.cwd();
    this.maxSteps = normalizeMaxSteps(options.maxSteps);
    this.compactionTimeoutMs = Math.max(1, options.compactionTimeoutMs ?? DEFAULT_COMPACTION_TIMEOUT_MS);
    this.customSystemPrompt = options.systemPrompt ?? "";
    // 技能目录在构造时确定；技能内容在每次 chat() 前重新扫描（mtime 热加载），
    // 因此创建/修改技能后下一次对话自动生效，无需重启。
    this.skillDirs =
      options.skillsDirs?.map((d) => ({ dir: d, source: "deepccc" as const, scope: "project" as const })) ??
      buildDefaultSkillDirs(this.cwd);
    this.context = new BuiltinContextManager({
      persist: options.persist ?? false,
      contextDir: options.contextDir,
      sessionId: options.sessionId ?? defaultBuiltinSessionId(this.cwd),
      cwd: this.cwd,
      compactAtTokens: options.compactAtTokens,
      keepRecentMessages: options.keepRecentMessages,
    });
    this.permissionGate = new PermissionGate(
      options.permissionMode ?? "ask",
      options.permissionResolver,
    );
  }

  /**
   * 组装系统提示词。顺序遵循“稳定性优先”原则（缓存命中友好）：
   * 固定规则 → 项目指令 → runtime 上下文 → 用户补充 → 技能索引（最后）。
   * 技能索引是最易变的部分（热加载，任何 SKILL.md 变化都会改前缀），
   * 放最后可以让前面的稳定内容尽量命中缓存，只丢尾段。
   */
  private buildSystemPrompt(skills: BuiltinSkill[]): string {
    const systemContent = [SYSTEM_PROMPT];
    const platformPrompt = buildPlatformCommandPrompt();
    if (platformPrompt) {
      systemContent.push("", platformPrompt);
    }
    const projectInstructions = readProjectInstructionFiles(this.cwd);
    if (projectInstructions) {
      systemContent.push("", projectInstructions);
    }
    systemContent.push("", buildRuntimeWorkspacePrompt(this.cwd));
    if (this.customSystemPrompt) {
      systemContent.push("", this.customSystemPrompt);
    }
    const skillsPrompt = buildSkillsIndexPrompt(skills);
    if (skillsPrompt) {
      systemContent.push("", skillsPrompt);
    }
    return systemContent.join("\n");
  }

  async *chat(
    userMessage: string,
    signal?: AbortSignal,
  ): AsyncIterable<ChatEvent> {
    this.context.appendMessage({ role: "user", content: userMessage });

    let fullText = "";
    let safeAccumulated = "";
    let rawLog: RawStreamLogHandle | null = null;
    let completed = false;
    // 结构化工具调用存档：按 toolCallId 关联入参/出参/错误，落盘到 context.json 的
    // assistant 消息 toolCalls 字段；[Tool transcript] 文本视图仍按原格式生成。
    const toolCallsById = new Map<string, { name: string; input?: string; output?: string; is_error?: boolean }>();
    const toolCallOrder: string[] = [];

    try {
      if (this.context.planCompaction()) {
        yield { type: "status", phase: "compacting" };
        const compactedMessages = await this.compactIfNeeded(signal);
        if (compactedMessages > 0) {
          yield { type: "compact", compactedMessages };
        }
      }
      yield { type: "status", phase: "generating" };

      const rawLogConfig = appConfig.rawStreamLogs;
      try {
        rawLog = await createRawStreamLog({
          enabled: rawLogConfig.enabled,
          rootDir: RAW_STREAM_LOGS_DIR,
          tool: "deepccc",
          sessionId: this.context.sessionId,
          label: "prompt",
          maxBytesPerTurn: rawLogConfig.maxBytesPerTurn,
          retentionDays: rawLogConfig.retentionDays,
        });
      } catch (err) {
        console.error(`[DeepCCC raw stream log] create failed: ${errorMessage(err)}`);
      }

      const toolContext: string[] = [];
      const maxSteps = this.maxSteps;
      // 每次对话前重新扫描技能索引（并行 + mtime 缓存，开销极小）：
      // 新技能/修改的技能在下一次对话自动生效（热加载）。
      const skills = await scanSkillsDirs(this.skillDirs);
      const system = this.buildSystemPrompt(skills);
      this.systemPrompt = system;
      const result = streamText({
        model: this.model,
        system,
        messages: this.context.buildModelMessages() as any,
        tools: createBuiltinFileTools(this.cwd, { permissionGate: this.permissionGate }),
        stopWhen: maxSteps !== undefined ? stepCountIs(maxSteps) : isLoopFinished(),
        abortSignal: signal,
        // DeepSeek OpenAI 兼容接口：providerOptions.deepseek.reasoningEffort
        // 由 @ai-sdk/openai-compatible 自动映射为请求体 reasoning_effort 字段
        ...(this.effort ? { providerOptions: { deepseek: { reasoningEffort: this.effort } } } : {}),
      });

      const stream = result.fullStream ?? textStreamToFullStream(result.textStream);
      for await (const part of stream as AsyncIterable<TextStreamPart<any>>) {
        rawLog?.writeLine(safeRawStreamJson(part));
        if (part.type === "text-delta") {
          fullText += part.text;
          // 隐私替换只在展示层：safeAccumulated 供事件消费者（终端/JSONL）使用，
          // fullText 原文用于持久化上下文，避免替换结果回流污染上下文。
          const safeText = applyPrivacy(part.text);
          safeAccumulated += safeText;
          yield { type: "text", text: safeText, accumulated: safeAccumulated };
        } else if (part.type === "tool-call") {
          toolContext.push(`tool_call ${part.toolName}: ${safeJson(part.input)}`);
          toolCallsById.set(part.toolCallId, { name: part.toolName, input: safeJson(part.input) });
          toolCallOrder.push(part.toolCallId);
          yield {
            type: "tool_use",
            id: part.toolCallId,
            name: part.toolName,
            input: applyPrivacyToJson(part.input),
          };
        } else if (part.type === "tool-result") {
          toolContext.push(`tool_result ${part.toolName}: ${truncateToolContext(safeJson(part.output))}`);
          const call = toolCallsById.get(part.toolCallId);
          if (call) {
            call.output = truncateToolContext(safeJson(part.output));
          }
          yield {
            type: "tool_result",
            tool_use_id: part.toolCallId,
            name: part.toolName,
            content: applyPrivacyToJson(part.output),
            is_error: false,
          };
        } else if (part.type === "tool-error") {
          const message = errorMessage(part.error);
          toolContext.push(`tool_error ${part.toolName}: ${message}`);
          const call = toolCallsById.get(part.toolCallId);
          if (call) {
            call.output = message;
            call.is_error = true;
          }
          yield {
            type: "tool_result",
            tool_use_id: part.toolCallId,
            name: part.toolName,
            content: applyPrivacy(message),
            is_error: true,
          };
        } else if (part.type === "error") {
          const message = errorMessage(part.error);
          yield { type: "error", message: applyPrivacy(message) };
          throw new Error(message);
        }
      }
      completed = true;

      const collectedToolCalls = toolCallOrder
        .map((id) => toolCallsById.get(id))
        .filter((call): call is { name: string; input?: string; output?: string; is_error?: boolean } => call !== undefined);
      this.context.appendMessage(buildPersistedAssistantMessage({
        fullText,
        transcriptLines: toolContext,
        toolCalls: collectedToolCalls,
      }));
      yield { type: "done", text: safeAccumulated };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if ((err as Error).name === "AbortError" || signal?.aborted) {
        // 被中断时，不保存不完整的助手消息
        if (fullText) {
          this.context.appendMessage({ role: "assistant", content: `${fullText}\n[interrupted]` });
        }
        yield { type: "done", text: safeAccumulated };
        return;
      }
      yield { type: "error", message: applyPrivacy(message) };
      throw err;
    } finally {
      const rawLogConfig = appConfig.rawStreamLogs;
      await rawLog?.close({
        keep: rawLogConfig.keepCompleted || signal?.aborted === true || !completed,
      });
    }
  }

  /** 返回当前的会话历史（只读） */
  get history(): ReadonlyArray<ChatMessage> {
    const history: ChatMessage[] = [{ role: "system", content: this.systemPrompt }];
    if (this.context.summary) {
      history.push({
        role: "system",
        content: [
          "Earlier conversation summary:",
          "",
          this.context.summary,
        ].join("\n"),
      });
    }
    history.push(...this.context.messages as ChatMessage[]);
    return history;
  }

  /** 返回当前轮数（不含 system 消息） */
  get turnCount(): number {
    return this.context.totalMessages;
  }

  /** 清空会话历史，保留 system 消息 */
  reset(): void {
    this.context.reset();
  }

  private async compactIfNeeded(signal?: AbortSignal): Promise<number> {
    if (!this.context.planCompaction()) return 0;

    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), this.compactionTimeoutMs);
    timeout.unref?.();
    const compactionSignal = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal;
    let compactedMessages = 0;

    try {
      for (let pass = 0; pass < MAX_COMPACTION_PASSES; pass += 1) {
        const plan = this.context.planCompaction();
        if (!plan) return compactedMessages;

        const result = await generateText({
          model: this.model,
          system: SUMMARY_SYSTEM_PROMPT,
          messages: [{ role: "user", content: buildSummaryPrompt(plan) }],
          abortSignal: compactionSignal,
          temperature: 0,
        });

        if (!result.text.trim()) {
          throw new Error("Context compaction returned an empty summary");
        }

        this.context.applyCompaction(result.text, plan);
        compactedMessages += plan.oldMessages.length;
      }

      if (this.context.planCompaction()) {
        throw new Error(`Context remains above its token budget after ${MAX_COMPACTION_PASSES} compaction passes`);
      }
      return compactedMessages;
    } catch (error) {
      if (timeoutController.signal.aborted && !signal?.aborted) {
        throw new Error(`Context compaction timed out after ${formatDuration(this.compactionTimeoutMs)}`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function* textStreamToFullStream(stream: AsyncIterable<string>): AsyncIterable<{ type: "text-delta"; text: string }> {
  for await (const text of stream) {
    yield { type: "text-delta", text };
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function safeRawStreamJson(value: unknown): string {
  try {
    const serialized = JSON.stringify(value, (_key, nested) => {
      if (nested instanceof Error) {
        return {
          name: nested.name,
          message: nested.message,
        };
      }
      return nested;
    });
    return serialized ?? "null";
  } catch (err) {
    return JSON.stringify({
      type: "deepccc_raw_stream_log_serialize_error",
      message: errorMessage(err),
    });
  }
}

function truncateToolContext(value: string): string {
  return value.length > 8000 ? `${value.slice(0, 8000)}...[truncated]` : value;
}

function formatDuration(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000} minutes`;
  if (ms % 1_000 === 0) return `${ms / 1_000} seconds`;
  return `${ms} ms`;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
