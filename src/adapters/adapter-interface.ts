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

/**
 * 适配器明确告知"这是一段完整的最终文本"（覆盖语义，而非追加）。
 *
 * 背景：Cursor CLI 在 `--stream-partial-output` 模式下，先发若干条 partial assistant
 * 消息（每条只是 delta 增量），流结束时再发一条 final assistant 消息（完整文本）。
 * 若把 final 也按 `text` 追加到 finalText，最终会出现"partial 累加 + final 完整"
 * 共两段重复内容。因此 cursor-adapter 把 final 这条标记为 text_final，
 * 由 session.ts 累积到独立字段 finalCompleteText（覆盖语义），最终发送时
 * 由 pickFinalReply 在两者之间挑选。
 *
 * 对没有 partial/final 双轨的适配器（如 Claude SDK），永远不会 emit 此类型。
 */
export interface UnifiedTextFinalBlock {
  type: "text_final";
  text: string;
}

export interface UnifiedToolUseBlock {
  type: "tool_use";
  /** 工具调用 ID，用于与 tool_result 对应（Claude SDK 会提供，Cursor 旧格式可能无） */
  id?: string;
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
  | UnifiedTextFinalBlock
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
  /**
   * 会话实际使用的模型展示名（如 Cursor 的 `Composer 2 Fast`）。
   * - Cursor adapter：从 cursor-agent system/init 事件学习并持久化到 store
   * - Claude adapter：留空（model 由 ChatCCC 配置 `CLAUDE_MODEL` 决定，不从 SDK 取）
   * 上层 /status、/sessions 渲染时按 tool 决定显示哪一来源。
   */
  model?: string;
}

export interface ToolProcessInfo {
  /** Root PID returned by child_process.spawn. With shell:true this is the shell wrapper PID. */
  pid: number;
}

export interface ToolPromptOptions {
  /** Called once a CLI-backed prompt process has been spawned. */
  onProcessStart?: (info: ToolProcessInfo) => void;
  /** Called when the adapter leaves the prompt process scope normally or by abort. */
  onProcessExit?: (info: ToolProcessInfo) => void;
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
    options?: ToolPromptOptions,
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