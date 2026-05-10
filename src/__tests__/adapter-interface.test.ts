import { describe, it, expect } from "vitest";
import type {
  UnifiedBlock,
  UnifiedStreamMessage,
  UnifiedThinkingBlock,
  UnifiedTextBlock,
  UnifiedToolUseBlock,
  UnifiedToolResultBlock,
  UnifiedRedactedThinkingBlock,
  UnifiedSearchResultBlock,
  UnifiedCompactBoundaryBlock,
  CreateSessionResult,
  SessionInfo,
  ToolAdapter,
} from "../adapters/adapter-interface.ts";

// ---------------------------------------------------------------------------
// 编译期类型验证：确保 UnifiedBlock 联合类型覆盖了所有预期的 block 形状
// ---------------------------------------------------------------------------

describe("UnifiedBlock union type coverage", () => {
  it("accepts thinking block", () => {
    const b: UnifiedBlock = { type: "thinking", thinking: "Let me think..." };
    expect(b.type).toBe("thinking");
  });

  it("accepts text block", () => {
    const b: UnifiedBlock = { type: "text", text: "Hello" };
    expect(b.type).toBe("text");
  });

  it("accepts tool_use block", () => {
    const b: UnifiedBlock = { type: "tool_use", name: "Read", input: { file_path: "/tmp" } };
    expect(b.type).toBe("tool_use");
  });

  it("accepts tool_result block with string content", () => {
    const b: UnifiedBlock = { type: "tool_result", tool_use_id: "abc123", content: "result" };
    expect(b.type).toBe("tool_result");
  });

  it("accepts tool_result block with error flag", () => {
    const b: UnifiedBlock = { type: "tool_result", tool_use_id: "abc123", content: "error", is_error: true };
    expect(b.is_error).toBe(true);
  });

  it("accepts redacted_thinking block", () => {
    const b: UnifiedBlock = { type: "redacted_thinking" };
    expect(b.type).toBe("redacted_thinking");
  });

  it("accepts search_result block", () => {
    const b: UnifiedBlock = { type: "search_result", query: "what is TypeScript" };
    expect(b.type).toBe("search_result");
  });

  it("accepts compact_boundary block", () => {
    const b: UnifiedBlock = { type: "compact_boundary", trigger: "auto", pre_tokens: 10000, post_tokens: 5000 };
    expect(b.type).toBe("compact_boundary");
  });

  it("accepts compact_boundary block without post_tokens", () => {
    const b: UnifiedBlock = { type: "compact_boundary", trigger: "manual", pre_tokens: 20000 };
    expect(b.type).toBe("compact_boundary");
  });
});

// ---------------------------------------------------------------------------
// UnifiedStreamMessage
// ---------------------------------------------------------------------------

describe("UnifiedStreamMessage", () => {
  it("accepts assistant message with blocks", () => {
    const m: UnifiedStreamMessage = {
      type: "assistant",
      blocks: [
        { type: "thinking", thinking: "..." },
        { type: "text", text: "answer" },
      ],
    };
    expect(m.type).toBe("assistant");
    expect(m.blocks).toHaveLength(2);
  });

  it("accepts user message with tool_result blocks", () => {
    const m: UnifiedStreamMessage = {
      type: "user",
      blocks: [{ type: "tool_result", tool_use_id: "abc", content: "ok" }],
    };
    expect(m.type).toBe("user");
  });

  it("accepts system message", () => {
    const m: UnifiedStreamMessage = {
      type: "system",
      blocks: [{ type: "compact_boundary", trigger: "auto", pre_tokens: 100 }],
    };
    expect(m.type).toBe("system");
  });
});

// ---------------------------------------------------------------------------
// CreateSessionResult
// ---------------------------------------------------------------------------

describe("CreateSessionResult", () => {
  it("accepts valid result", () => {
    const r: CreateSessionResult = { sessionId: "uuid-12345" };
    expect(r.sessionId).toBe("uuid-12345");
  });
});

// ---------------------------------------------------------------------------
// SessionInfo
// ---------------------------------------------------------------------------

describe("SessionInfo", () => {
  it("accepts full info", () => {
    const info: SessionInfo = {
      sessionId: "abc",
      cwd: "/home/user",
      summary: "A session",
      lastModified: 1234567890,
    };
    expect(info.sessionId).toBe("abc");
  });

  it("accepts minimal info (only sessionId)", () => {
    const info: SessionInfo = { sessionId: "minimal" };
    expect(info.cwd).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ToolAdapter interface 结构断言
// ---------------------------------------------------------------------------

describe("ToolAdapter interface structure", () => {
  it("has correct property names via mock object", () => {
    // 如果 ToolAdapter 接口的字段名或函数签名变更，该对象字面量将无法编译
    const mock: ToolAdapter = {
      displayName: "Test",
      sessionDescPrefix: "Test Session:",
      createSession: async () => ({ sessionId: "s" }),
      prompt: async function* () {},
      getSessionInfo: async () => undefined,
      closeSession: async () => {},
    };
    expect(mock.displayName).toBe("Test");
    expect(mock.sessionDescPrefix).toBe("Test Session:");
  });
});