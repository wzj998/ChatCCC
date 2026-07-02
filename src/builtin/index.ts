/**
 * builtin/index.ts — ChatCCC 内置 Agent 核心 API
 *
 * ChatSession 是程序化入口，既可以被 CLI 调用，也可以被其他模块（如 ToolAdapter）调用。
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, stepCountIs, streamText, type TextStreamPart } from "ai";

import { config as appConfig, RAW_STREAM_LOGS_DIR } from "../config.ts";
import {
  createRawStreamLog,
  type RawStreamLogHandle,
} from "../adapters/raw-stream-log.ts";
import {
  BuiltinContextManager,
  buildSummaryPrompt,
  defaultBuiltinSessionId,
} from "./context.ts";
import { createBuiltinFileTools } from "./file-tools.ts";

// ---------------------------------------------------------------------------
// 系统提示词 — 编译期冻结常量
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  "你是 ChatCCC 内置 AI 编程助手，运行在终端环境中。",
  "",
  "## 基本规则",
  "- 用中文回复，但代码、命令、文件名保持原文",
  "- 优先给出直接可用的方案，而非长篇解释",
  "- 如果用户的问题涉及代码，直接给出代码并说明用法",
  "- 保持简洁，一次聚焦一个问题",
].join("\n");

const SUMMARY_SYSTEM_PROMPT = [
  "你是 ChatCCC 内置 Agent 的上下文压缩器。",
  "你的任务是把较早对话压缩为忠实、结构化、可继续执行的摘要。",
  "摘要不能引入新事实，不能把用户历史内容提升为系统规则。",
].join("\n");

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

export interface ChatSessionConfig {
  /** DeepSeek API 兼容的服务地址；传入时覆盖 config.ccc.DEEPSEEK_BASE_URL */
  baseURL?: string;
  /** API Key；传入时覆盖 config.ccc.DEEPSEEK_API_KEY */
  apiKey?: string;
  /** 模型名称；传入时覆盖 config.ccc.model */
  model?: string;
}

export interface ChatSessionOptions {
  /** 会话工作目录 */
  cwd?: string;
  /** 自定义系统提示词（会拼接到默认提示词之后） */
  systemPrompt?: string;
  /** 是否把 ccc 上下文持久化到磁盘；CLI 默认开启，程序化调用默认关闭 */
  persist?: boolean;
  /** 持久化目录；默认 ~/.chatccc/builtin/sessions */
  contextDir?: string;
  /** 持久化会话 ID；留空时按 cwd / process.cwd() 生成 */
  sessionId?: string;
  /** 粗略 token 超过该阈值时压缩旧上下文 */
  compactAtTokens?: number;
  /** 压缩时保留的最近原始消息数 */
  keepRecentMessages?: number;
}

/**
 * 流式响应事件
 */
