import { ChatSession, type ChatSessionConfig, type ChatSessionOptions } from "../builtin/index.ts";
import {
  getBuiltinContextSession,
  newBuiltinSessionId,
  normalizeBuiltinSessionId,
} from "../builtin/context.ts";
import { config, CCC_SESSION_PREFIX } from "../config.ts";
import type {
  CreateSessionResult,
  SessionInfo,
  ToolAdapter,
  ToolPromptOptions,
  UnifiedStreamMessage,
} from "./adapter-interface.ts";

export interface CccAdapterOptions extends ChatSessionConfig {
  contextDir?: string;
  compactAtTokens?: number;
  keepRecentMessages?: number;
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
    compactAtTokens: options.compactAtTokens,
    keepRecentMessages: options.keepRecentMessages,
  };
}

export function createCccAdapter(options: CccAdapterOptions = {}): ToolAdapter {
  const chatConfig: ChatSessionConfig = {
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
  };

  return {
    displayName: "CCC Agent",
    sessionDescPrefix: CCC_SESSION_PREFIX,

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

      for await (const event of session.chat(userText, signal)) {
        if (event.type === "text") {
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
        } else if (event.type === "error") {
          throw new Error(event.message);
        }
      }
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
