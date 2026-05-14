import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// mock stream-state 以支持在测试中控制累积长度
const mockStreamStates = new Map<string, { accumulatedContent: string; finalReply: string }>();
vi.mock("../stream-state.ts", () => ({
  readStreamState: async (sid: string) => {
    const state = mockStreamStates.get(sid);
    if (!state) return null;
    return { sessionId: sid, accumulatedContent: state.accumulatedContent, finalReply: state.finalReply, status: "running", chunkCount: 0, turnCount: 0, contextTokens: 0, updatedAt: Date.now(), cwd: "", tool: "claude" };
  },
  writeStreamState: async () => {},
  createEmptyStreamState: (sid: string, cwd: string, tool: string, turnCount: number) => ({
    sessionId: sid, status: "running" as const, accumulatedContent: "", finalReply: "", chunkCount: 0, turnCount, contextTokens: 0, updatedAt: Date.now(), cwd, tool,
  }),
  fixStaleStreamStates: async () => {},
}));
import {
  chatSessionMap,
  sessionInfoMap,
  processedMessages,
  MAX_PROCESSED,
  resetState,
  getSessionStatus,
  getAllSessionsStatus,
  recordSessionRegistry,
  accumulateBlockContent,
  pickFinalReply,
  UNKNOWN_MODEL_PLACEHOLDER,
  _setSessionRegistryFileForTest,
  _resetSessionRegistryFileForTest,
  _setAdapterForToolForTest,
  _clearAdapterCacheForTest,
} from "../session.ts";
import { activePrompts } from "../session-chat-binding.ts";
import type { AccumulatorState } from "../session.ts";
import type { ToolAdapter, UnifiedBlock, SessionInfo } from "../adapters/adapter-interface.ts";

// Helper to create a mock active session entry
function mockActiveSession(chatId: string, overrides: Partial<{
  accumulatedContent: string;
  finalText: string;
  stopped: boolean;
}> = {}) {
  const info = sessionInfoMap.get(chatId);
  const sessionId = info?.sessionId ?? "test-session-id";
  activePrompts.set(sessionId, {
    controller: new AbortController(),
    stopped: overrides.stopped ?? false,
    startTime: Date.now(),
  });
  mockStreamStates.set(sessionId, {
    accumulatedContent: overrides.accumulatedContent ?? "thinking...",
    finalReply: overrides.finalText ?? "",
  });
  // 保留 chatSessionMap 兼容旧测试
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
  tool: string;
}> = {}) {
  sessionInfoMap.set(chatId, {
    sessionId: overrides.sessionId ?? "test-session-id",
    turnCount: overrides.turnCount ?? 3,
    lastContextTokens: overrides.lastContextTokens ?? 50000,
    startTime: overrides.startTime ?? Date.now(),
    tool: overrides.tool ?? "claude",
  });
}

/**
 * 简易 mock adapter：getSessionInfo 返回固定 SessionInfo，其他方法不实现
 * （仅 /status、/sessions 路径会触发 getSessionInfo，无需完整接口）。
 */
