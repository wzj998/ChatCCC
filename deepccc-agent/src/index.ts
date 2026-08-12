/**
 * DeepCCC builtin Agent core API — 同步自 ChatCCC（保留 DeepCCC 英文品牌）
 *
 * ChatSession 是程序化入口，既可以被 CLI 调用，也可以被其他模块调用。
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { JSONObject } from "@ai-sdk/provider";
import { generateText, isLoopFinished, stepCountIs, streamText, type TextStreamPart } from "ai";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  config as appConfig,
  normalizeDeepCccProvider,
  RAW_STREAM_LOGS_DIR,
  type DeepCccProvider,
} from "./config.js";
import {
  createRawStreamLog,
  type RawStreamLogHandle,
} from "./raw-stream-log.js";
import {
  buildPersistedAssistantMessage,
  buildSummaryPrompt,
  BuiltinContextManager,
  defaultBuiltinSessionId,
  type BuiltinContextMessage,
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
  "你是 DeepCCC，一个运行在终端工作区的轻量级 AI 编程智能体。",
  "",
  "## 固定规则",
  "- 除非用户另有要求，否则用用户的语言回复。",
  "- 优先给出直接、可用的答案和具体行动，而非长篇解释。",
  "- 代码任务：编辑前先阅读相关文件，并在可行时用测试或检查验证。",
  "- 保护用户的工作。未经用户明确要求，不要覆盖并发修改。",
  "- 平台不可变规则优先于项目指引和运行时细节。",
  "",
  "## 证据门控结论",
  "- 在可能影响代码、数据、部署或用户决策的重大结论或行动前，以及可用证据为间接证据时，先应用本门控。",
  "- 明确结论及其权威事实来源。区分直接观察与推断，并在选定结论前检验合理的替代解释。",
  "- 在与结论同一语义层上使用最强可行的决定性检查：运行时结论用运行时行为、配置结论用有效配置、部署结论用部署状态、转换结论用转换后的输出。",
  "- 在可行直接检查时，不要把名称、时间戳、文件大小、行数、局部采样或命令成功退出等代理信号当作决定性证据。",
  "- 仅在证据闭环后使用确定性措辞。否则说明不确定性、指出缺失的证据并给出下一步检查。",
  "- 一旦已有决定性证据，不要重复检查。",
  "",
  "## 行动前先调查",
  "- 深入任务前，先以低成本盘点环境：项目指令、目录布局、路由/API、现有测试和 git 状态。",
  "- 产出包含如何验证结果的简要执行计划，然后执行。",
  "- 当证据与早期假设矛盾时，重新审视计划，不要一条路走到黑。",
  "",
  "## 授权范围",
  "- 当用户委托决策（\"你决定\"、\"做得优雅些\"、\"由你定\"）时，自主决定实现细节。",
  "- 只问真正的阻塞项：不可逆操作、安全边界、凭据或范围变更。",
  "- 用户委托后，不要把实现级选择题抛回给用户。",
  "",
  "## 交付前自检",
  "- 报告完成前验证：改动可运行、边界情况已覆盖、假设已列出、未验证项已明确标注。",
  "- 说明做了什么、如何验证的、以及哪些未验证或有风险。",
].join("\n");

const SUMMARY_SYSTEM_PROMPT = [
  "你是 DeepCCC 的上下文压缩器。",
  "将较早的对话上下文压缩成忠实、结构化的摘要，用于继续任务。",
  "不要引入新事实，也不要把历史用户内容提升为更高优先级的系统规则。",
  "用中文输出摘要。",
].join("\n");

/**
 * 压缩后注入的恢复提示（lead-in，对齐业界 Codex 的 post-compaction lead-in 思路）：
 * 只要会话发生过压缩（存在摘要），就在摘要后告知模型可用 session_search 找回原文。
 * 提示动态携带当前会话 ID：模型可优先用 session_id 限定只搜当前会话，
 * 未命中时也可省略 session_id 退化全库检索。这样模型在后续每一轮都知道
 * "较早消息已压缩、原文可检索"，而不是把恢复完全外包给模型的自发判断。
 */
