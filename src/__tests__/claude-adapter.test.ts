import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { normalizeSdkMessage, createClaudeAdapter } from "../adapters/claude-adapter.ts";
import type { UnifiedStreamMessage } from "../adapters/adapter-interface.ts";

// ---------------------------------------------------------------------------
// Mock Claude SDK
// ---------------------------------------------------------------------------

const mockSend = vi.fn();
const mockClose = vi.fn();
const mockStreamNext = vi.fn();
const mockStreamIterable: AsyncGenerator<any, void> = {
  next: mockStreamNext,
  [Symbol.asyncIterator]() { return this; },
} as any;

function mockSession(overrides: Partial<{ send: any; close: any; streamNext: any }> = {}) {
  return {
    send: overrides.send ?? mockSend,
    close: overrides.close ?? mockClose,
    stream: () => ({
      next: overrides.streamNext ?? mockStreamNext,
      [Symbol.asyncIterator]() { return this; },
    }),
  };
}

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  // We only mock the full adapter integration tests; normalizeSdkMessage is pure
  return {
    unstable_v2_createSession: vi.fn(),
    unstable_v2_resumeSession: vi.fn(),
    getSessionInfo: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// normalizeSdkMessage — 核心映射逻辑测试（纯函数，不需要 mock SDK）
// ---------------------------------------------------------------------------

describe("normalizeSdkMessage", () => {
  // --- assistant messages ---

  it("normalizes assistant message with text block", () => {
    const result = normalizeSdkMessage({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello world" }] },
    });
    expect(result).not.toBeNull();
    expect(result!.type).toBe("assistant");
    expect(result!.blocks).toEqual([{ type: "text", text: "Hello world" }]);
  });

  it("normalizes assistant message with thinking block", () => {
    const result = normalizeSdkMessage({
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "Let me analyze..." }] },
    });
    expect(result).not.toBeNull();
    expect(result!.blocks).toEqual([{ type: "thinking", thinking: "Let me analyze..." }]);
  });

  it("normalizes assistant message with tool_use block", () => {
    const result = normalizeSdkMessage({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Read", input: { file_path: "/tmp/test.txt" } }],
      },
    });
    expect(result).not.toBeNull();
    expect(result!.blocks).toEqual([
      { type: "tool_use", name: "Read", input: { file_path: "/tmp/test.txt" } },
    ]);
  });

  it('uses "unknown" for tool_use without name', () => {
    const result = normalizeSdkMessage({
      type: "assistant",
      message: { content: [{ type: "tool_use", input: { x: 1 } }] },
    });
    expect(result!.blocks[0]).toMatchObject({ type: "tool_use", name: "unknown" });
  });

  it("normalizes user message with tool_result block (success)", () => {
    const result = normalizeSdkMessage({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "abc123", content: "file content here", is_error: false },
        ],
      },
    });
    expect(result).not.toBeNull();
    expect(result!.type).toBe("user");
    const block = result!.blocks[0] as any;
    expect(block.type).toBe("tool_result");
    expect(block.tool_use_id).toBe("abc123");
    expect(block.content).toBe("file content here");
    expect(block.is_error).toBe(false);
  });

  it("normalizes user message with tool_result block (error)", () => {
    const result = normalizeSdkMessage({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "err456", content: "permission denied", is_error: true },
        ],
      },
    });
    expect(result!.blocks[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "err456",
      is_error: true,
    });
  });

  it("normalizes tool_result with array content", () => {
    const content = [{ type: "text", text: "line 1" }, { type: "text", text: "line 2" }];
    const result = normalizeSdkMessage({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "arr", content }] },
    });
    expect(result!.blocks[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "arr",
    });
    expect((result!.blocks[0] as any).content).toEqual(content);
  });

  it("normalizes redacted_thinking block", () => {
    const result = normalizeSdkMessage({
      type: "assistant",
      message: { content: [{ type: "redacted_thinking" }] },
    });
    expect(result!.blocks).toEqual([{ type: "redacted_thinking" }]);
  });

  it("normalizes search_result block", () => {
    const result = normalizeSdkMessage({
      type: "assistant",
      message: {
        content: [{ type: "search_result", query: "TypeScript best practices" }],
      },
    });
    expect(result!.blocks).toEqual([
      { type: "search_result", query: "TypeScript best practices" },
    ]);
  });

  it("normalizes search_result without query (empty string)", () => {
    const result = normalizeSdkMessage({
      type: "assistant",
      message: { content: [{ type: "search_result" }] },
    });
    expect(result!.blocks).toEqual([{ type: "search_result", query: "" }]);
  });

  // --- system messages ---

  it("normalizes system compact_boundary message", () => {
    const result = normalizeSdkMessage({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: {
        trigger: "auto",
        pre_tokens: 15000,
        post_tokens: 8000,
      },
    });
    expect(result).not.toBeNull();
    expect(result!.type).toBe("system");
    expect(result!.blocks).toEqual([
      { type: "compact_boundary", trigger: "auto", pre_tokens: 15000, post_tokens: 8000 },
    ]);
  });

  it("normalizes compact_boundary with manual trigger", () => {
    const result = normalizeSdkMessage({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "manual", pre_tokens: 20000 },
    });
    expect(result!.blocks).toEqual([
      { type: "compact_boundary", trigger: "manual", pre_tokens: 20000, post_tokens: undefined },
    ]);
  });

  it("normalizes compact_boundary without post_tokens", () => {
    const result = normalizeSdkMessage({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 10000 },
    });
    expect(result!.blocks).toEqual([
      { type: "compact_boundary", trigger: "auto", pre_tokens: 10000, post_tokens: undefined },
    ]);
  });

  // --- mixed blocks ---

  it("normalizes message with multiple block types mixed", () => {
    const result = normalizeSdkMessage({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "Hmm..." },
          { type: "tool_use", name: "Grep", input: { pattern: "foo" } },
          { type: "text", text: "Found it." },
        ],
      },
    });
    expect(result).not.toBeNull();
    expect(result!.blocks).toHaveLength(3);
    expect(result!.blocks[0]).toEqual({ type: "thinking", thinking: "Hmm..." });
    expect(result!.blocks[1]).toEqual({ type: "tool_use", name: "Grep", input: { pattern: "foo" } });
    expect(result!.blocks[2]).toEqual({ type: "text", text: "Found it." });
  });

  // --- edge cases ---

  it("skips unknown block types", () => {
    const result = normalizeSdkMessage({
      type: "assistant",
      message: {
        content: [
          { type: "unknown_type", data: "whatever" },
          { type: "text", text: "still here" },
        ],
      },
    });
    expect(result!.blocks).toHaveLength(1);
    expect(result!.blocks[0]).toEqual({ type: "text", text: "still here" });
  });

  it("returns null for non-assistant/non-user/non-system messages", () => {
    expect(
      normalizeSdkMessage({ type: "result", subtype: "success" }),
    ).toBeNull();
    expect(
      normalizeSdkMessage({ type: "stream_event" }),
    ).toBeNull();
    expect(
      normalizeSdkMessage({ type: "status" }),
    ).toBeNull();
  });

  it("returns null for system message without compact_boundary subtype", () => {
    expect(
      normalizeSdkMessage({ type: "system", subtype: "init" }),
    ).toBeNull();
    expect(
      normalizeSdkMessage({ type: "system", subtype: "notification" }),
    ).toBeNull();
  });

  it("returns message with empty blocks for content=[ ]", () => {
    const result = normalizeSdkMessage({
      type: "assistant",
      message: { content: [] },
    });
    expect(result).not.toBeNull();
    expect(result!.blocks).toEqual([]);
  });

  it("returns null for message without content", () => {
    const result = normalizeSdkMessage({
      type: "assistant",
      message: {},
    });
    expect(result).toBeNull();
  });

  it("returns null for message with null content array", () => {
    const result = normalizeSdkMessage({
      type: "assistant",
      message: { content: undefined as any },
    });
    expect(result).toBeNull();
  });

  it("returns null for compact_boundary without metadata", () => {
    const result = normalizeSdkMessage({
      type: "system",
      subtype: "compact_boundary",
    });
    expect(result).toBeNull();
  });

  it("skips thinking block with empty thinking string", () => {
    const result = normalizeSdkMessage({
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "" }] },
    });
    // empty thinking string → falsy check (block.thinking → "") → skipped
    expect(result!.blocks).toEqual([]);
  });

  it("skips text block with empty text string", () => {
    const result = normalizeSdkMessage({
      type: "assistant",
      message: { content: [{ type: "text", text: "" }] },
    });
    // empty text string → falsy check → skipped
    expect(result!.blocks).toEqual([]);
  });

  it("handles message with undefined type gracefully", () => {
    const result = normalizeSdkMessage({
      message: { content: [{ type: "text", text: "orphan" }] },
    });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createClaudeAdapter — 集成测试（mock SDK）
// ---------------------------------------------------------------------------

describe("createClaudeAdapter", () => {
  let sdk: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    sdk = await import("@anthropic-ai/claude-agent-sdk");
  });

  it("returns adapter with correct displayName and sessionDescPrefix", () => {
    const adapter = createClaudeAdapter({
      model: "claude-sonnet-4-6",
      effort: "high",
      isEmpty: (v) => v.trim() === "",
    });
    expect(adapter.displayName).toBe("Claude Code");
    expect(adapter.sessionDescPrefix).toBe("Claude Code Session:");
  });

  it("createSession returns sessionId from init event", async () => {
    const mockSessionObj = mockSession({
      streamNext: vi
        .fn()
        .mockResolvedValueOnce({
          done: false,
          value: { session_id: "test-sid-001", type: "system", subtype: "init" },
        })
        .mockResolvedValueOnce({ done: true, value: undefined }),
    });
    sdk.unstable_v2_createSession.mockReturnValue(mockSessionObj);

    const adapter = createClaudeAdapter({
      model: "claude-sonnet-4-6",
      effort: "high",
      isEmpty: () => false,
    });

    const result = await adapter.createSession("/tmp");
    expect(result.sessionId).toBe("test-sid-001");
    expect(sdk.unstable_v2_createSession).toHaveBeenCalledTimes(1);
  });

  it("createSession throws when first event has no session_id", async () => {
    const mockSessionObj = mockSession({
      streamNext: vi
        .fn()
        .mockResolvedValueOnce({
          done: false,
          value: { type: "other", no_session_id: true },
        }),
    });
    sdk.unstable_v2_createSession.mockReturnValue(mockSessionObj);

    const adapter = createClaudeAdapter({
      model: "claude-sonnet-4-6",
      effort: "high",
      isEmpty: () => false,
    });

    await expect(adapter.createSession("/tmp")).rejects.toThrow(
      "No session ID",
    );
  });

  it("createSession sends 'ok' to the session", async () => {
    const sendSpy = vi.fn();
    const mockSessionObj = mockSession({
      send: sendSpy,
      streamNext: vi
        .fn()
        .mockResolvedValueOnce({
          done: false,
          value: { session_id: "sid", type: "system", subtype: "init" },
        })
        .mockResolvedValueOnce({ done: true, value: undefined }),
    });
    sdk.unstable_v2_createSession.mockReturnValue(mockSessionObj);

    const adapter = createClaudeAdapter({
      model: "claude-sonnet-4-6",
      effort: "high",
      isEmpty: () => false,
    });

    await adapter.createSession("/tmp");
    expect(sendSpy).toHaveBeenCalledWith("ok");
  });

  it("prompt yields normalized messages", async () => {
    const mockSessionObj = mockSession({
      streamNext: (() => {
        let callCount = 0;
        return vi.fn(async () => {
          callCount++;
          if (callCount === 1) {
            return {
              done: false,
              value: {
                type: "assistant",
                message: { content: [{ type: "text", text: "Hello!" }] },
              },
            };
          }
          return { done: true, value: undefined };
        });
      })(),
    });
    sdk.unstable_v2_resumeSession.mockReturnValue(mockSessionObj);

    const adapter = createClaudeAdapter({
      model: "claude-sonnet-4-6",
      effort: "high",
      isEmpty: () => false,
    });

    const messages: UnifiedStreamMessage[] = [];
    for await (const msg of adapter.prompt("sid", "hi", "/tmp")) {
      messages.push(msg);
    }

    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe("assistant");
    expect(messages[0].blocks).toEqual([{ type: "text", text: "Hello!" }]);
    expect(sdk.unstable_v2_resumeSession).toHaveBeenCalledTimes(1);
  });

  it("prompt handles AbortSignal", async () => {
    const mockSessionObj = mockSession({
      streamNext: vi
        .fn()
        .mockResolvedValueOnce({
          done: false,
          value: {
            type: "assistant",
            message: { content: [{ type: "text", text: "msg1" }] },
          },
        })
        .mockResolvedValueOnce({
          done: false,
          value: {
            type: "assistant",
            message: { content: [{ type: "text", text: "msg2" }] },
          },
        })
        .mockResolvedValue({ done: true, value: undefined }),
    });
    sdk.unstable_v2_resumeSession.mockReturnValue(mockSessionObj);

    const controller = new AbortController();
    const adapter = createClaudeAdapter({
      model: "claude-sonnet-4-6",
      effort: "high",
      isEmpty: () => false,
    });

    const messages: UnifiedStreamMessage[] = [];
    for await (const msg of adapter.prompt("sid", "hi", "/tmp", controller.signal)) {
      messages.push(msg);
      if (messages.length === 1) controller.abort();
    }

    // Should only get the first message before abort stops iteration
    expect(messages).toHaveLength(1);
  });

  it("getSessionInfo returns mapped SessionInfo", async () => {
    sdk.getSessionInfo.mockResolvedValue({
      sessionId: "sid",
      cwd: "/home/user",
      summary: "A test session",
      lastModified: 1234567890,
    });

    const adapter = createClaudeAdapter({
      model: "claude-sonnet-4-6",
      effort: "high",
      isEmpty: () => false,
    });

    const info = await adapter.getSessionInfo("sid");
    expect(info).toEqual({
      sessionId: "sid",
      cwd: "/home/user",
      summary: "A test session",
      lastModified: 1234567890,
    });
  });

  it("getSessionInfo returns undefined when SDK returns undefined", async () => {
    sdk.getSessionInfo.mockResolvedValue(undefined);

    const adapter = createClaudeAdapter({
      model: "claude-sonnet-4-6",
      effort: "high",
      isEmpty: () => false,
    });

    const info = await adapter.getSessionInfo("nonexistent");
    expect(info).toBeUndefined();
  });

  it("closeSession is no-op (does not throw)", async () => {
    const adapter = createClaudeAdapter({
      model: "claude-sonnet-4-6",
      effort: "high",
      isEmpty: () => false,
    });

    await expect(adapter.closeSession("any-sid")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createClaudeAdapter — sessionOpts 形状护栏
// 这一组测试只断言 "调用 SDK 时传了什么"。任何对 buildSessionOptions / env
// 注入逻辑的改动都应该让这组测试继续通过；如有意修改默认行为，请同步更新断言。
// ---------------------------------------------------------------------------

describe("createClaudeAdapter — sessionOpts 形状", () => {
  let sdk: any;

  /** 构造一个完成首次 init 即结束的 mock session，用于让 createSession 走完流程。 */
  function setupMockCreateSession(): void {
    const mockSessionObj = mockSession({
      streamNext: vi
        .fn()
        .mockResolvedValueOnce({
          done: false,
          value: { session_id: "sid", type: "system", subtype: "init" },
        })
        .mockResolvedValueOnce({ done: true, value: undefined }),
    });
    sdk.unstable_v2_createSession.mockReturnValue(mockSessionObj);
  }

  function setupMockResumeSession(): void {
    const mockSessionObj = mockSession({
      streamNext: vi
        .fn()
        .mockResolvedValueOnce({ done: true, value: undefined }),
    });
    sdk.unstable_v2_resumeSession.mockReturnValue(mockSessionObj);
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    sdk = await import("@anthropic-ai/claude-agent-sdk");
  });

  it("createSession 把 cwd / 固定权限选项传给 SDK", async () => {
    setupMockCreateSession();
    const adapter = createClaudeAdapter({
      model: "claude-sonnet-4-6",
      effort: "high",
      isEmpty: () => false,
    });

    await adapter.createSession("/work/dir");

    const opts = sdk.unstable_v2_createSession.mock.calls[0][0];
    expect(opts).toMatchObject({
      cwd: "/work/dir",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      autoCompactEnabled: true,
      settingSources: ["project", "local"],
    });
  });

  it("model / effort 非空时被传给 SDK", async () => {
    setupMockCreateSession();
    const adapter = createClaudeAdapter({
      model: "claude-sonnet-4-6",
      effort: "max",
      isEmpty: (v) => v.trim() === "",
    });

    await adapter.createSession("/cwd");

    const opts = sdk.unstable_v2_createSession.mock.calls[0][0];
    expect(opts.model).toBe("claude-sonnet-4-6");
    expect(opts.effort).toBe("max");
  });

  it("isEmpty(model) 为 true 时不传 model 字段", async () => {
    setupMockCreateSession();
    const adapter = createClaudeAdapter({
      model: "",
      effort: "high",
      isEmpty: (v) => v.trim() === "",
    });

    await adapter.createSession("/cwd");

    const opts = sdk.unstable_v2_createSession.mock.calls[0][0];
    expect(opts).not.toHaveProperty("model");
    expect(opts.effort).toBe("high");
  });

  it("isEmpty(effort) 为 true 时不传 effort 字段", async () => {
    setupMockCreateSession();
    const adapter = createClaudeAdapter({
      model: "claude-sonnet-4-6",
      effort: "",
      isEmpty: (v) => v.trim() === "",
    });

    await adapter.createSession("/cwd");

    const opts = sdk.unstable_v2_createSession.mock.calls[0][0];
    expect(opts.model).toBe("claude-sonnet-4-6");
    expect(opts).not.toHaveProperty("effort");
  });

  it("prompt() 也按相同规则构造 sessionOpts（resume 路径）", async () => {
    setupMockResumeSession();
    const adapter = createClaudeAdapter({
      model: "claude-sonnet-4-6",
      effort: "max",
      isEmpty: (v) => v.trim() === "",
    });

    const it_ = adapter.prompt("sid", "hi", "/resume/cwd");
    for await (const _ of it_) { /* drain */ }

    const opts = sdk.unstable_v2_resumeSession.mock.calls[0][1];
    expect(opts).toMatchObject({
      cwd: "/resume/cwd",
      permissionMode: "bypassPermissions",
      autoCompactEnabled: true,
      model: "claude-sonnet-4-6",
      effort: "max",
    });
  });
});

// ---------------------------------------------------------------------------
// createClaudeAdapter — env 注入（apiKey / baseUrl 通过 SDK env 传递）
// 行为契约：
//   - apiKey 或 baseUrl 任一非空（trim 后）→ 传 env，且 env 是 process.env
//     的副本，并按需覆盖 ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL；
//     其余 process.env 字段保持不变。
//   - 两者都为空 → 完全不传 env 字段，让 SDK 走默认行为（即 process.env）。
//   - 主进程的 process.env 永不被修改（避免污染其他依赖于 env 的代码）。
// ---------------------------------------------------------------------------

describe("createClaudeAdapter — env 注入", () => {
  let sdk: any;
  const ORIGINAL_ENV = { ...process.env };

  function setupMockCreateSession(): void {
    const mockSessionObj = mockSession({
      streamNext: vi
        .fn()
        .mockResolvedValueOnce({
          done: false,
          value: { session_id: "sid", type: "system", subtype: "init" },
        })
        .mockResolvedValueOnce({ done: true, value: undefined }),
    });
    sdk.unstable_v2_createSession.mockReturnValue(mockSessionObj);
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    sdk = await import("@anthropic-ai/claude-agent-sdk");
    // 确保每个用例从干净的 process.env 起步
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_MODEL;
    delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
    delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
    delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL;
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
  });

  // 用例之间清掉我们写入的 env，避免互相污染
  // （afterEach 等价物：vitest 在 beforeEach 里 reset 即可）
  afterAll(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("apiKey / baseUrl 都为空时，不向 SDK 传 env 字段", async () => {
    setupMockCreateSession();
    const adapter = createClaudeAdapter({
      model: "claude-sonnet-4-6",
      effort: "high",
      isEmpty: (v) => v.trim() === "",
      apiKey: "",
      baseUrl: "",
    });

    await adapter.createSession("/cwd");

    const opts = sdk.unstable_v2_createSession.mock.calls[0][0];
    expect(opts).not.toHaveProperty("env");
  });

  it("apiKey / baseUrl 全空白同样视为空", async () => {
    setupMockCreateSession();
    const adapter = createClaudeAdapter({
      model: "claude-sonnet-4-6",
      effort: "high",
      isEmpty: (v) => v.trim() === "",
      apiKey: "   ",
      baseUrl: "\t\n",
    });

    await adapter.createSession("/cwd");

    const opts = sdk.unstable_v2_createSession.mock.calls[0][0];
    expect(opts).not.toHaveProperty("env");
  });

  it("apiKey 非空 → 传 env 且覆盖 ANTHROPIC_API_KEY", async () => {
    setupMockCreateSession();
    process.env.SOME_OTHER = "keep-me";
    const adapter = createClaudeAdapter({
      model: "",
      effort: "",
      isEmpty: (v) => v.trim() === "",
      apiKey: "sk-test-key",
      baseUrl: "",
    });

    await adapter.createSession("/cwd");

    const opts = sdk.unstable_v2_createSession.mock.calls[0][0];
    expect(opts.env).toBeDefined();
    expect(opts.env.ANTHROPIC_API_KEY).toBe("sk-test-key");
    expect(opts.env.SOME_OTHER).toBe("keep-me");

    delete process.env.SOME_OTHER;
  });

  it("baseUrl 非空 → 传 env 且覆盖 ANTHROPIC_BASE_URL", async () => {
    setupMockCreateSession();
    const adapter = createClaudeAdapter({
      model: "",
      effort: "",
      isEmpty: (v) => v.trim() === "",
      apiKey: "",
      baseUrl: "https://api.deepseek.com/anthropic",
    });

    await adapter.createSession("/cwd");

    const opts = sdk.unstable_v2_createSession.mock.calls[0][0];
    expect(opts.env).toBeDefined();
    expect(opts.env.ANTHROPIC_BASE_URL).toBe("https://api.deepseek.com/anthropic");
  });

  it("apiKey + baseUrl 都设置 → 同时覆盖", async () => {
    setupMockCreateSession();
    const adapter = createClaudeAdapter({
      model: "",
      effort: "",
      isEmpty: (v) => v.trim() === "",
      apiKey: "sk-x",
      baseUrl: "https://gateway.example/anthropic",
    });

    await adapter.createSession("/cwd");

    const opts = sdk.unstable_v2_createSession.mock.calls[0][0];
    expect(opts.env.ANTHROPIC_API_KEY).toBe("sk-x");
    expect(opts.env.ANTHROPIC_BASE_URL).toBe("https://gateway.example/anthropic");
  });

  it("官方 API 模式下 subagentModel 不注入 env，也不覆盖 Claude 登录环境", async () => {
    setupMockCreateSession();
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-from-login";
    const adapter = createClaudeAdapter({
      model: "claude-sonnet-4-6",
      subagentModel: "claude-haiku-4-5-20251001",
      effort: "",
      isEmpty: (v) => v.trim() === "",
      apiKey: "",
      baseUrl: "",
    });

    await adapter.createSession("/cwd");

    const opts = sdk.unstable_v2_createSession.mock.calls[0][0];
    expect(opts).not.toHaveProperty("env");
  });

  it("第三方 API 模式下 subagentModel 通过 CLAUDE_CODE_SUBAGENT_MODEL 覆盖 Haiku", async () => {
    setupMockCreateSession();
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-from-login";
    const adapter = createClaudeAdapter({
      model: "claude-sonnet-4-6",
      subagentModel: "claude-haiku-4-5-20251001",
      effort: "",
      isEmpty: (v) => v.trim() === "",
      apiKey: "sk-thirdparty",
      baseUrl: "https://gateway.example/anthropic",
    });

    await adapter.createSession("/cwd");

    const opts = sdk.unstable_v2_createSession.mock.calls[0][0];
    expect(opts.model).toBe("claude-sonnet-4-6");
    expect(opts.env.ANTHROPIC_API_KEY).toBe("sk-thirdparty");
    expect(opts.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("claude-haiku-4-5-20251001");
    expect(opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("ChatCCC API config is isolated from Claude settings auth/model env", async () => {
    setupMockCreateSession();
    process.env.ANTHROPIC_AUTH_TOKEN = "token-from-claude-settings";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-from-claude-settings";
    process.env.ANTHROPIC_MODEL = "model-from-claude-settings";
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = "sonnet-from-claude-settings";
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = "subagent-from-claude-settings";
    process.env.CLAUDE_CODE_EFFORT_LEVEL = "max";
    const adapter = createClaudeAdapter({
      model: "chatccc-model",
      effort: "high",
      isEmpty: (v) => v.trim() === "",
      apiKey: "sk-chatccc",
      baseUrl: "https://chatccc-gateway.example/anthropic",
    });

    await adapter.createSession("/cwd");

    const opts = sdk.unstable_v2_createSession.mock.calls[0][0];
    expect(opts.env.ANTHROPIC_API_KEY).toBe("sk-chatccc");
    expect(opts.env.ANTHROPIC_BASE_URL).toBe("https://chatccc-gateway.example/anthropic");
    expect(opts.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(opts.env.ANTHROPIC_MODEL).toBeUndefined();
    expect(opts.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
    expect(opts.env.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
    expect(opts.env.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
  });

  it("第三方 API 配置时仍然加载 CLAUDE.md（settingSources 始终为 project+local）", async () => {
    setupMockCreateSession();
    const adapter = createClaudeAdapter({
      model: "",
      effort: "",
      isEmpty: (v) => v.trim() === "",
      apiKey: "sk-chatccc",
      baseUrl: "https://chatccc-gateway.example/anthropic",
    });

    await adapter.createSession("/cwd");

    const opts = sdk.unstable_v2_createSession.mock.calls[0][0];
    expect(opts.settingSources).toEqual(["project", "local"]);
  });

  it("不修改主进程 process.env（永不污染）", async () => {
    setupMockCreateSession();
    const before = { ...process.env };

    const adapter = createClaudeAdapter({
      model: "",
      effort: "",
      isEmpty: (v) => v.trim() === "",
      apiKey: "sk-should-not-leak",
      baseUrl: "https://should-not-leak/anthropic",
    });

    await adapter.createSession("/cwd");

    // 调用结束后 process.env 与调用前应保持一致
    expect(process.env.ANTHROPIC_API_KEY).toBe(before.ANTHROPIC_API_KEY);
    expect(process.env.ANTHROPIC_BASE_URL).toBe(before.ANTHROPIC_BASE_URL);
  });

  it("apiKey 留空但 process.env 已有 ANTHROPIC_API_KEY → 不覆盖、不抹掉", async () => {
    setupMockCreateSession();
    process.env.ANTHROPIC_API_KEY = "from-system-env";
    const adapter = createClaudeAdapter({
      model: "",
      effort: "",
      isEmpty: (v) => v.trim() === "",
      apiKey: "",
      baseUrl: "https://override.example/anthropic",
    });

    await adapter.createSession("/cwd");

    const opts = sdk.unstable_v2_createSession.mock.calls[0][0];
    // baseUrl 触发了 env 注入；apiKey 为空 → 沿用系统 env
    expect(opts.env.ANTHROPIC_API_KEY).toBe("from-system-env");
    expect(opts.env.ANTHROPIC_BASE_URL).toBe("https://override.example/anthropic");
  });
});