function mockAdapter(getInfo: (sid: string) => SessionInfo | undefined): ToolAdapter {
  return {
    displayName: "MockTool",
    sessionDescPrefix: "Mock Session:",
    createSession: async () => ({ sessionId: "" }),
    prompt: async function* () {},
    getSessionInfo: async (sid) => getInfo(sid),
    closeSession: async () => {},
  };
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
      startTime: 0, tool: "claude",
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
    activePrompts.clear();
    mockStreamStates.clear();
  });

  afterEach(() => {
    _clearAdapterCacheForTest();
  });

  it("returns null for unknown chatId", async () => {
    await expect(getSessionStatus("nonexistent")).resolves.toBeNull();
  });

  it("returns status for idle session (info exists, no active session)", async () => {
    mockSessionInfo("chat1");
    const status = await getSessionStatus("chat1");
    expect(status).not.toBeNull();
    expect(status!.sessionId).toBe("test-session-id");
    expect(status!.running).toBe(false);
    expect(status!.turnCount).toBe(3);
    expect(status!.accumulatedLength).toBe(0);
  });

  it("returns running=true for active session", async () => {
    mockSessionInfo("chat1");
    mockActiveSession("chat1", { accumulatedContent: "thinking...", finalText: "reply" });
    const status = await getSessionStatus("chat1");
    expect(status!.running).toBe(true);
    expect(status!.accumulatedLength).toBe(16); // "thinking..."(11) + "reply"(5)
  });

  it("returns running=false for stopped session", async () => {
    mockSessionInfo("chat1");
    mockActiveSession("chat1", { stopped: true });
    const status = await getSessionStatus("chat1");
    expect(status!.running).toBe(false);
  });

  it("returns correct turnCount and other info fields", async () => {
    mockSessionInfo("chat1", { turnCount: 7, lastContextTokens: 100000 });
    const status = await getSessionStatus("chat1");
    expect(status!.turnCount).toBe(7);
    expect(status!.lastContextTokens).toBe(100000);
  });

  // -------------------------------------------------------------------------
  // model/effort 来源：按 tool 分支（核心契约——决定 /status 显示是否真实）
  // -------------------------------------------------------------------------

  it("Claude 会话：effort 非 null（始终显示该行）；model 来自全局配置", async () => {
    mockSessionInfo("chat-claude", { tool: "claude" });
    const status = await getSessionStatus("chat-claude");
    expect(status!.effort).not.toBeNull();
    // model 必为字符串（留空时显示 '(留空)'，否则为环境变量值）；不应是占位符
    expect(typeof status!.model).toBe("string");
    expect(status!.model.length).toBeGreaterThan(0);
  });

  it("Cursor 会话：effort 恒为 null（卡片渲染时隐藏该行，避免显示无意义的 effort）", async () => {
    mockSessionInfo("chat-cursor", { sessionId: "sid-cur", tool: "cursor" });
    _setAdapterForToolForTest(
      "cursor",
      mockAdapter(() => ({ sessionId: "sid-cur", model: "Composer 2 Fast" })),
    );
    const status = await getSessionStatus("chat-cursor");
    expect(status!.effort).toBeNull();
  });

  it("Cursor 会话：model 来自 adapter.getSessionInfo（真实模型，不是 ChatCCC 配置）", async () => {
    mockSessionInfo("chat-cursor", { sessionId: "sid-cur", tool: "cursor" });
    _setAdapterForToolForTest(
      "cursor",
      mockAdapter((sid) =>
        sid === "sid-cur"
          ? { sessionId: sid, cwd: "/tmp", model: "Composer 2 Fast" }
          : undefined,
      ),
    );
    const status = await getSessionStatus("chat-cursor");
    expect(status!.model).toBe("Composer 2 Fast");
  });

  it("Cursor 会话：adapter 没返回 model 时使用占位符（不应硬塞任何模型字面量）", async () => {
    mockSessionInfo("chat-cursor", { sessionId: "sid-cur", tool: "cursor" });
    _setAdapterForToolForTest(
      "cursor",
      mockAdapter(() => ({ sessionId: "sid-cur" /* 无 model */ })),
    );
    const status = await getSessionStatus("chat-cursor");
    expect(status!.model).toBe(UNKNOWN_MODEL_PLACEHOLDER);
  });

  it("Cursor 会话：adapter.getSessionInfo 抛错时降级为占位符（不阻塞 /status）", async () => {
    mockSessionInfo("chat-cursor", { sessionId: "sid-cur", tool: "cursor" });
    _setAdapterForToolForTest(
      "cursor",
      mockAdapter(() => {
        throw new Error("simulated adapter failure");
      }),
    );
    const status = await getSessionStatus("chat-cursor");
    expect(status!.model).toBe(UNKNOWN_MODEL_PLACEHOLDER);
    expect(status!.effort).toBeNull();
  });
});