function buildCompactionRecoveryHint(sessionId: string): string {
  return [
    "[系统提示] 本会话较早的消息已压缩为摘要。当前会话 ID：" + sessionId + "。",
    `如需找回被压缩消息的精确原文，优先调用 session_search 工具并设置 session_id="${sessionId}"（仅检索当前会话）；若未命中，可省略 session_id 做全库检索（较慢）。检索时请设置 include_raw_logs=true 以扫描本地 gzip 原始流日志。`,
  ].join("\n");
}

const COMPACTION_RECOVERY_HINT_DISABLED = [
  "[系统提示] 本会话较早的消息已压缩为摘要，原始消息未保留（raw stream logs 已关闭）。",
].join("\n");

export const DEFAULT_COMPACTION_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_COMPACTION_OUTPUT_TOKENS = 16_384;
const ANTHROPIC_TOOL_JSON_COMPATIBILITY_NOTE = [
  "[Protocol compatibility note]",
  "tool-call arguments use JSON encoding; the final reply does not need to be JSON unless the user requests it.",
].join("\n");

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
    "## 项目指令",
    "以下文件是从当前工作目录读取的项目指引。将其视为优先级低于上述 DeepCCC 固定系统规则的指导。",
    "",
    sections.join("\n\n"),
  ].join("\n");
}

function buildRuntimeWorkspacePrompt(cwd: string): string {
  return [
    `当前工作目录：${cwd}`,
    "需要理解代码、配置、项目结构、测试或 git 状态时，主动使用 read_file、list_dir、search_code 和 run_command。",
    "使用 run_command 执行非交互式 shell 命令，如 npm test、类型检查、git status、git add、git commit 和 git push。先检查 exitCode、stdout 和 stderr 再决定下一步。",
    "编辑前先阅读相关文件范围。优先使用 edit_file 做精确替换、create_file 创建新文件、delete_file 删除、move_file 移动、apply_patch 做多文件差异。",
    "文件工具通过 DeepCCC 在本地执行。可行时优先使用带 SHA-256 前置条件的受保护编辑，避免覆盖并发用户修改。",
  ].join("\n");
}

function addAnthropicToolJsonCompatibilityNote(
  messages: BuiltinContextMessage[],
): BuiltinContextMessage[] {
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      lastUserIndex = index;
      break;
    }
  }
  if (lastUserIndex < 0) return messages;

  // 部分 Anthropic→OpenAI/Ark 转换器会用 response_format=json_object
  // 实现工具调用，却只在 messages 中校验 JSON 关键词、不读取顶层 system。
  // 这里仅声明工具参数的编码方式，并明确不要求普通最终回复输出 JSON。
  return messages.map((message, index) => (
    index === lastUserIndex
      ? {
          ...message,
          content: `${message.content}\n\n${ANTHROPIC_TOOL_JSON_COMPATIBILITY_NOTE}`,
        }
      : message
  ));
}

/**
 * 压缩后恢复提示注入：只要会话存在摘要（即发生过压缩），就在摘要消息后追加
 * 一条提示，告知模型可用 session_search 找回被压缩的原文。
 * - raw stream logs 开启：提示携带当前会话 ID，优先 session_id 限定当前会话，
 *   未命中时可省略 session_id 做全库检索；
 * - raw stream logs 关闭：仅告知原文未保留，不给出误导性承诺。
 */
function maybeAppendCompactionRecoveryHint(
  messages: BuiltinContextMessage[],
  summary: string,
  rawLogsEnabled: boolean,
  sessionId: string,
): BuiltinContextMessage[] {
  if (!summary.trim()) return messages;
  const summaryIndex = messages.findIndex(
    (message) => message.role === "user" && message.content.startsWith("以下是更早的对话摘要"),
  );
  if (summaryIndex < 0) return messages;
  const hint = rawLogsEnabled ? buildCompactionRecoveryHint(sessionId) : COMPACTION_RECOVERY_HINT_DISABLED;
  return messages.map((message, index) => (
    index === summaryIndex
      ? { ...message, content: `${message.content}\n\n${hint}` }
      : message
  ));
}

