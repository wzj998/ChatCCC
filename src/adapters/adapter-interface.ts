// =============================================================================
// adapter-interface.ts — 统一的 AI 工具适配器接口和归一化消息类型
// =============================================================================
// 所有 AI 工具适配器（Claude SDK、Cursor CLI、Codex CLI 等）都必须实现
// ToolAdapter 接口。归一化消息类型 UnifiedBlock 屏蔽了各工具的差异，
// 使 session.ts 不需要关心底层是哪个 AI 工具。
// =============================================================================

// ---------------------------------------------------------------------------
// UnifiedBlock — 归一化后的消息块
// ---------------------------------------------------------------------------

export interface UnifiedThinkingBlock {
  type: "thinking";
  thinking: string;
}

export interface UnifiedTextBlock {
  type: "text";
  text: string;
}

export interface UnifiedToolUseBlock {
  type: "tool_use";
  name: string;
  input: unknown;
}

export interface UnifiedToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: unknown;
  is_error?: boolean;
}

export interface UnifiedRedactedThinkingBlock {
  type: "redacted_thinking";
}

export interface UnifiedSearchResultBlock {
  type: "search_result";
  query: string;
}

export interface UnifiedCompactBoundaryBlock {
  type: "compact_boundary";
  trigger: "manual" | "auto";
  pre_tokens: number;
  post_tokens?: number;
}

export type UnifiedBlock =
  | UnifiedThinkingBlock
  | UnifiedTextBlock
  | UnifiedToolUseBlock
  | UnifiedToolResultBlock
  | UnifiedRedactedThinkingBlock
  | UnifiedSearchResultBlock
  | UnifiedCompactBoundaryBlock;

// ---------------------------------------------------------------------------
// UnifiedStreamMessage — 一次 SDK/CLI 事件对应的归一化消息
// ---------------------------------------------------------------------------

export interface UnifiedStreamMessage {
  type: "assistant" | "user" | "system";
  blocks: UnifiedBlock[];
}

// ---------------------------------------------------------------------------
// CreateSessionResult
// ---------------------------------------------------------------------------

export interface CreateSessionResult {
  sessionId: string;
}

// ---------------------------------------------------------------------------
// SessionInfo — 会话元数据（/status、/cd 等命令使用）
// ---------------------------------------------------------------------------

export interface SessionInfo {
  sessionId: string;
  cwd?: string;
  summary?: string;
  lastModified?: number;
}

// ---------------------------------------------------------------------------
// ToolAdapter — 统一的 AI 工具适配器接口
// ---------------------------------------------------------------------------

export interface ToolAdapter {
  /** 日志/展示用名称，如 "Claude" */
  readonly displayName: string;

  /** 群描述中会话 ID 的前缀，如 "Claude Session:" */
  readonly sessionDescPrefix: string;

  /**
   * 创建新会话，返回会话 ID。
   * 适配器内部需处理后台流消费（静默消费 stream 中除 init 外的所有事件）。
   */
  createSession(cwd: string): Promise<CreateSessionResult>;

  /**
   * 向已有会话发送提示文本，返回归一化消息的异步迭代器。
   * 消费者遍历结束后（或提前中止时）适配器自动关闭底层会话。
   */
  prompt(
    sessionId: string,
    userText: string,
    cwd: string,
    signal?: AbortSignal,
  ): AsyncIterable<UnifiedStreamMessage>;

  /**
   * 查询会话元数据。会话不存在时返回 undefined。
   */
  getSessionInfo(sessionId: string): Promise<SessionInfo | undefined>;

  /**
   * 关闭/清理会话（/stop 或中断时调用）。
   * 对于流式结束后自动关闭的适配器（如 Claude SDK），此为 no-op。
   */
  closeSession(sessionId: string): Promise<void>;
}