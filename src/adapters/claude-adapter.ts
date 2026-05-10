// =============================================================================
// claude-adapter.ts — Claude Agent SDK 适配器
// =============================================================================
// 实现 ToolAdapter 接口，将 @anthropic-ai/claude-agent-sdk 调用封装在内。
// =============================================================================

import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
  getSessionInfo as sdkGetSessionInfo,
} from "@anthropic-ai/claude-agent-sdk";

import type {
  ToolAdapter,
  UnifiedBlock,
  UnifiedStreamMessage,
  CreateSessionResult,
  SessionInfo,
} from "./adapter-interface.ts";

// ---------------------------------------------------------------------------
// 类型别名：SDK 内部消息的形状（避免导入 sdk.d.ts 的大型联合类型）
// ---------------------------------------------------------------------------

interface SdkContentBlock {
  type: string;
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

interface SdkMessageLike {
  type?: string;
  subtype?: string;
  message?: { content?: SdkContentBlock[] };
  compact_metadata?: {
    trigger?: "manual" | "auto";
    pre_tokens?: number;
    post_tokens?: number;
  };
  session_id?: string;
}

// ---------------------------------------------------------------------------
// ClaudeAdapterOptions
// ---------------------------------------------------------------------------

export interface ClaudeAdapterOptions {
  model: string;
  effort: string;
  isDefault: (value: string) => boolean;
}

// ---------------------------------------------------------------------------
// buildSessionOptions — 还原 claudeSdkSessionOptions 的精确行为
// ---------------------------------------------------------------------------

function buildSessionOptions(
  cwd: string,
  model: string,
  effort: string,
  isDefault: (value: string) => boolean,
): Record<string, unknown> {
  const o: Record<string, unknown> = {
    cwd,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    autoCompactEnabled: true,
  };
  if (!isDefault(model)) o.model = model;
  if (!isDefault(effort)) o.effort = effort;
  return o;
}

// ---------------------------------------------------------------------------
// normalizeSdkMessage — 关键映射：SDK 消息 → UnifiedStreamMessage | null
// ---------------------------------------------------------------------------

export function normalizeSdkMessage(msg: SdkMessageLike): UnifiedStreamMessage | null {
  // 1) assistant / user 消息：遍历 content 块
  if (
    (msg.type === "assistant" || msg.type === "user") &&
    msg.message?.content
  ) {
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
    return { type: msg.type, blocks };
  }

  // 2) system / compact_boundary 消息：上下文压缩事件
  if (msg.type === "system" && msg.subtype === "compact_boundary") {
    const meta = msg.compact_metadata;
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

  // 3) 其他消息类型：跳过
  return null;
}

// ---------------------------------------------------------------------------
// 适配器实现（私有类，仅通过工厂函数暴露）
// ---------------------------------------------------------------------------

class ClaudeAdapter implements ToolAdapter {
  readonly displayName = "Claude";
  readonly sessionDescPrefix = "Claude Session:";
  private model: string;
  private effort: string;
  private isDefault: (value: string) => boolean;

  constructor(options: ClaudeAdapterOptions) {
    this.model = options.model;
    this.effort = options.effort;
    this.isDefault = options.isDefault;
  }

  async createSession(cwd: string): Promise<CreateSessionResult> {
    const sessionOpts = buildSessionOptions(
      cwd,
      this.model,
      this.effort,
      this.isDefault,
    );
    const session = unstable_v2_createSession(sessionOpts as any);

    await session.send("ok");

    const stream = session.stream();
    const first = await stream.next();

    if (first.done || !(first.value as SdkMessageLike)?.session_id) {
      session.close();
      throw new Error("No session ID in Claude init event");
    }

    const sessionId = (first.value as SdkMessageLike).session_id!;

    // 后台消费剩余的 stream（必须：否则 SDK 内部缓冲可能阻塞）
    (async () => {
      try {
        for await (const _msg of stream) {
          // 静默消费
        }
      } catch {
        // stream 异常不阻塞主流程
      } finally {
        session.close();
      }
    })();

    return { sessionId };
  }

  async *prompt(
    sessionId: string,
    userText: string,
    cwd: string,
    signal?: AbortSignal,
  ): AsyncIterable<UnifiedStreamMessage> {
    const sessionOpts = buildSessionOptions(
      cwd,
      this.model,
      this.effort,
      this.isDefault,
    );
    const session = unstable_v2_resumeSession(
      sessionId,
      sessionOpts as any,
    );

    await session.send(userText);

    const stream = session.stream();

    try {
      for await (const msg of stream) {
        if (signal?.aborted) break;
        const normalized = normalizeSdkMessage(
          msg as unknown as SdkMessageLike,
        );
        if (normalized) yield normalized;
      }
    } finally {
      session.close();
    }
  }

  async getSessionInfo(
    sessionId: string,
  ): Promise<SessionInfo | undefined> {
    const info = await sdkGetSessionInfo(sessionId);
    if (!info) return undefined;
    return {
      sessionId: info.sessionId,
      cwd: info.cwd,
      summary: info.summary,
      lastModified: info.lastModified,
    };
  }

  async closeSession(_sessionId: string): Promise<void> {
    // Claude SDK 在 stream 结束后自动关闭 session，此处为 no-op
  }
}

// ---------------------------------------------------------------------------
// 工厂函数
// ---------------------------------------------------------------------------

export function createClaudeAdapter(
  options: ClaudeAdapterOptions,
): ToolAdapter {
  return new ClaudeAdapter(options);
}