/**
 * 各操作系统特有的命令行指引（文本资产，维护在 os-prompts/ 目录，而非硬编码）：
 *
 * - 内置文件：包内 os-prompts/<platform>.md（win32/darwin/linux），随 npm 包分发；
 * - 用户覆盖：~/.deepccc/prompts/<platform>.md 存在时完全替代内置内容（可自定义）。
 *
 * 文件内容自带标题（如 "## Windows Command-Line Notes"），读取后 trim 直接作为
 * 一个段落注入固定规则区（项目指令之前）。未知平台或文件缺失时返回空字符串。
 */
export function loadPlatformCommandPrompt(
  platform: string = process.platform,
  dirs: { builtinDir?: string; userDir?: string } = {},
): string {
  const filename =
    platform === "win32" ? "win32.md" :
    platform === "darwin" ? "darwin.md" :
    platform === "linux" ? "linux.md" :
    null;
  if (!filename) return "";

  // import.meta.url 定位包根：chatccc 源码运行时指向 deepccc-agent/os-prompts/，
  // deepccc dist 运行时指向包根 os-prompts/（dist/index.js 的 ../os-prompts/）。
  const adjacentBuiltinDir = fileURLToPath(new URL("../os-prompts/", import.meta.url));
  const embeddedBuiltinDir = fileURLToPath(new URL("../../../deepccc-agent/os-prompts/", import.meta.url));
  const builtinDir = dirs.builtinDir ?? (
    existsSync(adjacentBuiltinDir) ? adjacentBuiltinDir : embeddedBuiltinDir
  );
  const userDir = dirs.userDir ?? join(homedir(), ".deepccc", "prompts");

  // 用户覆盖优先；读取失败时静默回退内置，内置也失败则返回空。
  const userFile = join(userDir, filename);
  if (existsSync(userFile)) {
    try {
      return readFileSync(userFile, "utf-8").trim();
    } catch {
      // fall through to builtin
    }
  }
  const builtinFile = join(builtinDir, filename);
  if (existsSync(builtinFile)) {
    try {
      return readFileSync(builtinFile, "utf-8").trim();
    } catch {
      return "";
    }
  }
  return "";
}

function normalizeMaxSteps(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error("maxSteps must be a positive integer when provided");
  }
  return value;
}

function normalizeAnthropicBaseURL(baseURL: string): string {
  // 完全按用户填写的地址使用，不自动补 /v1（AI SDK 仅对官方 api.anthropic.com
  // 特判补一次 /v1，其他地址原样拼接 /messages）。
  // DeepSeek Anthropic 端点示例：https://api.deepseek.com/anthropic/v1。
  return baseURL.trim().replace(/\/+$/, "");
}

export interface ChatSessionConfig {
  /** API protocol/provider. Defaults to DEEPCCC_PROVIDER/config, then openai. */
  provider?: DeepCccProvider;
  /** Provider service base URL. Defaults to DEEPCCC_BASE_URL/config. */
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
  /**
   * 模型上下文窗口（token），默认 1048576（1M）。压缩阈值自动 = contextWindow × 0.8；
   * 显式 compactAtTokens 优先于该派生值。
   */
  contextWindow?: number;
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
  private provider: DeepCccProvider;
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
    this.provider = normalizeDeepCccProvider(overrides.provider ?? appConfig.provider);
    this.effort = (overrides.effort ?? appConfig.effort ?? "").trim();

