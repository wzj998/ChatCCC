import { describe, it, expect } from "vitest";
import { normalizeCursorMessage, createCursorAdapter } from "../adapters/cursor-adapter.ts";
import type { UnifiedStreamMessage } from "../adapters/adapter-interface.ts";

// ---------------------------------------------------------------------------
// normalizeCursorMessage — 核心映射逻辑测试（纯函数）
// ---------------------------------------------------------------------------

describe("normalizeCursorMessage", () => {
  // --- assistant messages ---

  it("normalizes assistant message with text block", () => {
    const result = normalizeCursorMessage({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello world" }],
      },
    });
    expect(result).not.toBeNull();
    expect(result!.type).toBe("assistant");
    expect(result!.blocks).toEqual([{ type: "text", text: "Hello world" }]);
  });

  it("normalizes assistant message with thinking block", () => {
    const result = normalizeCursorMessage({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "Let me think..." }],
      },
    });
    expect(result).not.toBeNull();
    expect(result!.blocks).toEqual([{ type: "thinking", thinking: "Let me think..." }]);
  });

  it("normalizes assistant message with tool_use block", () => {
    const result = normalizeCursorMessage({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", name: "read_file", input: { filePath: "/tmp/test" } },
        ],
      },
    });
    expect(result).not.toBeNull();
    expect(result!.blocks).toEqual([
      { type: "tool_use", name: "read_file", input: { filePath: "/tmp/test" } },
    ]);
  });

  it("uses 'unknown' for tool_use without name", () => {
    const result = normalizeCursorMessage({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", input: {} }] },
    });
    expect(result!.blocks[0]).toMatchObject({ type: "tool_use", name: "unknown" });
  });

  it("normalizes assistant message with search_result block", () => {
    const result = normalizeCursorMessage({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "search_result", query: "cursor docs" }],
      },
    });
    expect(result!.blocks).toEqual([{ type: "search_result", query: "cursor docs" }]);
  });

  it("normalizes assistant message with redacted_thinking block", () => {
    const result = normalizeCursorMessage({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "redacted_thinking" }] },
    });
    expect(result!.blocks).toEqual([{ type: "redacted_thinking" }]);
  });

  // --- user messages (tool_result) ---

  it("normalizes user message with tool_result block (success)", () => {
    const result = normalizeCursorMessage({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_abc", content: "done", is_error: false },
        ],
      },
    });
    expect(result).not.toBeNull();
    expect(result!.type).toBe("user");
    expect(result!.blocks).toEqual([
      { type: "tool_result", tool_use_id: "call_abc", content: "done", is_error: false },
    ]);
  });

  it("normalizes user message with tool_result block (error)", () => {
    const result = normalizeCursorMessage({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_err", content: "fail", is_error: true },
        ],
      },
    });
    expect(result!.blocks).toEqual([
      { type: "tool_result", tool_use_id: "call_err", content: "fail", is_error: true },
    ]);
  });

  // --- mixed blocks ---

  it("normalizes message with multiple block types", () => {
    const result = normalizeCursorMessage({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Hmm..." },
          { type: "tool_use", name: "search", input: { query: "x" } },
          { type: "text", text: "Result found." },
        ],
      },
    });
    expect(result).not.toBeNull();
    expect(result!.blocks).toHaveLength(3);
  });

  // --- edge cases ---

  it("returns null for result messages (completion signal)", () => {
    expect(
      normalizeCursorMessage({
        type: "result",
        subtype: "success",
        result: "done",
      }),
    ).toBeNull();
  });

  it("returns null for system init messages", () => {
    expect(
      normalizeCursorMessage({
        type: "system",
        subtype: "init",
        session_id: "abc",
      }),
    ).toBeNull();
  });

  it("returns null for unknown message types", () => {
    expect(normalizeCursorMessage({ type: "unknown_type" })).toBeNull();
    expect(normalizeCursorMessage({})).toBeNull();
  });

  it("skips unknown block types in content", () => {
    const result = normalizeCursorMessage({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "custom_block", data: "ignored" },
          { type: "text", text: "visible" },
        ],
      },
    });
    expect(result!.blocks).toEqual([{ type: "text", text: "visible" }]);
  });

  it("returns message with empty blocks for empty content array", () => {
    const result = normalizeCursorMessage({
      type: "assistant",
      message: { role: "assistant", content: [] },
    });
    expect(result).not.toBeNull();
    expect(result!.blocks).toEqual([]);
  });

  it("returns null for message without content", () => {
    const result = normalizeCursorMessage({
      type: "assistant",
      message: { role: "assistant" },
    });
    expect(result).toBeNull();
  });

  it("skips thinking block with empty string", () => {
    const result = normalizeCursorMessage({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "" }] },
    });
    expect(result!.blocks).toEqual([]);
  });

  it("skips text block with empty string", () => {
    const result = normalizeCursorMessage({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "" }] },
    });
    expect(result!.blocks).toEqual([]);
  });

  it("returns null for system message without compact_boundary subtype", () => {
    expect(
      normalizeCursorMessage({ type: "system", subtype: "notification" }),
    ).toBeNull();
  });

  it("normalizes system compact_boundary message", () => {
    const msg: Record<string, unknown> = {
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 15000, post_tokens: 8000 },
    };
    const result = normalizeCursorMessage(
      msg as Parameters<typeof normalizeCursorMessage>[0],
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe("system");
    expect(result!.blocks).toEqual([
      { type: "compact_boundary", trigger: "auto", pre_tokens: 15000, post_tokens: 8000 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// createCursorAdapter — 工厂函数测试
// ---------------------------------------------------------------------------

describe("createCursorAdapter", () => {
  it("returns adapter with correct displayName and sessionDescPrefix", () => {
    const adapter = createCursorAdapter();
    expect(adapter.displayName).toBe("Cursor");
    expect(adapter.sessionDescPrefix).toBe("Cursor Session:");
  });

  it("closeSession does not throw", async () => {
    const adapter = createCursorAdapter();
    await expect(adapter.closeSession("any-id")).resolves.toBeUndefined();
  });

  it("getSessionInfo returns basic info", async () => {
    const adapter = createCursorAdapter();
    const info = await adapter.getSessionInfo("test-sid");
    expect(info).toEqual({ sessionId: "test-sid" });
  });
});