describe("getAllSessionsStatus", () => {
  let registryFile = "";

  beforeEach(async () => {
    chatSessionMap.clear();
    sessionInfoMap.clear();
    activePrompts.clear();
    const dir = await mkdtemp(join(tmpdir(), "chatccc-session-registry-"));
    registryFile = join(dir, "session-registry.json");
    _setSessionRegistryFileForTest(registryFile);
  });

  afterEach(async () => {
    _clearAdapterCacheForTest();
    _resetSessionRegistryFileForTest();
    if (registryFile) {
      await rm(dirname(registryFile), { recursive: true, force: true });
    }
  });

  it("returns empty array when no sessions", async () => {
    await expect(getAllSessionsStatus()).resolves.toEqual([]);
  });

  it("does not read memory-only sessions", async () => {
    mockSessionInfo("chat1", { sessionId: "s1" });
    mockSessionInfo("chat2", { sessionId: "s2" });
    mockActiveSession("chat1");

    const result = await getAllSessionsStatus();
    expect(result).toEqual([]);
  });

  it("returns statuses from disk registry", async () => {
    await recordSessionRegistry({
      chatId: "chat1",
      sessionId: "s1",
      tool: "claude",
      chatName: "test-chat-1",
      turnCount: 2,
      startTime: 1000,
      updatedAt: 2000,
      running: true,
    });
    await recordSessionRegistry({
      chatId: "chat2",
      sessionId: "s2",
      tool: "claude",
      chatName: "test-chat-2",
      turnCount: 0,
      startTime: 900,
      updatedAt: 1900,
      running: false,
    });

    const result = await getAllSessionsStatus();
    expect(result).toHaveLength(2);
    expect(result[0].chatId).toBe("chat1");
    // running=true in registry doesn't make it active — must be in activePrompts
    expect(result[0].active).toBe(false);
    expect(result[0].turnCount).toBe(2);
    expect(result[0].chatName).toBe("test-chat-1");
    expect(result[1].chatId).toBe("chat2");
    expect(result[1].active).toBe(false);
    expect(result[1].chatName).toBe("test-chat-2");
  });

  it("returns recent disk sessions by updatedAt desc, limited to 20", async () => {
    for (let i = 0; i < 25; i++) {
      await recordSessionRegistry({
        chatId: `chat-${i}`,
        sessionId: `sid-${i}`,
        tool: "claude",
        startTime: i,
        updatedAt: 1000 + i,
      });
    }

    const result = await getAllSessionsStatus();
    expect(result).toHaveLength(20);
    expect(result[0].chatId).toBe("chat-24");
    expect(result[19].chatId).toBe("chat-5");
    expect(result.some((r) => r.chatId === "chat-4")).toBe(false);
  });

  it("shows session as inactive when not in activePrompts, regardless of registry running field", async () => {
    await recordSessionRegistry({
      chatId: "chat1",
      sessionId: "s1",
      tool: "claude",
      running: true,
      updatedAt: 1000,
    });

    const result = await getAllSessionsStatus();
    // After restart, activePrompts is cleared; registry running=true should not show as active
    expect(result.find(r => r.chatId === "chat1")!.active).toBe(false);
  });

  it("shows session as active when in activePrompts", async () => {
    await recordSessionRegistry({
      chatId: "chat1",
      sessionId: "s1",
      tool: "claude",
      running: false, // registry says false, but activePrompts wins
      updatedAt: 1000,
    });
    mockActiveSession("chat1");

    const result = await getAllSessionsStatus();
    expect(result.find(r => r.chatId === "chat1")!.active).toBe(true);
  });

  it("persists chatName across updates and defaults to empty string when not set", async () => {
    await recordSessionRegistry({
      chatId: "chat-a",
      sessionId: "sa",
      tool: "claude",
      chatName: "My Chat",
      updatedAt: 100,
    });
    // Update without chatName — should keep existing
    await recordSessionRegistry({
      chatId: "chat-a",
      sessionId: "sa",
      tool: "claude",
      updatedAt: 200,
    });
    const result = await getAllSessionsStatus();
    expect(result.find(r => r.chatId === "chat-a")!.chatName).toBe("My Chat");
  });

  it("chatName defaults to empty string for sessions without it", async () => {
    await recordSessionRegistry({
      chatId: "chat-b",
      sessionId: "sb",
      tool: "claude",
      updatedAt: 100,
    });
    const result = await getAllSessionsStatus();
    expect(result.find(r => r.chatId === "chat-b")!.chatName).toBe("");
  });

  it("混合 claude + cursor 会话：各自取自己来源的 model/effort", async () => {
    await recordSessionRegistry({
      chatId: "chat-c",
      sessionId: "sid-c",
      tool: "claude",
      chatName: "claude-chat",
      updatedAt: 100,
    });
    await recordSessionRegistry({
      chatId: "chat-x",
      sessionId: "sid-x",
      tool: "cursor",
      chatName: "cursor-chat",
      updatedAt: 200,
    });
    _setAdapterForToolForTest(
      "cursor",
      mockAdapter((sid) =>
        sid === "sid-x"
          ? { sessionId: sid, cwd: "/tmp", model: "Composer 2 Fast" }
          : undefined,
      ),
    );

    const result = await getAllSessionsStatus();
    const claude = result.find((r) => r.tool === "claude")!;
    const cursor = result.find((r) => r.tool === "cursor")!;

    expect(claude.effort).not.toBeNull();
    expect(claude.model.length).toBeGreaterThan(0);

    expect(cursor.effort).toBeNull();
    expect(cursor.model).toBe("Composer 2 Fast");
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
  return { accumulatedContent: "", finalText: "", finalCompleteText: "", chunkCount: 0 };
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

  // -------------------------------------------------------------------------
  // text_final：来自 Cursor CLI 的"完整最终文本"消息
  // 行为：覆盖（不是追加）finalCompleteText，避免与 partial 累加重复
  // -------------------------------------------------------------------------

  it("accumulates text_final into finalCompleteText (覆盖语义)", () => {
    const s = freshState();
    accumulateBlockContent({ type: "text_final", text: "完整最终文本" } as UnifiedBlock, s);
    expect(s.finalCompleteText).toBe("完整最终文本");
    expect(s.finalText).toBe("");
  });

  it("text_final 多次到达时以最新一次为准（覆盖而非追加）", () => {
    const s = freshState();
    accumulateBlockContent({ type: "text_final", text: "first" } as UnifiedBlock, s);
    accumulateBlockContent({ type: "text_final", text: "second" } as UnifiedBlock, s);
    expect(s.finalCompleteText).toBe("second");
  });
});

// ---------------------------------------------------------------------------
// pickFinalReply — 在 partial 累加 vs final 完整文本之间挑选最终回复
// ---------------------------------------------------------------------------

describe("pickFinalReply", () => {
  // 新规则：有 finalCompleteText 永远优先（来自 cursor result.result，官方权威）；
  // 无则回退到 partial 累加 finalText。
  // 不再做长度比较——因为带 buffered flush 重复时 partial 可能"虚高"，长度比较会选错。

  it("finalCompleteText 非空时永远优先（即便等长）", () => {
    const reply = pickFinalReply({
      accumulatedContent: "",
      finalText: "你好世界",
      finalCompleteText: "你好世界",
      chunkCount: 0,
    });
    expect(reply).toBe("你好世界");
  });

  it("finalCompleteText 非空时优先（即便 partial 累加更长——可能被 buffered flush 污染）", () => {
    const reply = pickFinalReply({
      accumulatedContent: "",
      finalText: "你好世界你好世界", // 工具调用前 buffered flush 让 partial 累加翻倍
      finalCompleteText: "你好世界",
      chunkCount: 0,
    });
    expect(reply).toBe("你好世界");
  });

  it("无 finalCompleteText 时回退到 partial 累加 (finalText)", () => {
    const reply = pickFinalReply({
      accumulatedContent: "",
      finalText: "仅有 partial 累加",
      finalCompleteText: "",
      chunkCount: 0,
    });
    expect(reply).toBe("仅有 partial 累加");
  });

  it("两者都为空时返回空串", () => {
    expect(
      pickFinalReply({
        accumulatedContent: "",
        finalText: "",
        finalCompleteText: "",
        chunkCount: 0,
      }),
    ).toBe("");
  });
});