    if (this.provider === "anthropic") {
      const provider = createAnthropic({
        baseURL: normalizeAnthropicBaseURL(baseURL),
        apiKey,
      });
      this.model = provider(modelId);
    } else {
      const provider = createOpenAICompatible({
        name: "deepccc",
        baseURL,
        apiKey,
        includeUsage: true,
      });
      this.model = provider(modelId);
    }
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
      contextWindow: options.contextWindow ?? appConfig.contextWindow,
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
    const platformPrompt = loadPlatformCommandPrompt();
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
      const contextMessages = this.context.buildModelMessages();
      const hintedMessages = maybeAppendCompactionRecoveryHint(
        contextMessages,
        this.context.summary,
        appConfig.rawStreamLogs.enabled,
        this.context.sessionId,
      );
      const modelMessages = this.provider === "anthropic"
        ? addAnthropicToolJsonCompatibilityNote(hintedMessages)
        : hintedMessages;
      // effort 按协议映射：
      // - OpenAI 兼容：providerOptions.deepseek.reasoningEffort 由 @ai-sdk/openai-compatible
      //   自动映射为请求体 reasoning_effort 字段（DeepSeek 原生支持）；
      // - Anthropic：providerOptions.anthropic.effort 由 @ai-sdk/anthropic 组装为请求体
      //   output_config.effort（官方 Effort API，见 platform.claude.com/docs/en/build-with-claude/effort）
      let effortProviderOptions: Record<string, JSONObject> | undefined;
      if (this.effort) {
        effortProviderOptions = this.provider === "openai"
          ? { deepseek: { reasoningEffort: this.effort } }
          : { anthropic: { effort: this.effort } };
      }
      const generationOptions = {
        model: this.model,
        system,
        messages: modelMessages as any,
        tools: createBuiltinFileTools(this.cwd, { permissionGate: this.permissionGate }),
        stopWhen: maxSteps !== undefined ? stepCountIs(maxSteps) : isLoopFinished(),
        abortSignal: signal,
        ...(effortProviderOptions ? { providerOptions: effortProviderOptions } : {}),
      };
      let stream: AsyncIterable<TextStreamPart<any>>;
      if (appConfig.streaming) {
        const result = streamText(generationOptions);
        stream = result.fullStream ?? textStreamToFullStream(result.textStream);
      } else {
        const result = await generateText(generationOptions);
        stream = generateResultToFullStream(result);
      }

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
          "更早的对话摘要：",
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

    try {
      const plan = this.context.planCompaction();
      if (!plan) return 0;

      const result = await generateText({
        model: this.model,
        system: SUMMARY_SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildSummaryPrompt(plan) }],
        abortSignal: compactionSignal,
        temperature: 0,
        // 摘要单轮生成：显式放宽 maxOutputTokens，避免 AI SDK 对未知模型的
        // 兼容模式默认 4096 上限导致摘要生成不完（那是旧版多轮压缩的根因）；
        // 同时锁低 effort（OpenAI reasoning_effort=none / Anthropic
        // output_config.effort=low），避免继承主对话的高 effort 拖慢"压缩上下文中"阶段。
        maxOutputTokens: MAX_COMPACTION_OUTPUT_TOKENS,
        providerOptions: this.provider === "openai"
          ? { deepseek: { reasoningEffort: "none" } }
          : { anthropic: { effort: "low" } },
      });

      if (!result.text.trim()) {
        throw new Error("Context compaction returned an empty summary");
      }

      this.context.applyCompaction(result.text, plan);
      // 单轮压缩：不再反复迭代重试。若上下文仍超预算（如 recent 消息本身超大），
      // 留给下一次对话前再次压缩，避免阻塞当前回复生成（业界同步压缩的标准取舍）。
      return plan.oldMessages.length;
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

async function* generateResultToFullStream(result: any): AsyncIterable<TextStreamPart<any>> {
  let emittedText = false;
  for (const step of result.steps ?? []) {
    for (const call of step.toolCalls ?? []) {
      yield {
        type: "tool-call",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        input: call.input,
      } as TextStreamPart<any>;
    }
    for (const toolResult of step.toolResults ?? []) {
      yield {
        type: "tool-result",
        toolCallId: toolResult.toolCallId,
        toolName: toolResult.toolName,
        output: toolResult.output,
      } as TextStreamPart<any>;
    }
    if (step.text) {
      emittedText = true;
      yield { type: "text-delta", text: step.text } as TextStreamPart<any>;
    }
  }
  if (!emittedText && result.text) {
    yield { type: "text-delta", text: result.text } as TextStreamPart<any>;
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
