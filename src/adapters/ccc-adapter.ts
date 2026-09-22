import { ChatSession, type ChatSessionConfig, type ChatSessionOptions } from "../../deepccc-agent/src/index.ts";
import { config as deepCccConfig } from "../../deepccc-agent/src/config.ts";
import {
  getBuiltinContextSession,
  newBuiltinSessionId,
  normalizeBuiltinSessionId,
} from "../../deepccc-agent/src/context.ts";
import { config, CCC_SESSION_PREFIX } from "../config.ts";
import { createTurnCompletion } from "./turn-completion.ts";
import type {
  CreateSessionResult,
  SessionInfo,
  ToolAdapter,
  ToolPromptOptions,
  UnifiedStreamMessage,
} from "./adapter-interface.ts";

export interface CccAdapterOptions extends ChatSessionConfig {
  contextDir?: string;
  contextWindow?: number;
  compactAtTokens?: number;
  maxToolContextTokens?: number;
  keepRecentMessages?: number;
  compactionTimeoutMs?: number;
  maxSteps?: number;
  gitCoAuthor?: boolean;
  /**
   * 待注入消息判定（按 ChatCCC 会话 id）：为 true 时内核把在途 run_command 转入后台，
   * 让当前 step 尽快结束，好让下一个 step 边界注入用户新消息。未提供时行为不变。
   */
  hasPendingInjection?: (sessionId: string) => boolean;
}

function toChatSessionOptions(
  sessionId: string,
  cwd: string,
  options: CccAdapterOptions,
): ChatSessionOptions {
  return {
    cwd,
    persist: true,
    sessionId,
    contextDir: options.contextDir,
    contextWindow: options.contextWindow,
    compactAtTokens: options.compactAtTokens,
    maxToolContextTokens: options.maxToolContextTokens,
    keepRecentMessages: options.keepRecentMessages,
    compactionTimeoutMs: options.compactionTimeoutMs,
    maxSteps: options.maxSteps,
    // chatccc 无终端可交互，且对齐 claude/codex 适配器的 bypass 模式：
    // 高危命令不询问，全部放行（与独立 deepccc CLI 的 ask 模式不同）
    permissionMode: "bypass",
    ...(options.gitCoAuthor !== undefined ? { gitCoAuthor: options.gitCoAuthor } : {}),
    ...(options.hasPendingInjection
      ? { shouldYieldToInjection: () => options.hasPendingInjection!(sessionId) === true }
      : {}),
  };
}

export function createCccAdapter(options: CccAdapterOptions = {}): ToolAdapter {
  if (!options.apiKey?.trim()) {
    throw new Error("ChatCCC 未配置 CCC Agent API Key。请先填写 ccc.DEEPSEEK_API_KEY 后再启用 CCC Agent。");
  }

  const chatConfig: ChatSessionConfig = {
    apiKey: options.apiKey,
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.subModel !== undefined ? { subModel: options.subModel } : {}),
    ...(options.effort?.trim() ? { effort: options.effort.trim() } : {}),
    ...(options.maxOutputTokens !== undefined
      ? { maxOutputTokens: options.maxOutputTokens }
      : {}),
  };

  return {
    displayName: "CCC Agent",
    sessionDescPrefix: CCC_SESSION_PREFIX,
    // Non-streaming DeepCCC emits its reply only after the provider request finishes,
    // so unchanged output cannot distinguish a slow request from a stalled response.
    responseStallDetectionEnabled: deepCccConfig.streaming,

    async createSession(cwd: string): Promise<CreateSessionResult> {
      const sessionId = newBuiltinSessionId();
      const session = new ChatSession(
        chatConfig,
        toChatSessionOptions(sessionId, cwd, options),
      );
      session.reset();
      return { sessionId };
    },

    async *prompt(
      sessionId: string,
      userText: string,
      cwd: string,
      signal?: AbortSignal,
      _promptOptions?: ToolPromptOptions,
    ): AsyncIterable<UnifiedStreamMessage> {
      const normalizedSessionId = normalizeBuiltinSessionId(sessionId);
      const session = new ChatSession(
        chatConfig,
        toChatSessionOptions(normalizedSessionId, cwd, options),
      );

      const completion = createTurnCompletion("CCC Agent");
      for await (const event of session.chat(userText, signal, _promptOptions?.drainInput)) {
        if (event.type === "text") completion.observe({ type: "assistant", blocks: [{ type: "text", text: event.text }] });
        if (event.type === "text_reset") completion.observe({ type: "assistant", blocks: [{ type: "text_reset" }] });
        if (event.type === "status") {
          yield {
            type: "assistant",
            blocks: [{
              type: "agent_status",
              status: event.phase === "compacting" ? "compacting" : "responding",
            }],
          };
        } else if (event.type === "progress") {
          yield {
            type: "assistant",
            blocks: [{ type: "agent_progress", phase: event.phase }],
          };
        } else if (event.type === "text_reset") {
          yield {
            type: "assistant",
            blocks: [{ type: "text_reset" }],
          };
        } else if (event.type === "input_injected") {
          yield {
            type: "assistant",
            blocks: [{ type: "input_injected", text: event.text }],
          };
        } else if (event.type === "text") {
          yield {
            type: "assistant",
            blocks: [{ type: "text", text: event.text }],
          };
        } else if (event.type === "tool_use") {
          yield {
            type: "assistant",
            blocks: [{
              type: "tool_use",
              id: event.id,
              name: event.name,
              input: event.input,
            }],
          };
        } else if (event.type === "tool_result") {
          yield {
            type: "assistant",
            blocks: [{
              type: "tool_result",
              tool_use_id: event.tool_use_id,
              content: event.content,
              is_error: event.is_error,
            }],
          };
        } else if (event.type === "done" && !signal?.aborted) {
          completion.complete();
          yield {
            type: "assistant",
            blocks: [],
            isFinalResponse: true,
          };
        } else if (event.type === "error") {
          throw new Error(event.message);
        }
      }
      if (!signal?.aborted) completion.assertComplete();
    },

    async getSessionInfo(sessionId: string): Promise<SessionInfo | undefined> {
      const normalizedSessionId = normalizeBuiltinSessionId(sessionId);
      const info = getBuiltinContextSession(normalizedSessionId, options.contextDir);
      if (!info) return undefined;
      return {
        sessionId: info.sessionId,
        cwd: info.cwd,
        lastModified: info.updatedAt,
        model: options.model ?? config.ccc.model,
      };
    },

    async closeSession(_sessionId: string): Promise<void> {
      // ChatSession uses one request-scoped stream per prompt. AbortSignal handles cancellation.
    },
  };
}
