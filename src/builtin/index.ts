/**
 * builtin/index.ts — ChatCCC 内置 Agent 核心 API
 *
 * ChatSession 是程序化入口，既可以被 CLI 调用，也可以被其他模块（如 ToolAdapter）调用。
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, streamText } from "ai";

import { config as appConfig } from "../config.ts";
import {
  BuiltinContextManager,
  buildSummaryPrompt,
  defaultBuiltinSessionId,
} from "./context.ts";

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

    // 构建系统提示词
    const systemContent = [SYSTEM_PROMPT];
    if (options?.systemPrompt) {
      systemContent.push("", options.systemPrompt);
    }
    if (options?.cwd) {
      systemContent.push("", `当前工作目录: ${options.cwd}`);
    }

    this.systemPrompt = systemContent.join("\n");
    this.context = new BuiltinContextManager({
      persist: options.persist ?? false,
      contextDir: options.contextDir,
      sessionId: options.sessionId ?? defaultBuiltinSessionId(options.cwd ?? process.cwd()),
      cwd: options.cwd ?? process.cwd(),
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

    try {
      const compactedMessages = await this.compactIfNeeded(signal);
      if (compactedMessages > 0) {
        yield { type: "compact", compactedMessages };
      }

      const result = streamText({
        model: this.model,
        system: this.systemPrompt,
        messages: this.context.buildModelMessages() as any,
        abortSignal: signal,
      });

      for await (const chunk of result.textStream) {
        fullText += chunk;
        yield { type: "text", text: chunk, accumulated: fullText };
      }

      this.context.appendMessage({ role: "assistant", content: fullText });
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
