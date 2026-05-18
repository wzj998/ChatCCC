/**
 * builtin/index.ts — ChatCCC 内置 Agent 核心 API
 *
 * ChatSession 是程序化入口，既可以被 CLI 调用，也可以被其他模块（如 ToolAdapter）调用。
 */

import { streamText } from "ai";

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

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

export interface ChatSessionConfig {
  /** DeepSeek API 兼容的服务地址，默认 https://api.deepseek.com/v1 */
  baseURL?: string;
  /** API Key（优先用 DEEPSEEK_API_KEY 环境变量） */
  apiKey?: string;
  /** 模型名称，默认 deepseek-chat */
  model?: string;
}

export interface ChatSessionOptions {
  /** 会话工作目录 */
  cwd?: string;
  /** 自定义系统提示词（会拼接到默认提示词之后） */
  systemPrompt?: string;
}

/**
 * 流式响应事件
 */
export type ChatEvent =
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
  private messages: ChatMessage[];

  constructor(
    config: ChatSessionConfig = {},
    options: ChatSessionOptions = {},
  ) {
    const apiKey = config.apiKey ?? process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      throw new Error(
        "DEEPSEEK_API_KEY 未设置。请设置环境变量 DEEPSEEK_API_KEY 或传入 apiKey",
      );
    }

    const baseURL = config.baseURL ?? "https://api.deepseek.com/v1";
    const modelId = config.model ?? "deepseek-chat";

    // 动态 import 以支持 ESM 包在 CJS 环境下的加载（tsx 处理）
    const { createOpenAICompatible } = require("@ai-sdk/openai-compatible");
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

    this.messages = [{ role: "system", content: systemContent.join("\n") }];
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
    this.messages.push({ role: "user", content: userMessage });

    let fullText = "";

    try {
      const result = streamText({
        model: this.model,
        messages: this.messages as any,
        abortSignal: signal,
      });

      for await (const chunk of result.textStream) {
        fullText += chunk;
        yield { type: "text", text: chunk, accumulated: fullText };
      }

      this.messages.push({ role: "assistant", content: fullText });
      yield { type: "done", text: fullText };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if ((err as Error).name === "AbortError" || signal?.aborted) {
        // 被中断时，不保存不完整的助手消息
        if (fullText) {
          this.messages.push({ role: "assistant", content: fullText + "\n[已中断]" });
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
    return this.messages;
  }

  /** 返回当前轮数（不含 system 消息） */
  get turnCount(): number {
    return this.messages.length - 1;
  }

  /** 清空会话历史，保留 system 消息 */
  reset(): void {
    const system = this.messages[0];
    this.messages = [system];
  }
}