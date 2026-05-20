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
  subagentModel?: string;
  effort: string;
  /** 判断字段是否为"不传给 SDK"的占位（项目约定：空字符串/全空白） */
  isEmpty: (value: string) => boolean;
  /**
   * Anthropic 兼容网关的 API key。
   * 非空（trim 后）时会被注入到 SDK 子进程的 ANTHROPIC_API_KEY 环境变量；
   * 留空 / 全空白 → 不覆盖，沿用主进程 process.env / 系统环境变量。
   * 永远不会写入主进程的 process.env，避免污染其他依赖 env 的代码。
   */
  apiKey?: string;
  /**
   * Anthropic 兼容网关的 base URL。
   * 非空（trim 后）时会被注入到 SDK 子进程的 ANTHROPIC_BASE_URL 环境变量；
   * 留空 / 全空白 → 不覆盖，沿用主进程 process.env / 系统环境变量。
   */
  baseUrl?: string;
}

// ---------------------------------------------------------------------------
// buildSdkEnv — 为 SDK 子进程构造 env
// ---------------------------------------------------------------------------
// 行为契约（详见单测 "createClaudeAdapter — env 注入"）：
//   - apiKey 与 baseUrl 都为空（trim 后）→ 返回 undefined，让 SDK 走默认行为
//     （即 process.env），避免无意义的拷贝。
//   - 任一非空 → 返回 process.env 的浅拷贝，并按需覆盖 ANTHROPIC_API_KEY /
//     ANTHROPIC_BASE_URL；其余 env 字段保持不变（PATH、HOME 等子进程必需）。
//   - 主进程 process.env 永不被写入，主进程其他模块对 env 的读取不受影响。
function buildSdkEnv(
  apiKey: string | undefined,
  baseUrl: string | undefined,
  subagentModel: string | undefined,
): Record<string, string | undefined> | undefined {
  const apiKeyTrim = (apiKey ?? "").trim();
  const baseUrlTrim = (baseUrl ?? "").trim();
  const subagentModelTrim = (subagentModel ?? "").trim();
  const hasApiOverride = Boolean(apiKeyTrim || baseUrlTrim);
  if (!hasApiOverride) return undefined;

  const env: Record<string, string | undefined> = { ...process.env };
  // ChatCCC's third-party Claude API config is authoritative when present.
  // Remove Claude Code/user settings env that can silently override gateway/auth/model choice.
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.ANTHROPIC_MODEL;
  delete env.ANTHROPIC_DEFAULT_OPUS_MODEL;
  delete env.ANTHROPIC_DEFAULT_SONNET_MODEL;
  delete env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
  delete env.CLAUDE_CODE_SUBAGENT_MODEL;
  delete env.CLAUDE_CODE_EFFORT_LEVEL;

  if (apiKeyTrim) env.ANTHROPIC_API_KEY = apiKeyTrim;
  if (baseUrlTrim) {
    env.ANTHROPIC_BASE_URL = baseUrlTrim;
  } else {
    delete env.ANTHROPIC_BASE_URL;
  }
  if (subagentModelTrim) env.CLAUDE_CODE_SUBAGENT_MODEL = subagentModelTrim;
  return env;
}

function resolveSettingSources(
  _apiKey: string | undefined,
  _baseUrl: string | undefined,
): Array<"user" | "project" | "local"> {
  // CLAUDE.md / CLAUDE.local.md 是 Agent 指令文件，与 API 来源无关，
  // 无论使用官方 Anthropic 还是第三方网关都应加载。
  // 包含 "user" 以使 ~/.claude/settings.json 中的配置（如 mcpServers）生效；
  // buildSdkEnv() 会删除可能冲突的 env 变量，确保网关配置不被覆盖。
  return ["user", "project", "local"];
}

// ---------------------------------------------------------------------------
// buildSessionOptions — 还原 claudeSdkSessionOptions 的精确行为
// ---------------------------------------------------------------------------

function buildSessionOptions(
  cwd: string,
  model: string,
  effort: string,
  isEmpty: (value: string) => boolean,
  apiKey: string | undefined,
  baseUrl: string | undefined,
  subagentModel: string | undefined,
): Record<string, unknown> {
  const o: Record<string, unknown> = {
    cwd,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    autoCompactEnabled: true,
    settingSources: resolveSettingSources(apiKey, baseUrl),
  };
  if (!isEmpty(model)) o.model = model;
  if (!isEmpty(effort)) o.effort = effort;
  const env = buildSdkEnv(apiKey, baseUrl, subagentModel);
  if (env) o.env = env;
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
          id: (block as { id?: string }).id,
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
  readonly displayName = "Claude Code";
  readonly sessionDescPrefix = "Claude Code Session:";
  private model: string;
  private effort: string;
  private subagentModel: string | undefined;
  private isEmpty: (value: string) => boolean;
  private apiKey: string | undefined;
  private baseUrl: string | undefined;

  constructor(options: ClaudeAdapterOptions) {
    this.model = options.model;
    this.effort = options.effort;
    this.subagentModel = options.subagentModel;
    this.isEmpty = options.isEmpty;
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl;
  }

  async createSession(cwd: string): Promise<CreateSessionResult> {
    const sessionOpts = buildSessionOptions(
      cwd,
      this.model,
      this.effort,
      this.isEmpty,
      this.apiKey,
      this.baseUrl,
      this.subagentModel,
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
      this.isEmpty,
      this.apiKey,
      this.baseUrl,
      this.subagentModel,
    );
    const session = unstable_v2_resumeSession(
      sessionId,
      sessionOpts as any,
    );

    if (signal?.aborted) {
      session.close();
      return;
    }
    const onAbort = () => { session.close(); };
    signal?.addEventListener("abort", onAbort, { once: true });

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
      signal?.removeEventListener("abort", onAbort);
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
