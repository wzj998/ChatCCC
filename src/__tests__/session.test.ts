import { describe, it, expect, beforeEach } from "vitest";
import {
  chatSessionMap,
  sessionInfoMap,
  processedMessages,
  MAX_PROCESSED,
  resetState,
  getSessionStatus,
  getAllSessionsStatus,
  accumulateBlockContent,
} from "../session.ts";
import type { AccumulatorState } from "../session.ts";
import type { UnifiedBlock } from "../adapters/adapter-interface.ts";

// Helper to create a mock active session entry
function mockActiveSession(chatId: string, overrides: Partial<{
  accumulatedContent: string;
  finalText: string;
  stopped: boolean;
}> = {}) {
  chatSessionMap.set(chatId, {
    gen: 1,
    close: () => {},
    cardId: null,
    stopped: overrides.stopped ?? false,
    accumulatedContent: overrides.accumulatedContent ?? "thinking...",
    finalText: overrides.finalText ?? "",
    spinnerTimer: null,
    msgTimestamp: Date.now(),
    sequence: 0,
    cardBusy: false,
  });
}

function mockSessionInfo(chatId: string, overrides: Partial<{
  sessionId: string;
  turnCount: number;
  lastContextTokens: number;
  startTime: number;
}> = {}) {
  sessionInfoMap.set(chatId, {
    sessionId: overrides.sessionId ?? "test-session-id",
    turnCount: overrides.turnCount ?? 3,
    lastContextTokens: overrides.lastContextTokens ?? 50000,
    startTime: overrides.startTime ?? Date.now(),
    model: "Claude Opus 4.7",
    effort: "high",
    tool: "claude",
  });
}

describe("resetState", () => {
  it("clears all maps and sets", () => {
    chatSessionMap.set("chat1", {
      gen: 1, close: () => {}, cardId: null, stopped: false,
      accumulatedContent: "", finalText: "", spinnerTimer: null,
      msgTimestamp: 0, sequence: 0, cardBusy: false,
    });
    sessionInfoMap.set("chat1", {
      sessionId: "s1", turnCount: 1, lastContextTokens: 0,
      startTime: 0, model: "", effort: "", tool: "claude",
    });
    processedMessages.add("msg1");

    resetState();

    expect(chatSessionMap.size).toBe(0);
    expect(sessionInfoMap.size).toBe(0);
    expect(processedMessages.size).toBe(0);
  });
});

describe("getSessionStatus", () => {
  beforeEach(() => {
    chatSessionMap.clear();
    sessionInfoMap.clear();
  });

  it("returns null for unknown chatId", () => {
    expect(getSessionStatus("nonexistent")).toBeNull();
  });

  it("returns status for idle session (info exists, no active session)", () => {
    mockSessionInfo("chat1");
    const status = getSessionStatus("chat1");
    expect(status).not.toBeNull();
    expect(status!.sessionId).toBe("test-session-id");
    expect(status!.running).toBe(false);
    expect(status!.turnCount).toBe(3);
    expect(status!.accumulatedLength).toBe(0);
  });

  it("returns running=true for active session", () => {
    mockSessionInfo("chat1");
    mockActiveSession("chat1", { accumulatedContent: "thinking...", finalText: "reply" });
    const status = getSessionStatus("chat1");
    expect(status!.running).toBe(true);
    expect(status!.accumulatedLength).toBe(16); // "thinking..."(11) + "reply"(5)
  });

  it("returns running=false for stopped session", () => {
    mockSessionInfo("chat1");
    mockActiveSession("chat1", { stopped: true });
    const status = getSessionStatus("chat1");
    expect(status!.running).toBe(false);
  });

  it("returns correct turnCount and other info fields", () => {
    mockSessionInfo("chat1", { turnCount: 7, lastContextTokens: 100000 });
    const status = getSessionStatus("chat1");
    expect(status!.turnCount).toBe(7);
    expect(status!.lastContextTokens).toBe(100000);
  });
});

describe("getAllSessionsStatus", () => {
  beforeEach(() => {
    chatSessionMap.clear();
    sessionInfoMap.clear();
  });

  it("returns empty array when no sessions", () => {
    expect(getAllSessionsStatus()).toEqual([]);
  });

  it("returns statuses for all recorded sessions", () => {
    mockSessionInfo("chat1", { sessionId: "s1" });
    mockSessionInfo("chat2", { sessionId: "s2" });
    mockActiveSession("chat1");
    const result = getAllSessionsStatus();
    expect(result).toHaveLength(2);
    expect(result.find(r => r.chatId === "chat1")!.active).toBe(true);
    expect(result.find(r => r.chatId === "chat2")!.active).toBe(false);
  });

  it("marks stopped sessions as not active", () => {
    mockSessionInfo("chat1");
    mockActiveSession("chat1", { stopped: true });
    const result = getAllSessionsStatus();
    expect(result[0].active).toBe(false);
  });
});

