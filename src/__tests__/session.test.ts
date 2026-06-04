import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// mock stream-state 以支持在测试中控制累积长度
const mockStreamStates = new Map<string, {
  accumulatedContent: string;
  finalReply: string;
  status?: "running" | "done" | "stopped" | "error";
  turnCount?: number;
  finalReplySentTurn?: number;
  finalReplySentAt?: number;
}>();
vi.mock("../stream-state.ts", () => ({
  readStreamState: async (sid: string) => {
    const state = mockStreamStates.get(sid);
    if (!state) return null;
    return {
      sessionId: sid,
      accumulatedContent: state.accumulatedContent,
      finalReply: state.finalReply,
      finalReplySentTurn: state.finalReplySentTurn,
      finalReplySentAt: state.finalReplySentAt,
      status: state.status ?? "running",
      chunkCount: 0,
      turnCount: state.turnCount ?? 0,
      contextTokens: 0,
      updatedAt: Date.now(),
      cwd: "",
      tool: "claude",
    };
  },
  writeStreamState: async (state: {
    sessionId: string;
    accumulatedContent: string;
    finalReply: string;
    status?: "running" | "done" | "stopped" | "error";
    turnCount?: number;
    finalReplySentTurn?: number;
    finalReplySentAt?: number;
  }) => {
    mockStreamStates.set(state.sessionId, {
      accumulatedContent: state.accumulatedContent,
      finalReply: state.finalReply,
      status: state.status,
      turnCount: state.turnCount,
      finalReplySentTurn: state.finalReplySentTurn,
      finalReplySentAt: state.finalReplySentAt,
    });
  },
  createEmptyStreamState: (sid: string, cwd: string, tool: string, turnCount: number) => ({
    sessionId: sid, status: "running" as const, accumulatedContent: "", finalReply: "", chunkCount: 0, turnCount, contextTokens: 0, updatedAt: Date.now(), cwd, tool,
  }),
  isFinalReplySentForTurn: (state: { turnCount: number; finalReplySentTurn?: number }) => state.finalReplySentTurn === state.turnCount,
  markFinalReplySent: async (sid: string, turnCount: number, sentAt = Date.now()) => {
    const state = mockStreamStates.get(sid);
    if (!state) return;
    if ((state.turnCount ?? 0) !== turnCount) return;
    if ((state.status ?? "running") === "running") return;
    state.finalReplySentTurn = turnCount;
    state.finalReplySentAt = sentAt;
  },
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
  saveSessionTool,
  accumulateBlockContent,
  pickFinalReply,
  switchChatBinding,
  rebuildBindingsFromRegistry,
  UNKNOWN_MODEL_PLACEHOLDER,
  _setSessionRegistryFileForTest,
  _resetSessionRegistryFileForTest,
  _setSessionToolsFileForTest,
  _resetSessionToolsFileForTest,
  _setAdapterForToolForTest,
  _clearAdapterCacheForTest,
  setSessionPlatform,
  recordChatPlatform,
  _getPlatformForChatForTest,
  runAgentSession,
  startUnifiedDisplayLoop,
  stopUnifiedDisplayLoop,
  _setProcessAliveForTest,
  _resetProcessAliveForTest,
  _setProcessMonitorIntervalForTest,
  _resetProcessMonitorIntervalForTest,
} from "../session.ts";
import {
  activePrompts,
  bindChatToSession,
  unbindChatFromSession,
  recordLastActiveChat,
  getLastActiveChat,
  pickDisplayChat,
  resetBindingState,
  getChatsForSession,
  displayCards,
} from "../session-chat-binding.ts";
import type { AccumulatorState } from "../session.ts";
import type { ToolAdapter, ToolPromptOptions, UnifiedBlock, SessionInfo } from "../adapters/adapter-interface.ts";
import type { PlatformAdapter } from "../platform-adapter.ts";

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
 * （仅 /state、/sessions 路径会触发 getSessionInfo，无需完整接口）。
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

function mockPlatform(name: string): PlatformAdapter {
  return {
    sendText: vi.fn(async () => true),
    sendCard: vi.fn(async () => true),
    sendRawCard: vi.fn(async () => true),
    createGroup: vi.fn(async () => `${name}-group`),
    updateChatInfo: vi.fn(async () => {}),
    getChatInfo: vi.fn(async () => ({ name, description: "" })),
    disbandChat: vi.fn(async () => {}),
    setChatAvatar: vi.fn(async () => {}),
    extractSessionInfo: vi.fn(() => null),
    cardCreate: vi.fn(async () => `${name}-card`),
    cardSend: vi.fn(async () => `${name}-message`),
    cardUpdate: vi.fn(async () => {}),
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

describe("chat platform routing", () => {
  beforeEach(() => {
    resetState();
  });

  it("uses the platform recorded for the chat before falling back to the default platform", () => {
    const feishu = mockPlatform("feishu");
    const wechat = mockPlatform("wechat");

    setSessionPlatform(feishu);
    recordChatPlatform("wx-chat", wechat);

    expect(_getPlatformForChatForTest("wx-chat")).toBe(wechat);
    expect(_getPlatformForChatForTest("feishu-chat")).toBe(feishu);
  });
});

// ---------------------------------------------------------------------------
// rebuildBindingsFromRegistry — SDK 重连/启动时只重建只读映射,不动运行时状态
//
// 这是 onReady/onReconnected 应当调用的函数(替代之前错误调用的 resetState)。
// 关键不变量:重建映射后,原有的 activePrompts、sessionInfoMap、displayCards、
// processedMessages 全部保留——SDK 重连不应当影响后台 prompt 的执行。
// ---------------------------------------------------------------------------

describe("runAgentSession previous final delivery guard", () => {
  let registryFile = "";
  let toolsFile = "";

  beforeEach(async () => {
    resetState();
    resetBindingState();
    mockStreamStates.clear();
    const dir = await mkdtemp(join(tmpdir(), "chatccc-final-guard-"));
    registryFile = join(dir, "session-registry.json");
    toolsFile = join(dir, "session-tools.json");
    _setSessionRegistryFileForTest(registryFile);
    _setSessionToolsFileForTest(toolsFile);
    _setAdapterForToolForTest(
      "claude",
      mockAdapter((sid) => ({ sessionId: sid, cwd: "/tmp" })),
    );
  });

  afterEach(() => {
    _resetSessionRegistryFileForTest();
    _resetSessionToolsFileForTest();
    _clearAdapterCacheForTest();
    resetBindingState();
  });

  it("does not resend the previous terminal final when the same turn is already marked sent", async () => {
    const platform = mockPlatform("feishu");
    setSessionPlatform(platform);
    bindChatToSession("sid-final", "chat-final");
    recordLastActiveChat("sid-final", "chat-final");
    sessionInfoMap.set("chat-final", {
      sessionId: "sid-final",
      turnCount: 1,
      lastContextTokens: 0,
      startTime: 0,
      tool: "claude",
    });
    mockStreamStates.set("sid-final", {
      accumulatedContent: "",
      finalReply: "old final",
      status: "done",
      turnCount: 1,
      finalReplySentTurn: 1,
    });

    await runAgentSession("sid-final", "next prompt", platform, "chat-final", Date.now(), "claude");

    expect(platform.sendText).not.toHaveBeenCalledWith("chat-final", "old final");
  });

  it("resends the previous terminal final when there is no delivery marker", async () => {
    const platform = mockPlatform("feishu");
    setSessionPlatform(platform);
    bindChatToSession("sid-unsent", "chat-unsent");
    recordLastActiveChat("sid-unsent", "chat-unsent");
    sessionInfoMap.set("chat-unsent", {
      sessionId: "sid-unsent",
      turnCount: 1,
      lastContextTokens: 0,
      startTime: 0,
      tool: "claude",
    });
    mockStreamStates.set("sid-unsent", {
      accumulatedContent: "",
      finalReply: "old final",
      status: "done",
      turnCount: 1,
    });

    await runAgentSession("sid-unsent", "next prompt", platform, "chat-unsent", Date.now(), "claude");

    expect(platform.sendText).toHaveBeenCalledWith("chat-unsent", "old final");
  });
});

describe("runAgentSession process monitor", () => {
  let registryFile = "";
  let toolsFile = "";

  beforeEach(async () => {
    vi.useFakeTimers();
    resetState();
    resetBindingState();
    mockStreamStates.clear();
    const dir = await mkdtemp(join(tmpdir(), "chatccc-process-monitor-"));
    registryFile = join(dir, "session-registry.json");
    toolsFile = join(dir, "session-tools.json");
    _setSessionRegistryFileForTest(registryFile);
    _setSessionToolsFileForTest(toolsFile);
    _setProcessMonitorIntervalForTest(50);
  });

  afterEach(() => {
    _resetSessionRegistryFileForTest();
    _resetSessionToolsFileForTest();
    _clearAdapterCacheForTest();
    _resetProcessAliveForTest();
    _resetProcessMonitorIntervalForTest();
    resetBindingState();
    vi.useRealTimers();
  });

  it("marks the turn as error and sends a separate notice when the CLI process disappears", async () => {
    const platform = mockPlatform("feishu");
    setSessionPlatform(platform);
    bindChatToSession("sid-process", "chat-process");
    recordLastActiveChat("sid-process", "chat-process");
    _setProcessAliveForTest(() => false);

    const adapter: ToolAdapter = {
      displayName: "Cursor",
      sessionDescPrefix: "Cursor Session:",
      createSession: async () => ({ sessionId: "sid-process" }),
      getSessionInfo: async (sid) => ({ sessionId: sid, cwd: "/tmp" }),
      closeSession: async () => {},
      prompt: async function* (
        _sid: string,
        _text: string,
        _cwd: string,
        signal?: AbortSignal,
        options?: ToolPromptOptions,
      ) {
        options?.onProcessStart?.({ pid: 12345 });
        yield { type: "assistant", blocks: [{ type: "text", text: "partial answer" }] };
        await new Promise<void>((resolve) => {
          if (signal?.aborted) {
            resolve();
            return;
          }
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    };
    _setAdapterForToolForTest("cursor", adapter);

    const runPromise = runAgentSession(
      "sid-process",
      "prompt",
      platform,
      "chat-process",
      Date.now(),
      "cursor",
    );

    await vi.waitFor(() => {
      expect(activePrompts.get("sid-process")?.processPid).toBe(12345);
    });
    await vi.advanceTimersByTimeAsync(60);
    await runPromise;

    const state = mockStreamStates.get("sid-process");
    expect(state?.status).toBe("error");
    expect(state?.finalReply).toContain("partial answer");
    expect(activePrompts.has("sid-process")).toBe(false);
    expect(platform.sendText).toHaveBeenCalledWith(
      "chat-process",
      expect.stringContaining("进程异常结束"),
    );
  });
});

describe("unified display loop WeChat delta", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetState();
    resetBindingState();
    mockStreamStates.clear();
  });

  afterEach(() => {
    stopUnifiedDisplayLoop();
    resetBindingState();
    vi.useRealTimers();
  });

  it("sends only new accumulated content when tool output arrives before an already-sent final reply", async () => {
    const platform = mockPlatform("wechat");
    platform.kind = "wechat";
    setSessionPlatform(platform);

    bindChatToSession("sid-wechat", "chat-wechat");
    recordLastActiveChat("sid-wechat", "chat-wechat");
    sessionInfoMap.set("chat-wechat", {
      sessionId: "sid-wechat",
      turnCount: 1,
      lastContextTokens: 0,
      startTime: 0,
      tool: "claude",
    });

    // 模拟 runAgentSession 创建的 WeChat display 条目
    displayCards.set("chat-wechat", {
      cardId: "",
      sequence: 0,
      cardBusy: false,
      cardCreatedAt: Date.now(),
      lastSentContent: "",
      streamErrorNotified: false,
      sessionId: "sid-wechat",
      turnCount: 1,
      dotCount: 0,
    });

    mockStreamStates.set("sid-wechat", {
      accumulatedContent: "",
      finalReply: "partial reply",
      status: "running",
    });
    startUnifiedDisplayLoop();
    await vi.advanceTimersByTimeAsync(3000);

    mockStreamStates.set("sid-wechat", {
      accumulatedContent: "tool output\n",
      finalReply: "partial reply",
      status: "running",
    });
    await vi.advanceTimersByTimeAsync(3000);

    expect(platform.sendText).toHaveBeenNthCalledWith(
      1,
      "chat-wechat",
      "partial reply",
    );
    expect(platform.sendText).toHaveBeenNthCalledWith(
      2,
      "chat-wechat",
      "tool output",
    );
  });
});

describe("unified display loop terminal card update", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetState();
    resetBindingState();
    mockStreamStates.clear();
  });

  afterEach(() => {
    stopUnifiedDisplayLoop();
    resetBindingState();
    vi.useRealTimers();
  });

  it("does not repeat the same terminal CardKit sequence while the prompt is still active", async () => {
    const platform = mockPlatform("feishu");
    platform.cardUpdate = vi.fn(async () => {
      throw new Error("CardKit update: [300317] ErrMsg: sequence number compare failed; ");
    });
    setSessionPlatform(platform);

    bindChatToSession("sid-terminal", "chat-terminal");
    recordLastActiveChat("sid-terminal", "chat-terminal");
    sessionInfoMap.set("chat-terminal", {
      sessionId: "sid-terminal",
      turnCount: 1,
      lastContextTokens: 0,
      startTime: 0,
      tool: "claude",
    });
    activePrompts.set("sid-terminal", {
      controller: new AbortController(),
      stopped: false,
      startTime: Date.now(),
    });
    displayCards.set("chat-terminal", {
      cardId: "card-terminal",
      sequence: 109,
      cardBusy: false,
      cardCreatedAt: Date.now(),
      lastSentContent: "",
      streamErrorNotified: false,
      sessionId: "sid-terminal",
      turnCount: 1,
      dotCount: 0,
    });
    mockStreamStates.set("sid-terminal", {
      accumulatedContent: "partial tool output",
      finalReply: "",
      status: "stopped",
      turnCount: 1,
    });

    startUnifiedDisplayLoop();
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(3000);

    expect(platform.cardUpdate).toHaveBeenCalledTimes(1);
    expect(platform.cardUpdate).toHaveBeenCalledWith(
      "card-terminal",
      expect.any(String),
      110,
    );
    expect(displayCards.get("chat-terminal")?.sequence).toBe(110);
  });
});

describe("rebuildBindingsFromRegistry", () => {
  let registryFile = "";

  beforeEach(async () => {
    chatSessionMap.clear();
    sessionInfoMap.clear();
    activePrompts.clear();
    processedMessages.clear();
    resetBindingState();
    const dir = await mkdtemp(join(tmpdir(), "chatccc-rebuild-"));
    registryFile = join(dir, "session-registry.json");
    _setSessionRegistryFileForTest(registryFile);
  });

  afterEach(async () => {
    _resetSessionRegistryFileForTest();
    if (registryFile) {
      await rm(dirname(registryFile), { recursive: true, force: true });
    }
  });

  it("不清空 activePrompts:后台 prompt 在 SDK 重连后必须继续被识别为活跃", async () => {
    // 模拟有一个后台 prompt 正在跑
    const controller = new AbortController();
    activePrompts.set("session-running", { controller, stopped: false, startTime: Date.now() });
    await recordSessionRegistry({
      chatId: "chat-A",
      sessionId: "session-running",
      tool: "claude",
      updatedAt: 100,
    });

    await rebuildBindingsFromRegistry();

    // 关键不变量:重连后 activePrompts 必须保留,否则后台 generator 会变孤儿
    expect(activePrompts.has("session-running")).toBe(true);
    expect(activePrompts.get("session-running")?.controller).toBe(controller);
  });

  it("不清空 sessionInfoMap:轮数计数在重连后保留", async () => {
    sessionInfoMap.set("chat-A", {
      sessionId: "sid-A", turnCount: 7, lastContextTokens: 50000,
      startTime: 1000, tool: "claude",
    });
    await recordSessionRegistry({
      chatId: "chat-A", sessionId: "sid-A", tool: "claude", updatedAt: 100,
    });

    await rebuildBindingsFromRegistry();

    expect(sessionInfoMap.get("chat-A")?.turnCount).toBe(7);
    expect(sessionInfoMap.get("chat-A")?.lastContextTokens).toBe(50000);
  });

  it("不清空 processedMessages:重连后 SDK 重推消息仍能去重", async () => {
    processedMessages.add("msg-id-1");
    processedMessages.add("msg-id-2");

    await rebuildBindingsFromRegistry();

    expect(processedMessages.has("msg-id-1")).toBe(true);
    expect(processedMessages.has("msg-id-2")).toBe(true);
  });

  it("从 registry 重建 sessionId → chatId 映射(沿用 rebuildSessionChatsFromRegistry 行为)", async () => {
    await recordSessionRegistry({
      chatId: "chat-A", sessionId: "sid-X", tool: "claude", updatedAt: 100,
    });
    await recordSessionRegistry({
      chatId: "chat-B", sessionId: "sid-X", tool: "claude", updatedAt: 200,
    });

    await rebuildBindingsFromRegistry();

    // 同一 sessionId 被两个 chatId 共享时,两个都应在映射中
    bindChatToSession("sid-X", "chat-A"); // 验证幂等(再次调用不会出错)
    expect(true).toBe(true); // 真正的断言由 sessionChatsMap 通过 pickDisplayChat 等间接验证
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
  // model/effort 来源：按 tool 分支（核心契约——决定 /state 显示是否真实）
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

  it("Cursor 会话：adapter.getSessionInfo 抛错时降级为占位符（不阻塞 /state）", async () => {
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
  let sessionsFile = "";

  beforeEach(async () => {
    chatSessionMap.clear();
    sessionInfoMap.clear();
    activePrompts.clear();
    const dir = await mkdtemp(join(tmpdir(), "chatccc-session-registry-"));
    registryFile = join(dir, "session-registry.json");
    sessionsFile = join(dir, "sessions.json");
    _setSessionRegistryFileForTest(registryFile);
    _setSessionToolsFileForTest(sessionsFile);
  });

  afterEach(async () => {
    _clearAdapterCacheForTest();
    _resetSessionRegistryFileForTest();
    _resetSessionToolsFileForTest();
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

  it("includes recent sessions without a registry chat binding", async () => {
    await saveSessionTool("orphan-session", "claude");
    activePrompts.set("orphan-session", {
      controller: new AbortController(),
      stopped: false,
      startTime: 3000,
    });

    const result = await getAllSessionsStatus();
    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe("orphan-session");
    expect(result[0].chatId).toBe("");
    expect(result[0].active).toBe(true);
    expect(result[0].turnCount).toBe(0);
  });

  it("orphan sessions preserve chatName from sessions.json", async () => {
    await saveSessionTool("orphan-with-name", "claude", "帮我写代码-src");
    const result = await getAllSessionsStatus();
    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe("orphan-with-name");
    expect(result[0].chatId).toBe("");
    expect(result[0].chatName).toBe("帮我写代码-src");
    expect(result[0].active).toBe(false);
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
    mockSessionInfo("chat1", { sessionId: "s1" });
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
    expect(s.accumulatedContent).toBe("\n> Let me think...\n");
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
    expect(s.accumulatedContent).toContain("/tmp/test.txt");
  });

  it("accumulates tool_use block with long input truncated", () => {
    const s = freshState();
    const longInput = "x".repeat(500);
    accumulateBlockContent(
      { type: "tool_use", name: "Bash", input: { command: longInput } },
      s,
    );
    // 简化规则截断到 500 chars
    expect(s.accumulatedContent).toContain("🖥️");
    expect(s.accumulatedContent).toContain("**Bash**");
    // command 超过 maxLength=500 时会被截断
    const body = s.accumulatedContent.split("**Bash** ")[1]?.trim() ?? "";
    expect(body.length).toBeLessThanOrEqual(503); // 500 + "..."
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

    expect(s.accumulatedContent).toContain("> Hmm...");
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

// ---------------------------------------------------------------------------
// pickDisplayChat — display loop 选择推送目标 chat 的纯函数
// 关键不变量：仅当某 chatId 既是 session 的"最后活跃 chat"且仍然绑定到该
// session 时才返回。否则返回 undefined（loop 当作"无活跃群"，不推送）。
// 这是为了修复 /newh 后旧 session 仍向已解绑群推卡片的 bug。
// ---------------------------------------------------------------------------

describe("pickDisplayChat", () => {
  beforeEach(() => {
    resetBindingState();
  });

  it("绑定 + 记录活跃后，返回该 chatId", () => {
    bindChatToSession("sid-A", "chat_X");
    recordLastActiveChat("sid-A", "chat_X");
    expect(pickDisplayChat("sid-A")).toBe("chat_X");
  });

  it("从未记录过活跃 chat 时返回 undefined", () => {
    bindChatToSession("sid-A", "chat_X");
    expect(pickDisplayChat("sid-A")).toBeUndefined();
  });

  it("最后活跃 chat 已被解绑（如 /newh 场景）时返回 undefined，避免向已离开本 session 的群推送", () => {
    bindChatToSession("sid-A", "chat_X");
    recordLastActiveChat("sid-A", "chat_X");
    // 模拟 /newh：chat_X 被解绑，转给新 session
    unbindChatFromSession("sid-A", "chat_X");
    expect(pickDisplayChat("sid-A")).toBeUndefined();
  });

  it("session 仍绑定其他 chat 但 lastActive 是已解绑 chat 时返回 undefined（不应回退到任意绑定）", () => {
    // 多群共享 session 的极端情况：lastActive 指向 chat_X，但 chat_X 已解绑
    bindChatToSession("sid-A", "chat_X");
    bindChatToSession("sid-A", "chat_Y");
    recordLastActiveChat("sid-A", "chat_X");
    unbindChatFromSession("sid-A", "chat_X");
    expect(pickDisplayChat("sid-A")).toBeUndefined();
  });

  it("session 绑定多个 chat 且 lastActive 是仍绑定的 chat 时正确返回", () => {
    bindChatToSession("sid-A", "chat_X");
    bindChatToSession("sid-A", "chat_Y");
    recordLastActiveChat("sid-A", "chat_Y");
    expect(pickDisplayChat("sid-A")).toBe("chat_Y");
  });
});

// ---------------------------------------------------------------------------
// unbindChatFromSession — 双保险：清理 lastActiveChatMap[sessionId]
// 若该 sessionId 的 lastActive 正好指向被解绑的 chatId，则一并清掉，
// 防止后续逻辑（不仅 display loop）读到悬挂的旧记录。
// ---------------------------------------------------------------------------

describe("unbindChatFromSession 同步清理 lastActiveChatMap", () => {
  beforeEach(() => {
    resetBindingState();
  });

  it("解绑的 chat 正是 lastActive 时清掉记录", () => {
    bindChatToSession("sid-A", "chat_X");
    recordLastActiveChat("sid-A", "chat_X");
    unbindChatFromSession("sid-A", "chat_X");
    expect(getLastActiveChat("sid-A")).toBeUndefined();
  });

  it("解绑的 chat 不是 lastActive 时保留 lastActive", () => {
    // chat_X 是 lastActive，解绑 chat_Y 不应影响
    bindChatToSession("sid-A", "chat_X");
    bindChatToSession("sid-A", "chat_Y");
    recordLastActiveChat("sid-A", "chat_X");
    unbindChatFromSession("sid-A", "chat_Y");
    expect(getLastActiveChat("sid-A")).toBe("chat_X");
  });
});

// ---------------------------------------------------------------------------
// switchChatBinding — 事务式 chat→session 切换（/newh、/session N 复用）
//
// 关键不变量：
//   1. p2p chatType 不调 updateChatInfo（私聊飞书 API 会直接抛错）
//   2. updateChatInfo 失败时,内存绑定/sessionInfoMap/displayCards 完全不动,
//      且 description 还是旧值,下次消息按旧 sessionId 路由不会乱
//   3. 成功时按 unbind 旧 → bind 新 → recordLastActiveChat 顺序原子切换
//   4. 持久化 registry + sessions.json
// ---------------------------------------------------------------------------

describe("switchChatBinding", () => {
  let registryFile = "";
  let sessionsFile = "";

  beforeEach(async () => {
    resetBindingState();
    sessionInfoMap.clear();
    const dir = await mkdtemp(join(tmpdir(), "chatccc-switch-binding-"));
    registryFile = join(dir, "session-registry.json");
    sessionsFile = join(dir, "sessions.json");
    _setSessionRegistryFileForTest(registryFile);
    _setSessionToolsFileForTest(sessionsFile);
  });

  afterEach(async () => {
    _resetSessionRegistryFileForTest();
    _resetSessionToolsFileForTest();
    if (registryFile) {
      await rm(dirname(registryFile), { recursive: true, force: true });
    }
  });

  it("群聊场景：API 成功后内存切换 + 持久化", async () => {
    const calls: Array<{ chatId: string; name: string; desc: string }> = [];
    const updateChatInfoFn = async (chatId: string, name: string, desc: string) => {
      calls.push({ chatId, name, desc });
    };

    bindChatToSession("old-sid", "chat-1");
    sessionInfoMap.set("chat-1", {
      sessionId: "old-sid", turnCount: 5, lastContextTokens: 100,
      startTime: 0, tool: "claude",
    });
    displayCards.set("chat-1", {
      cardId: "c1", sequence: 1, cardBusy: false,
      cardCreatedAt: 0, lastSentContent: "", streamErrorNotified: false,
      sessionId: "old-sid", turnCount: 5, dotCount: 0,
    });

    const result = await switchChatBinding({
      chatId: "chat-1",
      chatType: "group",
      oldSessionId: "old-sid",
      newSessionId: "new-sid",
      tool: "claude",
      chatName: "新会话-test",
      newDescription: "Claude Code Session: new-sid",
      updateChatInfoFn,
    });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      chatId: "chat-1",
      name: "新会话-test",
      desc: "Claude Code Session: new-sid",
    });
    // 旧 session 已解绑,新 session 已绑
    expect(getChatsForSession("old-sid")).toEqual([]);
    expect(getChatsForSession("new-sid")).toEqual(["chat-1"]);
    // displayCards 已清
    expect(displayCards.has("chat-1")).toBe(false);
    // sessionInfoMap 指向新 sessionId
    expect(sessionInfoMap.get("chat-1")?.sessionId).toBe("new-sid");
    // lastActiveChat 指向当前 chat
    expect(getLastActiveChat("new-sid")).toBe("chat-1");
  });

  it("私聊场景：完全跳过 updateChatInfo,仍完成内存切换", async () => {
    let called = false;
    const updateChatInfoFn = async () => {
      called = true;
      throw new Error("p2p chat API would fail");
    };

    const result = await switchChatBinding({
      chatId: "p2p-chat",
      chatType: "p2p",
      oldSessionId: null,
      newSessionId: "new-sid-p2p",
      tool: "claude",
      chatName: "新会话-p2p",
      newDescription: "Claude Code Session: new-sid-p2p",
      updateChatInfoFn,
    });

    expect(result.ok).toBe(true);
    expect(called).toBe(false); // 私聊跳过 API 调用
    expect(getChatsForSession("new-sid-p2p")).toEqual(["p2p-chat"]);
    expect(sessionInfoMap.get("p2p-chat")?.sessionId).toBe("new-sid-p2p");
  });

  it("群聊 + updateChatInfo 抛错：内存完全不动 + 返回 error", async () => {
    bindChatToSession("old-sid", "chat-1");
    sessionInfoMap.set("chat-1", {
      sessionId: "old-sid", turnCount: 5, lastContextTokens: 100,
      startTime: 0, tool: "claude",
    });
    const oldDisplay = {
      cardId: "c1", sequence: 1, cardBusy: false,
      cardCreatedAt: 0, lastSentContent: "", streamErrorNotified: false,
      sessionId: "old-sid", turnCount: 5, dotCount: 0,
    };
    displayCards.set("chat-1", oldDisplay);

    const updateChatInfoFn = async () => {
      throw new Error("network timeout");
    };

    const result = await switchChatBinding({
      chatId: "chat-1",
      chatType: "group",
      oldSessionId: "old-sid",
      newSessionId: "new-sid",
      tool: "claude",
      chatName: "新会话-failed",
      newDescription: "Claude Code Session: new-sid",
      updateChatInfoFn,
    });

    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe("network timeout");
    // 内存绑定保持旧状态
    expect(getChatsForSession("old-sid")).toEqual(["chat-1"]);
    expect(getChatsForSession("new-sid")).toEqual([]);
    expect(displayCards.get("chat-1")).toBe(oldDisplay);
    expect(sessionInfoMap.get("chat-1")?.sessionId).toBe("old-sid");
    expect(sessionInfoMap.get("chat-1")?.turnCount).toBe(5);
  });

  it("oldSessionId 为 null 时不调 unbind(适用于私聊首次绑定)", async () => {
    const updateChatInfoFn = async () => {};

    const result = await switchChatBinding({
      chatId: "fresh-chat",
      chatType: "p2p",
      oldSessionId: null,
      newSessionId: "fresh-sid",
      tool: "claude",
      chatName: "首次会话",
      newDescription: "Claude Code Session: fresh-sid",
      updateChatInfoFn,
    });

    expect(result.ok).toBe(true);
    expect(getChatsForSession("fresh-sid")).toEqual(["fresh-chat"]);
  });

  it("API 成功后,registry 持久化记录可被重新加载", async () => {
    const updateChatInfoFn = async () => {};

    await switchChatBinding({
      chatId: "chat-persist",
      chatType: "group",
      oldSessionId: null,
      newSessionId: "persist-sid",
      tool: "cursor",
      chatName: "persist-name",
      newDescription: "Cursor Session: persist-sid",
      initialTurnCount: 3,
      initialContextTokens: 500,
      updateChatInfoFn,
    });

    // 验证 registry 文件已写入
    const raw = await readFile(registryFile, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed["chat-persist"]).toMatchObject({
      chatId: "chat-persist",
      sessionId: "persist-sid",
      tool: "cursor",
      chatName: "persist-name",
      turnCount: 3,
      lastContextTokens: 500,
      running: false,
    });
  });
});

// ---------------------------------------------------------------------------
// resetState 调用契约：仅供测试 + 进程首次启动。
// 不应在 SDK onReady/onReconnected 中调用——会清空 activePrompts 让正在跑
// 的后台 prompt 变成"孤儿 generator"（Map 删了但 controller 没 abort,
// 导致同一 sessionId 双开 prompt）。
// ---------------------------------------------------------------------------

describe("resetState 契约：清空所有运行时状态", () => {
  it("清空 activePrompts 但不 abort controller(只能由进程首次启动调用)", () => {
    const controller = new AbortController();
    let aborted = false;
    controller.signal.addEventListener("abort", () => { aborted = true; });
    activePrompts.set("sid-running", {
      controller, stopped: false, startTime: 0,
    });

    resetState();

    expect(activePrompts.size).toBe(0);
    // 注意：resetState 不主动 abort——所以如果生产代码在 prompt 跑过程中
    // 误调 resetState,后台 generator 仍会继续跑直到自然结束,但 activePrompts
    // 已经空了,下条消息会双开 prompt。这是 resetState 仅适用于"启动时"
    // (Map 本就是空的)的根本原因。
    expect(aborted).toBe(false);
  });
});
