import { describe, it, expect } from "vitest";
import {
  normalizeSdkMessage,
  createClaudeAdapter,
  buildClaudePromptText,
  buildSdkEnv,
} from "../adapters/claude-adapter.ts";
import type { UnifiedStreamMessage } from "../adapters/adapter-interface.ts";
import type {
  ClaudeSessionMeta,
  ClaudeSessionMetaStore,
} from "../adapters/claude-session-meta-store.ts";

// ---------------------------------------------------------------------------
// 进程内内存版 meta store（测试用，避开磁盘 IO）
// ---------------------------------------------------------------------------

function createInMemoryMetaStore(
  initial: Record<string, ClaudeSessionMeta> = {},
): ClaudeSessionMetaStore & { snapshot(): Record<string, ClaudeSessionMeta> } {
  const map = new Map<string, ClaudeSessionMeta>(Object.entries(initial));
  return {
    async get(sid) {
      return map.get(sid);
    },
    async set(sid, partial) {
      const existing = map.get(sid);
      const merged: { cwd?: string; model?: string } = { ...existing };
      if (typeof partial.cwd === "string" && partial.cwd.length > 0) merged.cwd = partial.cwd;
      if (typeof partial.model === "string" && partial.model.length > 0) merged.model = partial.model;
      if (!merged.cwd) return;
      map.set(sid, merged.model ? { cwd: merged.cwd, model: merged.model } : { cwd: merged.cwd });
    },
    snapshot() {
      return Object.fromEntries(map);
    },
  };
}