describe("processedMessages dedup", () => {
  it("supports add/has semantics", () => {
    processedMessages.clear();
    processedMessages.add("msg_001");
    expect(processedMessages.has("msg_001")).toBe(true);
    expect(processedMessages.has("msg_002")).toBe(false);
  });

  it("MAX_PROCESSED is defined", () => {
    expect(MAX_PROCESSED).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// accumulateBlockContent — 统一消息块累积测试
// ---------------------------------------------------------------------------

function freshState(): AccumulatorState {
  return { accumulatedContent: "", finalText: "", chunkCount: 0 };
}

describe("accumulateBlockContent", () => {
  it("accumulates thinking block into accumulatedContent", () => {
    const s = freshState();
    accumulateBlockContent({ type: "thinking", thinking: "Let me think..." }, s);
    expect(s.accumulatedContent).toBe("Let me think...");
    expect(s.chunkCount).toBe(1);
    expect(s.finalText).toBe("");
  });

  it("accumulates text block into finalText", () => {
    const s = freshState();
    accumulateBlockContent({ type: "text", text: "Hello world" }, s);
    expect(s.finalText).toBe("Hello world");
    expect(s.accumulatedContent).toBe("");
  });

  it("accumulates tool_use block with formatted name and input", () => {
    const s = freshState();
    accumulateBlockContent(
      { type: "tool_use", name: "Read", input: { file_path: "/tmp/test.txt" } },
      s,
    );
    expect(s.accumulatedContent).toContain("📖"); // 📖
    expect(s.accumulatedContent).toContain("**Read**");
    expect(s.accumulatedContent).toContain("file_path");
  });

  it("accumulates tool_use block with long input truncated", () => {
    const s = freshState();
    const longInput = "x".repeat(500);
    accumulateBlockContent(
      { type: "tool_use", name: "Bash", input: longInput },
      s,
    );
    expect(s.accumulatedContent).toContain("...");
    // Should be truncated to 300 + "..."
    const inputPart = s.accumulatedContent.split("`")[1];
    expect(inputPart.length).toBeLessThanOrEqual(304); // 300 + "..."
  });

  it("accumulates tool_result block with success icon (✅)", () => {
    const s = freshState();
    accumulateBlockContent(
      { type: "tool_result", tool_use_id: "tool_abc123", content: "done", is_error: false },
      s,
    );
    expect(s.accumulatedContent).toContain("✅"); // ✅
    expect(s.accumulatedContent).toContain("abc123");
    expect(s.accumulatedContent).toContain("done");
  });

  it("accumulates tool_result block with error icon (❌)", () => {
    const s = freshState();
    accumulateBlockContent(
      { type: "tool_result", tool_use_id: "tool_err456", content: "failed", is_error: true },
      s,
    );
    expect(s.accumulatedContent).toContain("❌"); // ❌
  });

  it("accumulates tool_result with array content (text blocks)", () => {
    const s = freshState();
    const content = [{ type: "text", text: "line1" }, { type: "text", text: "line2" }];
    accumulateBlockContent(
      { type: "tool_result", tool_use_id: "tool_arr", content },
      s,
    );
    expect(s.accumulatedContent).toContain("line1line2");
  });

  it("accumulates tool_result with object content (JSON stringified)", () => {
    const s = freshState();
    accumulateBlockContent(
      { type: "tool_result", tool_use_id: "tool_obj", content: { key: "val" } },
      s,
    );
    expect(s.accumulatedContent).toContain('{"key":"val"}');
  });

  it("accumulates redacted_thinking block with safety notice", () => {
    const s = freshState();
    accumulateBlockContent({ type: "redacted_thinking" }, s);
    expect(s.accumulatedContent).toContain("内容被安全过滤"); // 内容被安全过滤
  });

  it("accumulates search_result block with query", () => {
    const s = freshState();
    accumulateBlockContent(
      { type: "search_result", query: "TypeScript docs" },
      s,
    );
    expect(s.accumulatedContent).toContain("🔍"); // 🔍
    expect(s.accumulatedContent).toContain("TypeScript docs");
  });

  it("accumulates compact_boundary block with trigger label", () => {
    const s = freshState();
    accumulateBlockContent(
      { type: "compact_boundary", trigger: "auto", pre_tokens: 15000, post_tokens: 8000 },
      s,
    );
    expect(s.accumulatedContent).toContain("🔄"); // 🔄
    expect(s.accumulatedContent).toContain("自动");
    expect(s.accumulatedContent).toContain("15000");
    expect(s.accumulatedContent).toContain("8000");
  });

  it("accumulates compact_boundary with manual trigger label", () => {
    const s = freshState();
    accumulateBlockContent(
      { type: "compact_boundary", trigger: "manual", pre_tokens: 20000 },
      s,
    );
    expect(s.accumulatedContent).toContain("手动");
  });

  it("accumulates multiple blocks in sequence correctly", () => {
    const s = freshState();
    accumulateBlockContent({ type: "thinking", thinking: "Hmm..." }, s);
    accumulateBlockContent({ type: "tool_use", name: "Grep", input: { pattern: "foo" } }, s);
    accumulateBlockContent(
      { type: "tool_result", tool_use_id: "abc123", content: "found 3 matches", is_error: false },
      s,
    );
    accumulateBlockContent({ type: "text", text: "I found the results." }, s);

    expect(s.accumulatedContent).toContain("Hmm...");
    expect(s.accumulatedContent).toContain("Grep");
    expect(s.accumulatedContent).toContain("found 3 matches");
    expect(s.finalText).toBe("I found the results.");
    expect(s.chunkCount).toBe(1); // Only thinking increments chunkCount
  });
});