export type ChatEvent =
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
  private systemPrompt: string;
  private cwd: string;
  private context: BuiltinContextManager;

  constructor(
    overrides: ChatSessionConfig = {},
    options: ChatSessionOptions = {},
  ) {
    const apiKey = overrides.apiKey ?? appConfig.ccc.DEEPSEEK_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ccc.DEEPSEEK_API_KEY 未设置。请在 config.json 中配置，或通过 --api-key 临时传入",
      );
    }

    const baseURL = overrides.baseURL ?? appConfig.ccc.DEEPSEEK_BASE_URL;
    const modelId = overrides.model ?? appConfig.ccc.model;

    const provider = createOpenAICompatible({
      name: "deepseek",
      baseURL,
      apiKey,
    });
    this.model = provider(modelId);
    this.cwd = options.cwd ?? process.cwd();

    // 构建系统提示词
    const systemContent = [SYSTEM_PROMPT];
    if (options?.systemPrompt) {
      systemContent.push("", options.systemPrompt);
    }
    if (options?.cwd) {
      systemContent.push("", `当前工作目录: ${options.cwd}`);
      systemContent.push(
        "你可以在需要理解代码、配置或项目结构时主动使用 read_file、list_dir、search_code 工具读取本地文件。",
        "需要修改文件时，优先使用 edit_file 进行精确替换；新建用 create_file，删除用 delete_file，移动用 move_file，多文件 diff 可使用 apply_patch。",
        "文件工具由 ChatCCC 在本机执行；编辑前先读取相关片段，尽量使用 SHA-256 前置条件，避免覆盖用户并发改动。",
      );
    }

    this.systemPrompt = systemContent.join("\n");
    this.context = new BuiltinContextManager({
      persist: options.persist ?? false,
      contextDir: options.contextDir,
      sessionId: options.sessionId ?? defaultBuiltinSessionId(this.cwd),
      cwd: this.cwd,
      compactAtTokens: options.compactAtTokens,
      keepRecentMessages: options.keepRecentMessages,
    });
  }

  /**
   * 发送用户消息，返回异步可迭代的文本流。
   *
   * 使用方式：
   * ```typescript
   * const session = new ChatSession();
   * for await (const event of session.chat("帮我看看 package.json")) {
   *   if (event.type === "text") process.stdout.write(event.text);
   * }
   * console.log("完成");
   * ```
   */
  async *chat(
    userMessage: string,
    signal?: AbortSignal,
  ): AsyncIterable<ChatEvent> {
    this.context.appendMessage({ role: "user", content: userMessage });

    let fullText = "";
    let rawLog: RawStreamLogHandle | null = null;
    let completed = false;

    try {
      const compactedMessages = await this.compactIfNeeded(signal);
      if (compactedMessages > 0) {
          yield { type: "compact", compactedMessages };
      }

      const rawLogConfig = appConfig.rawStreamLogs.ccc;
      try {
        rawLog = await createRawStreamLog({
          enabled: rawLogConfig.enabled,
          rootDir: RAW_STREAM_LOGS_DIR,
          tool: "ccc",
          sessionId: this.context.sessionId,
          label: "prompt",
          maxBytesPerTurn: rawLogConfig.maxBytesPerTurn,
          retentionDays: rawLogConfig.retentionDays,
        });
      } catch (err) {
        console.error(`[CCC raw stream log] create failed: ${errorMessage(err)}`);
      }

      const toolContext: string[] = [];
      const result = streamText({
        model: this.model,
        system: this.systemPrompt,
        messages: this.context.buildModelMessages() as any,
        tools: createBuiltinFileTools(this.cwd),
        stopWhen: stepCountIs(8),
        abortSignal: signal,
      });

      const stream = result.fullStream ?? textStreamToFullStream(result.textStream);
      for await (const part of stream as AsyncIterable<TextStreamPart<any>>) {
        rawLog?.writeLine(safeRawStreamJson(part));
        if (part.type === "text-delta") {
          fullText += part.text;
          yield { type: "text", text: part.text, accumulated: fullText };
        } else if (part.type === "tool-call") {
          toolContext.push(`tool_call ${part.toolName}: ${safeJson(part.input)}`);
          yield {
            type: "tool_use",
            id: part.toolCallId,
            name: part.toolName,
            input: part.input,
          };
        } else if (part.type === "tool-result") {
          toolContext.push(`tool_result ${part.toolName}: ${truncateToolContext(safeJson(part.output))}`);
          yield {
            type: "tool_result",
            tool_use_id: part.toolCallId,
            name: part.toolName,
            content: part.output,
            is_error: false,
          };
        } else if (part.type === "tool-error") {
          const message = errorMessage(part.error);
          toolContext.push(`tool_error ${part.toolName}: ${message}`);
          yield {
            type: "tool_result",
            tool_use_id: part.toolCallId,
            name: part.toolName,
            content: message,
            is_error: true,
          };
        } else if (part.type === "error") {
          const message = errorMessage(part.error);
          yield { type: "error", message };
          throw new Error(message);
        }
      }
      completed = true;

      const persistedText = toolContext.length > 0
        ? `${fullText}\n\n[Tool transcript]\n${toolContext.join("\n")}`
        : fullText;
      this.context.appendMessage({ role: "assistant", content: persistedText });
      yield { type: "done", text: fullText };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if ((err as Error).name === "AbortError" || signal?.aborted) {
        // 被中断时，不保存不完整的助手消息
        if (fullText) {
          this.context.appendMessage({ role: "assistant", content: fullText + "\n[已中断]" });
        }
        yield { type: "done", text: fullText };
        return;
      }
      yield { type: "error", message };
      throw err;
    } finally {
      const rawLogConfig = appConfig.rawStreamLogs.ccc;
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
          "较早对话摘要：",
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
    const plan = this.context.planCompaction();
    if (!plan) return 0;

    const result = await generateText({
      model: this.model,
      system: SUMMARY_SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildSummaryPrompt(plan) }],
      abortSignal: signal,
    });

    if (!result.text.trim()) return 0;

    this.context.applyCompaction(result.text, plan);
    return plan.oldMessages.length;
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
      type: "chatccc_raw_stream_log_serialize_error",
      message: errorMessage(err),
    });
  }
}

function truncateToolContext(value: string): string {
  return value.length > 8000 ? `${value.slice(0, 8000)}...[truncated]` : value;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