// ---------------------------------------------------------------------------
// normalizeSdkMessage — 核心映射逻辑测试（纯函数，CLI 与 SDK 格式相同）
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

  it("skips text blocks in user messages", () => {
    // user text is host input, not assistant output. If the CLI emits it for
    // any reason, it should not appear in the final reply.
    const result = normalizeSdkMessage({
      type: "user",
      message: {
        content: [
          { type: "text", text: "[ChatCCC IM skill: feishu-skill]\n...[/ChatCCC IM skill: feishu-skill]" },
          { type: "tool_result", tool_use_id: "abc", content: "result" },
        ],
      },
    });
    expect(result).not.toBeNull();
    expect(result!.type).toBe("user");
    // text block 应被跳过，只保留 tool_result
    expect(result!.blocks).toHaveLength(1);
    expect(result!.blocks[0]).toMatchObject({ type: "tool_result", tool_use_id: "abc" });
  });

  it("returns null for user message with only text blocks (all skipped)", () => {
    // 纯 user text 消息（无 tool_result）→ 全部跳过，不产生有效 blocks
    const result = normalizeSdkMessage({
      type: "user",
      message: {
        content: [{ type: "text", text: "some replayed user input" }],
      },
    });
    // 此时 blocks 为空，但消息本身仍有 type，返回非 null 以保持流完整性
    // 调用方 accumulateBlockContent 对空 blocks 是 no-op
    expect(result).not.toBeNull();
    expect(result!.blocks).toEqual([]);
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
    expect(result!.blocks).toEqual([]);
  });

  it("skips text block with empty text string", () => {
    const result = normalizeSdkMessage({
      type: "assistant",
      message: { content: [{ type: "text", text: "" }] },
    });
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
// createClaudeAdapter — 工厂函数 + getSessionInfo / closeSession 测试
// ---------------------------------------------------------------------------

describe("createClaudeAdapter", () => {
  it("returns adapter with correct displayName and sessionDescPrefix", () => {
    const adapter = createClaudeAdapter({
      model: "claude-sonnet-4-6",
      effort: "high",
      isEmpty: (v) => v.trim() === "",
    });
    expect(adapter.displayName).toBe("Claude Code");
    expect(adapter.sessionDescPrefix).toBe("Claude Code Session:");
  });

  it("closeSession does not throw", async () => {
    const adapter = createClaudeAdapter({
      model: "claude-sonnet-4-6",
      effort: "high",
      isEmpty: () => false,
    });
    await expect(adapter.closeSession("any-sid")).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // getSessionInfo 行为契约
  //   - cwd 决定 /git 是否可用
  //   - model 用于 /state、/sessions 显示
  // -------------------------------------------------------------------------

  it("getSessionInfo: store 中无该 sessionId 时只返回 sessionId", async () => {
    const store = createInMemoryMetaStore();
    const adapter = createClaudeAdapter({
      model: "",
      effort: "",
      isEmpty: () => false,
      metaStore: store,
    });
    const info = await adapter.getSessionInfo("unknown-sid");
    expect(info).toEqual({ sessionId: "unknown-sid" });
    expect(info?.cwd).toBeUndefined();
    expect(info?.model).toBeUndefined();
  });

  it("getSessionInfo: store 仅有 cwd 时返回 cwd，model 仍为 undefined", async () => {
    const store = createInMemoryMetaStore({ "sid-known": { cwd: "F:/proj/Foo" } });
    const adapter = createClaudeAdapter({
      model: "",
      effort: "",
      isEmpty: () => false,
      metaStore: store,
    });
    const info = await adapter.getSessionInfo("sid-known");
    expect(info).toEqual({ sessionId: "sid-known", cwd: "F:/proj/Foo" });
    expect(info?.model).toBeUndefined();
  });

  it("getSessionInfo: store 同时有 cwd + model 时一并返回", async () => {
    const store = createInMemoryMetaStore({
      "sid-known": { cwd: "F:/proj/Foo", model: "claude-sonnet-4-6" },
    });
    const adapter = createClaudeAdapter({
      model: "",
      effort: "",
      isEmpty: () => false,
      metaStore: store,
    });
    const info = await adapter.getSessionInfo("sid-known");
    expect(info).toEqual({
      sessionId: "sid-known",
      cwd: "F:/proj/Foo",
      model: "claude-sonnet-4-6",
    });
  });

  it("getSessionInfo: 不同 sessionId 互不影响", async () => {
    const store = createInMemoryMetaStore({
      "sid-A": { cwd: "/a", model: "mA" },
      "sid-B": { cwd: "/b" },
    });
    const adapter = createClaudeAdapter({
      model: "",
      effort: "",
      isEmpty: () => false,
      metaStore: store,
    });
    expect(await adapter.getSessionInfo("sid-A")).toEqual({
      sessionId: "sid-A",
      cwd: "/a",
      model: "mA",
    });
    expect(await adapter.getSessionInfo("sid-B")).toEqual({
      sessionId: "sid-B",
      cwd: "/b",
    });
    expect(await adapter.getSessionInfo("sid-C")).toEqual({ sessionId: "sid-C" });
  });
});

describe("buildClaudePromptText", () => {
  it("prepends the Claude-specific injection prompt when present", () => {
    const result = buildClaudePromptText(
      "[User message]\nhello\n[/User message]",
      "Never repeat successful commands.",
    );

    expect(result).toContain("[ChatCCC Claude-specific injection prompt]");
    expect(result).toContain("Never repeat successful commands.");
    expect(result).toContain("[/ChatCCC Claude-specific injection prompt]");
    expect(result.endsWith("[User message]\nhello\n[/User message]")).toBe(true);
  });

  it("prepends the Claude-specific injection prompt on every resumed prompt", () => {
    const first = buildClaudePromptText(
      "[ChatCCC IM skill: feishu-skill]\ncapabilities\n[/ChatCCC IM skill: feishu-skill]\n\n[User message]\nfirst\n[/User message]",
      "Never repeat successful commands for {{session_id}}.",
      "sid-resume",
    );
    const second = buildClaudePromptText(
      "[ChatCCC IM skill: feishu-skill]\ncapabilities\n[/ChatCCC IM skill: feishu-skill]\n\n[User message]\nsecond\n[/User message]",
      "Never repeat successful commands for {{session_id}}.",
      "sid-resume",
    );

    for (const result of [first, second]) {
      expect(result).toContain("[ChatCCC Claude-specific injection prompt]");
      expect(result).toContain("Never repeat successful commands for sid-resume.");
      expect(result).toContain("[/ChatCCC Claude-specific injection prompt]");
      expect(result).toContain("[ChatCCC IM skill: feishu-skill]");
      expect(result).toContain("[/ChatCCC IM skill: feishu-skill]");
    }
    expect(first).toContain("[User message]\nfirst\n[/User message]");
    expect(second).toContain("[User message]\nsecond\n[/User message]");
  });

  it("leaves user text unchanged when the injection prompt is empty", () => {
    expect(buildClaudePromptText("hello", "   ")).toBe("hello");
    expect(buildClaudePromptText("hello", null)).toBe("hello");
  });

  it("replaces {{stop_stuck_url}} and {{session_id}} placeholders when sessionId is provided", () => {
    const result = buildClaudePromptText(
      "[User message]\nhello\n[/User message]",
      "Call POST {{stop_stuck_url}} with {\"session_id\": \"{{session_id}}\"}",
      "test-sid-123",
    );

    expect(result).toContain("http://127.0.0.1:");
    expect(result).toContain("/api/agent/stop-stuck-loop");
    expect(result).toContain("\"session_id\": \"test-sid-123\"");
    expect(result).not.toContain("{{stop_stuck_url}}");
    expect(result).not.toContain("{{session_id}}");
  });

  it("does not replace placeholders when sessionId is not provided", () => {
    const result = buildClaudePromptText(
      "hello",
      "Call POST {{stop_stuck_url}} with {\"session_id\": \"{{session_id}}\"}",
    );

    expect(result).toContain("{{stop_stuck_url}}");
    expect(result).toContain("{{session_id}}");
  });
});

describe("buildSdkEnv", () => {
  it("always sets CLAUDE_CODE_ATTRIBUTION_HEADER=0 to preserve prompt cache hit rate", () => {
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = process.platform === "win32"
        ? "C:\\Program Files\\Git\\usr\\bin;C:\\Windows\\System32"
        : "/usr/bin:/bin";
      const env = buildSdkEnv("", "  ", undefined);
      expect(env).toBeDefined();
      expect(env!.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe("0");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("prefers Git Bash before WindowsApps for Claude SDK subprocesses on Windows", () => {
    if (process.platform !== "win32") return;
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = [
        "C:\\Users\\weizhangjian\\AppData\\Local\\Microsoft\\WindowsApps",
        "C:\\Program Files\\Git\\usr\\bin",
        "%PATH%",
        "C:\\Windows\\System32",
      ].join(";");

      const env = buildSdkEnv("", "", "");

      expect(env).toBeDefined();
      const parts = env!.PATH!.split(";");
      expect(parts[0]).toBe("C:\\Program Files\\Git\\usr\\bin");
      expect(parts).not.toContain("%PATH%");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("sets requested SDK env overrides and removes conflicting Claude auth/model vars", () => {
    const original = {
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
      CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
      ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
      CLAUDE_CODE_EFFORT_LEVEL: process.env.CLAUDE_CODE_EFFORT_LEVEL,
      CLAUDE_CODE_SUBAGENT_MODEL: process.env.CLAUDE_CODE_SUBAGENT_MODEL,
    };

    process.env.ANTHROPIC_AUTH_TOKEN = "token";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth";
    process.env.ANTHROPIC_MODEL = "old-model";
    process.env.CLAUDE_CODE_EFFORT_LEVEL = "old-effort";
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = "old-subagent";

    try {
      const env = buildSdkEnv(
        " claude-haiku-4-5-20251001 ",
        " sk-test ",
        " https://api.example.com ",
      );

      expect(env).toBeDefined();
      expect(env!.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(env!.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(env!.ANTHROPIC_MODEL).toBeUndefined();
      expect(env!.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
      expect(env!.CLAUDE_CODE_SUBAGENT_MODEL).toBe("claude-haiku-4-5-20251001");
      expect(env!.ANTHROPIC_API_KEY).toBe("sk-test");
      expect(env!.ANTHROPIC_BASE_URL).toBe("https://api.example.com");
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});
