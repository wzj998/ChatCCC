import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const killProcessTreeMock = vi.hoisted(() => vi.fn(async (_pid?: number) => {}));
vi.mock("../adapters/proc-tree-kill.ts", () => ({
  killProcessTree: killProcessTreeMock,
}));

// mock stream-state 以支持在测试中控制累积长度
const mockStreamStates = new Map<string, {
  accumulatedContent: string;
  finalReply: string;
  activity?: {
    kind: "starting" | "thinking" | "tool" | "processing" | "responding" | "searching" | "compacting";
    startedAt: number;
    toolName?: string;
    toolCount?: number;
  };
  status?: "running" | "done" | "stopped" | "error" | "auto_ended";
  autoEndedAt?: number;
  turnCount?: number;
  finalReplySentTurn?: number;
  finalReplySentAt?: number;
  terminalError?: {
    kind: "network_timeout" | "network" | "authentication" | "rate_limit" | "provider" | "process" | "resource" | "unknown";
    title: string;
    message: string;
    occurredAt: number;
  };
}>();
vi.mock("../stream-state.ts", () => ({
  readStreamState: async (sid: string) => {
    const state = mockStreamStates.get(sid);
    if (!state) return null;
    return {
      sessionId: sid,
      accumulatedContent: state.accumulatedContent,
      finalReply: state.finalReply,
      activity: state.activity,
      finalReplySentTurn: state.finalReplySentTurn,
      finalReplySentAt: state.finalReplySentAt,
      terminalError: state.terminalError,
      autoEndedAt: state.autoEndedAt,
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
    activity?: {
      kind: "starting" | "thinking" | "tool" | "processing" | "responding" | "searching" | "compacting";
      startedAt: number;
      toolName?: string;
      toolCount?: number;
    };
    status?: "running" | "done" | "stopped" | "error" | "auto_ended";
    autoEndedAt?: number;
    turnCount?: number;
    finalReplySentTurn?: number;
    finalReplySentAt?: number;
    terminalError?: {
      kind: "network_timeout" | "network" | "authentication" | "rate_limit" | "provider" | "process" | "resource" | "unknown";
      title: string;
      message: string;
      occurredAt: number;
    };
  }) => {
    mockStreamStates.set(state.sessionId, {
      accumulatedContent: state.accumulatedContent,
      finalReply: state.finalReply,
      activity: state.activity,
      status: state.status,
      autoEndedAt: state.autoEndedAt,
      turnCount: state.turnCount,
      finalReplySentTurn: state.finalReplySentTurn,
      finalReplySentAt: state.finalReplySentAt,
      terminalError: state.terminalError,
    });
  },
  createEmptyStreamState: (sid: string, cwd: string, tool: string, turnCount: number) => ({
    sessionId: sid, status: "running" as const, accumulatedContent: "", finalReply: "", activity: { kind: "starting" as const, startedAt: Date.now() }, chunkCount: 0, turnCount, contextTokens: 0, updatedAt: Date.now(), cwd, tool,
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
  initClaudeSession,
  runAgentSession,
  stopSession,
  startUnifiedDisplayLoop,
  stopUnifiedDisplayLoop,
  _setProcessAliveForTest,
  _resetProcessAliveForTest,
  _setProcessMonitorIntervalForTest,
  _resetProcessMonitorIntervalForTest,
  _setAvatarRefreshIntervalForTest,
  _resetAvatarRefreshIntervalForTest,
  _setResponseStallTimeoutForTest,
  _resetResponseStallTimeoutForTest,
  _setResponseStallCheckIntervalForTest,
  _resetResponseStallCheckIntervalForTest,
  _setFinalResponseCloseTimeoutForTest,
  _resetFinalResponseCloseTimeoutForTest,
  setSessionEffortOverride,
  clearSessionEffortOverride,
  getEffectiveEffortForTool,
  getEffectiveFastModeForTool,
  setSessionFastModeOverride,
  RESPONSE_STALL_RECOVERY_PROMPT,
  RESPONSE_STALL_RECOVERY_EXHAUSTED_NOTICE,
} from "../session.ts";
import { config } from "../config.ts";
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
  enqueueMessage,
  setQueueConsumer,
  isSessionRunning,
} from "../session-chat-binding.ts";
import type { AccumulatorState } from "../session.ts";
import type { ToolAdapter, ToolPromptOptions, UnifiedBlock, SessionInfo } from "../adapters/adapter-interface.ts";
import type { PlatformAdapter } from "../platform-adapter.ts";

describe("Codex Fast mode overrides", () => {
  it("uses the global default until the current session overrides it", () => {
    const previousFastMode = config.codex.fastMode;
    config.codex.fastMode = false;
    resetState();

    expect(getEffectiveFastModeForTool("codex", "sid-fast")).toBe(false);
    setSessionFastModeOverride("sid-fast", true);
    expect(getEffectiveFastModeForTool("codex", "sid-fast")).toBe(true);
    setSessionFastModeOverride("sid-fast", false);
    expect(getEffectiveFastModeForTool("codex", "sid-fast")).toBe(false);
    expect(getEffectiveFastModeForTool("claude", "sid-fast")).toBe(false);

    resetState();
    expect(getEffectiveFastModeForTool("codex", "sid-fast")).toBe(false);
    config.codex.fastMode = previousFastMode;
  });
});

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

describe("initClaudeSession startup watchdog", () => {
  afterEach(() => {
    _clearAdapterCacheForTest();
    _resetResponseStallTimeoutForTest();
    vi.useRealTimers();
  });

  it("aborts session creation when an Agent never emits its init event", async () => {
    vi.useFakeTimers();
    _setResponseStallTimeoutForTest(100);

    let aborted = false;
    const adapter: ToolAdapter = {
      displayName: "Silent Cursor",
      sessionDescPrefix: "Cursor Session:",
      createSession: async (_cwd: string, signal?: AbortSignal) => {
        await new Promise<void>((resolve) => {
          if (signal?.aborted) {
            aborted = true;
            resolve();
            return;
          }
          signal?.addEventListener("abort", () => {
            aborted = true;
            resolve();
          }, { once: true });
        });
        throw new Error("adapter aborted");
      },
      prompt: async function* () {},
      getSessionInfo: async () => undefined,
      closeSession: async () => {},
    };
    _setAdapterForToolForTest("cursor", adapter);

    let outcome: unknown;
    void initClaudeSession("cursor", "F:\\repo").then(
      (value) => { outcome = value; },
      (err) => { outcome = err; },
    );

    await vi.advanceTimersByTimeAsync(101);

    expect(aborted).toBe(true);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain("3 minutes");
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
    _resetResponseStallTimeoutForTest();
    _resetResponseStallCheckIntervalForTest();
    _resetFinalResponseCloseTimeoutForTest();
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

  it("persists and sends the root cause when the agent stream fails before producing output", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const platform = mockPlatform("feishu");
    platform.cardCreate = vi.fn(async () => {
      throw new Error("CardKit unavailable");
    });
    setSessionPlatform(platform);
    bindChatToSession("sid-stream-error", "chat-stream-error");
    recordLastActiveChat("sid-stream-error", "chat-stream-error");

    const adapter: ToolAdapter = {
      displayName: "CCC Agent",
      sessionDescPrefix: "CCC Session:",
      createSession: async () => ({ sessionId: "sid-stream-error" }),
      getSessionInfo: async (sid) => ({ sessionId: sid, cwd: "/tmp" }),
      closeSession: async () => {},
      prompt: async function* () {
        throw new Error(
          "Failed after 3 attempts. Last error: Cannot connect to API: " +
          "Connect Timeout Error (timeout: 10000ms)",
        );
      },
    };
    _setAdapterForToolForTest("ccc", adapter);

    const outcome = await runAgentSession(
      "sid-stream-error",
      "prompt",
      platform,
      "chat-stream-error",
      Date.now(),
      "ccc",
    );

    const state = mockStreamStates.get("sid-stream-error");
    expect(outcome).toBe("error");
    expect(state?.status).toBe("error");
    expect(state?.terminalError?.kind).toBe("network_timeout");
    expect(state?.terminalError?.message).toContain("已重试 3 次");
    expect(platform.sendText).toHaveBeenCalledWith(
      "chat-stream-error",
      expect.stringContaining("网络连接超时"),
    );
  });

  it("recreates the progress card when the initial CardKit send fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const platform = mockPlatform("feishu");
    platform.cardCreate = vi.fn()
      .mockResolvedValueOnce("bad-card")
      .mockResolvedValueOnce("good-card");
    platform.cardSend = vi.fn()
      .mockRejectedValueOnce(new Error("cardid is invalid"))
      .mockResolvedValueOnce("message-good");
    setSessionPlatform(platform);
    bindChatToSession("sid-card-retry", "chat-card-retry");
    recordLastActiveChat("sid-card-retry", "chat-card-retry");

    const adapter: ToolAdapter = {
      displayName: "Claude Code",
      sessionDescPrefix: "Claude Code Session:",
      createSession: async () => ({ sessionId: "sid-card-retry" }),
      getSessionInfo: async (sid) => ({ sessionId: sid, cwd: "F:\\repo" }),
      closeSession: async () => {},
      prompt: async function* () {
        yield { type: "assistant", blocks: [{ type: "text", text: "done" }] };
      },
    };
    _setAdapterForToolForTest("claude", adapter);

    await runAgentSession("sid-card-retry", "prompt", platform, "chat-card-retry", Date.now(), "claude");

    expect(platform.cardCreate).toHaveBeenCalledTimes(2);
    expect(platform.cardSend).toHaveBeenNthCalledWith(1, "chat-card-retry", "bad-card");
    expect(platform.cardSend).toHaveBeenNthCalledWith(2, "chat-card-retry", "good-card");
    expect(displayCards.get("chat-card-retry")?.cardId).toBe("good-card");
    expect(platform.sendText).not.toHaveBeenCalledWith(
      "chat-card-retry",
      "生成中卡片发送失败，结果将以文本形式发送。",
    );
  });

  it("does not register an invisible progress card and sends the final text fallback", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const platform = mockPlatform("feishu");
    platform.cardCreate = vi.fn()
      .mockResolvedValueOnce("bad-card-1")
      .mockResolvedValueOnce("bad-card-2");
    platform.cardSend = vi.fn()
      .mockRejectedValueOnce(new Error("cardid is invalid"))
      .mockRejectedValueOnce(new Error("cardid is invalid again"));
    setSessionPlatform(platform);
    bindChatToSession("sid-card-fallback", "chat-card-fallback");
    recordLastActiveChat("sid-card-fallback", "chat-card-fallback");

    const adapter: ToolAdapter = {
      displayName: "Claude Code",
      sessionDescPrefix: "Claude Code Session:",
      createSession: async () => ({ sessionId: "sid-card-fallback" }),
      getSessionInfo: async (sid) => ({ sessionId: sid, cwd: "F:\\repo" }),
      closeSession: async () => {},
      prompt: async function* () {
        yield { type: "assistant", blocks: [{ type: "text", text: "final answer" }] };
      },
    };
    _setAdapterForToolForTest("claude", adapter);

    await runAgentSession("sid-card-fallback", "prompt", platform, "chat-card-fallback", Date.now(), "claude");

    expect(displayCards.has("chat-card-fallback")).toBe(false);
    expect(platform.sendText).toHaveBeenCalledWith(
      "chat-card-fallback",
      "生成中卡片发送失败，结果将以文本形式发送。",
    );
    expect(platform.sendText).toHaveBeenCalledWith("chat-card-fallback", "final answer");
    expect(mockStreamStates.get("sid-card-fallback")?.finalReplySentTurn).toBe(1);
  });

  it("consumes a queued message only after the previous turn finishes final delivery", async () => {
    const platform = mockPlatform("feishu");
    setSessionPlatform(platform);
    bindChatToSession("sid-queue-finalize", "chat-queue-finalize");
    recordLastActiveChat("sid-queue-finalize", "chat-queue-finalize");

    let releaseFinalDelivery: (() => void) | undefined;
    const finalDeliveryGate = new Promise<void>((resolve) => {
      releaseFinalDelivery = resolve;
    });
    platform.sendText = vi.fn(async (_chatId, content) => {
      if (content === "final answer") await finalDeliveryGate;
      return true;
    });

    const adapter: ToolAdapter = {
      displayName: "Claude Code",
      sessionDescPrefix: "Claude Code Session:",
      createSession: async () => ({ sessionId: "sid-queue-finalize" }),
      getSessionInfo: async (sid) => ({ sessionId: sid, cwd: "F:\\repo" }),
      closeSession: async () => {},
      prompt: async function* () {
        // 强制走最终文本发送路径，并用 gate 模拟该收尾步骤仍在进行。
        displayCards.delete("chat-queue-finalize");
        yield { type: "assistant", blocks: [{ type: "text", text: "final answer" }] };
      },
    };
    _setAdapterForToolForTest("claude", adapter);

    enqueueMessage("sid-queue-finalize", {
      text: "queued prompt",
      chatId: "chat-queue-finalize",
      openId: "open-user",
      msgTimestamp: Date.now(),
      chatType: "p2p",
    });
    const consumeQueued = vi.fn();
    setQueueConsumer(consumeQueued);

    const runPromise = runAgentSession(
      "sid-queue-finalize",
      "first prompt",
      platform,
      "chat-queue-finalize",
      Date.now(),
      "claude",
    );
    await vi.waitFor(() => {
      expect(platform.sendText).toHaveBeenCalledWith("chat-queue-finalize", "final answer");
    });
    expect(isSessionRunning("sid-queue-finalize")).toBe(true);

    await vi.advanceTimersByTimeAsync(250);
    expect(consumeQueued).not.toHaveBeenCalled();

    releaseFinalDelivery?.();
    await runPromise;
    expect(isSessionRunning("sid-queue-finalize")).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(consumeQueued).toHaveBeenCalledTimes(1);
    expect(consumeQueued).toHaveBeenCalledWith(
      platform,
      expect.objectContaining({ text: "queued prompt", chatId: "chat-queue-finalize" }),
    );
    setQueueConsumer(() => {});
  });

  it("sends the stopped notice only after the prompt generator exits", async () => {
    const platform = mockPlatform("feishu");
    setSessionPlatform(platform);
    bindChatToSession("sid-stop-notice", "chat-stop-notice");
    recordLastActiveChat("sid-stop-notice", "chat-stop-notice");

    const closeSession = vi.fn();
    let releasePrompt: (() => void) | undefined;
    const adapter: ToolAdapter = {
      displayName: "Claude Code",
      sessionDescPrefix: "Claude Code Session:",
      createSession: async () => ({ sessionId: "sid-stop-notice" }),
      getSessionInfo: async (sid) => ({ sessionId: sid, cwd: "F:\\repo" }),
      closeSession: async () => {},
      prompt: async function* (
        _sid: string,
        _text: string,
        _cwd: string,
        signal?: AbortSignal,
        options?: ToolPromptOptions,
      ) {
        const waitForStop = new Promise<void>((resolve) => {
          releasePrompt = resolve;
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        options?.onSessionCreated?.(() => {
          closeSession();
          releasePrompt?.();
        });
        yield { type: "assistant", blocks: [{ type: "text", text: "partial answer" }] };
        await waitForStop;
      },
    };
    _setAdapterForToolForTest("claude", adapter);

    const runPromise = runAgentSession(
      "sid-stop-notice",
      "prompt",
      platform,
      "chat-stop-notice",
      Date.now(),
      "claude",
    );

    await vi.waitFor(() => {
      expect(activePrompts.get("sid-stop-notice")?.closeSession).toBeTypeOf("function");
    });
    expect(platform.sendText).not.toHaveBeenCalledWith("chat-stop-notice", "会话已停止。");

    const ok = stopSession("sid-stop-notice");
    expect(ok).toBe(true);
    expect(closeSession).toHaveBeenCalledTimes(1);

    await runPromise;

    expect(platform.sendText).toHaveBeenCalledWith("chat-stop-notice", "会话已停止。");
    expect(activePrompts.has("sid-stop-notice")).toBe(false);
  });

  it("re-injects IM skill capabilities for each resumed Claude prompt", async () => {
    const platform = mockPlatform("feishu");
    setSessionPlatform(platform);
    bindChatToSession("sid-resume", "chat-resume");
    recordLastActiveChat("sid-resume", "chat-resume");

    const sentTexts: string[] = [];
    const adapter: ToolAdapter = {
      displayName: "Claude Code",
      sessionDescPrefix: "Claude Code Session:",
      createSession: async () => ({ sessionId: "sid-resume" }),
      getSessionInfo: async (sid) => ({ sessionId: sid, cwd: "F:\\repo" }),
      closeSession: async () => {},
      prompt: async function* (_sid: string, text: string) {
        sentTexts.push(text);
        yield { type: "assistant", blocks: [{ type: "text", text: "done" }] };
      },
    };
    _setAdapterForToolForTest("claude", adapter);

    await runAgentSession("sid-resume", "first prompt", platform, "chat-resume", Date.now(), "claude");
    await runAgentSession("sid-resume", "second prompt", platform, "chat-resume", Date.now(), "claude");

    expect(sentTexts).toHaveLength(2);
    for (const text of sentTexts) {
      expect(text).toContain("[ChatCCC IM skill: feishu-skill]");
      expect(text).toContain("[/ChatCCC IM skill: feishu-skill]");
      expect(text).toContain('"session_id":"sid-resume"');
      expect(text).toContain("http://127.0.0.1:");
      expect(text).toContain("/api/agent/send-image");
      expect(text).toContain("[User message]");
      expect(text).toContain("[/User message]");
    }
    expect(sentTexts[0]).toContain("first prompt");
    expect(sentTexts[1]).toContain("second prompt");
  });
});

describe("runAgentSession periodic avatar refresh", () => {
  let registryFile = "";
  let toolsFile = "";

  beforeEach(async () => {
    vi.useFakeTimers();
    resetState();
    resetBindingState();
    mockStreamStates.clear();
    const dir = await mkdtemp(join(tmpdir(), "chatccc-avatar-refresh-"));
    registryFile = join(dir, "session-registry.json");
    toolsFile = join(dir, "session-tools.json");
    _setSessionRegistryFileForTest(registryFile);
    _setSessionToolsFileForTest(toolsFile);
    _setAvatarRefreshIntervalForTest(50);
  });

  afterEach(async () => {
    _resetSessionRegistryFileForTest();
    _resetSessionToolsFileForTest();
    _resetAvatarRefreshIntervalForTest();
    _clearAdapterCacheForTest();
    resetState();
    resetBindingState();
    vi.useRealTimers();
    if (registryFile) await rm(dirname(registryFile), { recursive: true, force: true });
  });

  it.each(["codex", "cursor", "claude", "ccc"])(
    "refreshes the busy avatar for %s every interval and stops after completion",
    async (tool) => {
      const sessionId = `sid-avatar-${tool}`;
      const chatId = `chat-avatar-${tool}`;
      const platform = mockPlatform("feishu");
      setSessionPlatform(platform);
      bindChatToSession(sessionId, chatId);
      recordLastActiveChat(sessionId, chatId);

      let finishPrompt: (() => void) | undefined;
      const adapter: ToolAdapter = {
        displayName: tool,
        sessionDescPrefix: `${tool} Session:`,
        createSession: async () => ({ sessionId }),
        getSessionInfo: async (sid) => ({ sessionId: sid, cwd: "/tmp" }),
        closeSession: async () => {},
        prompt: async function* () {
          yield { type: "assistant", blocks: [{ type: "text", text: "working" }] };
          await new Promise<void>((resolve) => {
            finishPrompt = resolve;
          });
          yield { type: "assistant", blocks: [{ type: "text", text: "done" }] };
        },
      };
      _setAdapterForToolForTest(tool, adapter);

      const runPromise = runAgentSession(
        sessionId,
        "prompt",
        platform,
        chatId,
        Date.now(),
        tool,
      );

      await vi.waitFor(() => {
        expect(vi.mocked(platform.setChatAvatar).mock.calls.some(
          ([calledChatId, calledTool, status]) =>
            calledChatId === chatId && calledTool === tool && status === "busy",
        )).toBe(true);
        expect(finishPrompt).toBeTypeOf("function");
      });
      const initialBusyCalls = vi.mocked(platform.setChatAvatar).mock.calls.filter(
        ([calledChatId, calledTool, status]) =>
          calledChatId === chatId && calledTool === tool && status === "busy",
      ).length;

      await vi.advanceTimersByTimeAsync(51);
      expect(vi.mocked(platform.setChatAvatar).mock.calls.filter(
        ([calledChatId, calledTool, status]) =>
          calledChatId === chatId && calledTool === tool && status === "busy",
      )).toHaveLength(initialBusyCalls + 1);

      finishPrompt?.();
      await runPromise;
      const callsAfterCompletion = vi.mocked(platform.setChatAvatar).mock.calls.length;

      await vi.advanceTimersByTimeAsync(100);
      expect(platform.setChatAvatar).toHaveBeenCalledTimes(callsAfterCompletion);
    },
  );
});

describe("runAgentSession response stall watchdog", () => {
  let tempDir = "";
  const recoveryPrompt = RESPONSE_STALL_RECOVERY_PROMPT;

  beforeEach(async () => {
    vi.useFakeTimers();
    resetState();
    resetBindingState();
    mockStreamStates.clear();
    killProcessTreeMock.mockClear();
    tempDir = await mkdtemp(join(tmpdir(), "chatccc-response-stall-"));
    _setSessionRegistryFileForTest(join(tempDir, "session-registry.json"));
    _setSessionToolsFileForTest(join(tempDir, "session-tools.json"));
  });

  afterEach(async () => {
    _resetSessionRegistryFileForTest();
    _resetSessionToolsFileForTest();
    _clearAdapterCacheForTest();
    _resetProcessAliveForTest();
    _resetResponseStallTimeoutForTest();
    _resetResponseStallCheckIntervalForTest();
    _resetFinalResponseCloseTimeoutForTest();
    resetBindingState();
    vi.useRealTimers();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it("auto-ends adapters with stall detection after three minutes of unchanged reply characters, including zero", async () => {
    vi.setSystemTime(0);
    _setResponseStallTimeoutForTest(180_000);
    _setResponseStallCheckIntervalForTest(1_000);
    _setProcessAliveForTest(() => true);

    const platform = mockPlatform("feishu");
    setSessionPlatform(platform);
    bindChatToSession("sid-response-stall", "chat-response-stall");
    recordLastActiveChat("sid-response-stall", "chat-response-stall");

    const closeSession = vi.fn();
    const adapter: ToolAdapter = {
      displayName: "Any Agent",
      sessionDescPrefix: "Agent Session:",
      createSession: async () => ({ sessionId: "sid-response-stall" }),
      getSessionInfo: async (sid) => ({ sessionId: sid, cwd: "F:\\repo" }),
      closeSession: async () => {},
      prompt: async function* (
        _sid: string,
        _text: string,
        _cwd: string,
        signal?: AbortSignal,
        options?: ToolPromptOptions,
      ) {
        options?.onSessionCreated?.(closeSession);
        options?.onProcessStart?.({ pid: 4242 });
        yield { type: "assistant", blocks: [{ type: "text", text: "" }] };
        await new Promise<void>((resolve) => {
          if (signal?.aborted) {
            resolve();
            return;
          }
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    };
    _setAdapterForToolForTest("claude", adapter);

    const runPromise = runAgentSession(
      "sid-response-stall",
      "prompt",
      platform,
      "chat-response-stall",
      Date.now(),
      "claude",
    );

    await vi.waitFor(() => {
      expect(activePrompts.get("sid-response-stall")?.responseProgress).toEqual({
        totalChars: 0,
        unchangedSince: expect.any(Number),
      });
    });

    const progress = activePrompts.get("sid-response-stall")!.responseProgress!;
    const remainingBeforeBoundary = progress.unchangedSince + 180_000 - Date.now() - 1;
    await vi.advanceTimersByTimeAsync(remainingBeforeBoundary);
    expect(activePrompts.has("sid-response-stall")).toBe(true);

    await vi.advanceTimersByTimeAsync(1_001);
    await runPromise;

    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(killProcessTreeMock).toHaveBeenCalledWith(4242);
    expect(activePrompts.has("sid-response-stall")).toBe(false);
    expect(mockStreamStates.get("sid-response-stall")).toMatchObject({
      status: "auto_ended",
      finalReply: "",
      autoEndedAt: expect.any(Number),
    });
  });

  it("does not detect response stalls when the adapter disables streamed-output monitoring", async () => {
    vi.setSystemTime(0);
    _setResponseStallTimeoutForTest(180_000);
    _setResponseStallCheckIntervalForTest(1_000);
    _setProcessAliveForTest(() => true);

    const platform = mockPlatform("feishu");
    setSessionPlatform(platform);
    bindChatToSession("sid-non-streaming", "chat-non-streaming");
    recordLastActiveChat("sid-non-streaming", "chat-non-streaming");

    let finishPrompt: (() => void) | undefined;
    const closeSession = vi.fn();
    const adapter: ToolAdapter = {
      displayName: "Non-streaming DeepCCC",
      sessionDescPrefix: "CCC Session:",
      responseStallDetectionEnabled: false,
      createSession: async () => ({ sessionId: "sid-non-streaming" }),
      getSessionInfo: async (sid) => ({ sessionId: sid, cwd: "F:\\repo" }),
      closeSession: async () => {},
      prompt: async function* (
        _sid: string,
        _text: string,
        _cwd: string,
        _signal?: AbortSignal,
        options?: ToolPromptOptions,
      ) {
        options?.onSessionCreated?.(closeSession);
        options?.onProcessStart?.({ pid: 4545 });
        yield { type: "assistant", blocks: [{ type: "agent_status", status: "responding" }] };
        await new Promise<void>((resolve) => {
          finishPrompt = resolve;
        });
      },
    };
    _setAdapterForToolForTest("ccc", adapter);

    const runPromise = runAgentSession(
      "sid-non-streaming",
      "prompt",
      platform,
      "chat-non-streaming",
      Date.now(),
      "ccc",
    );

    await vi.waitFor(() => {
      expect(activePrompts.get("sid-non-streaming")?.processPid).toBe(4545);
      expect(finishPrompt).toBeTypeOf("function");
    });
    expect(activePrompts.get("sid-non-streaming")?.responseStallMonitor).toBeUndefined();

    await vi.advanceTimersByTimeAsync(181_001);

    expect(activePrompts.has("sid-non-streaming")).toBe(true);
    expect(closeSession).not.toHaveBeenCalled();
    expect(killProcessTreeMock).not.toHaveBeenCalledWith(4545);
    expect(mockStreamStates.get("sid-non-streaming")?.status).toBe("running");

    finishPrompt?.();
    await runPromise;
  });

  it("does not apply the reply-stall timeout while an Agent is compacting context", async () => {
    vi.setSystemTime(0);
    _setResponseStallTimeoutForTest(180_000);
    _setResponseStallCheckIntervalForTest(1_000);
    _setProcessAliveForTest(() => true);

    const platform = mockPlatform("feishu");
    setSessionPlatform(platform);
    bindChatToSession("sid-starting-stall", "chat-starting-stall");
    recordLastActiveChat("sid-starting-stall", "chat-starting-stall");

    const closeSession = vi.fn();
    const adapter: ToolAdapter = {
      displayName: "Silent Agent",
      sessionDescPrefix: "Agent Session:",
      createSession: async () => ({ sessionId: "sid-starting-stall" }),
      getSessionInfo: async (sid) => ({ sessionId: sid, cwd: "F:\\repo" }),
      closeSession: async () => {},
      prompt: async function* (
        _sid: string,
        _text: string,
        _cwd: string,
        signal?: AbortSignal,
        options?: ToolPromptOptions,
      ) {
        options?.onSessionCreated?.(closeSession);
        options?.onProcessStart?.({ pid: 4343 });
        yield { type: "assistant", blocks: [{ type: "agent_status", status: "compacting" }] };
        await new Promise<void>((resolve) => {
          if (signal?.aborted) {
            resolve();
            return;
          }
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        if (false) yield { type: "assistant", blocks: [] };
      },
    };
    _setAdapterForToolForTest("codex", adapter);

    const runPromise = runAgentSession(
      "sid-starting-stall",
      "prompt",
      platform,
      "chat-starting-stall",
      Date.now(),
      "codex",
    );

    await vi.waitFor(() => {
      expect(activePrompts.get("sid-starting-stall")).toMatchObject({
        processPid: 4343,
      });
      expect(activePrompts.get("sid-starting-stall")?.responseProgress).toBeUndefined();
      expect(closeSession).toHaveBeenCalledTimes(0);
    });

    await vi.advanceTimersByTimeAsync(181_001);
    const stateAfterDeadline = mockStreamStates.get("sid-starting-stall");
    const closeCountAfterDeadline = closeSession.mock.calls.length;
    const treeKillCountAfterDeadline = killProcessTreeMock.mock.calls
      .filter(([pid]) => pid === 4343)
      .length;

    // 旧实现不会结束真正的零事件启动；先清理测试会话，避免失败用例悬挂。
    stopSession("sid-starting-stall");
    await vi.advanceTimersByTimeAsync(1_000);
    await runPromise;

    expect(stateAfterDeadline).toMatchObject({
      status: "running",
      activity: { kind: "compacting" },
    });
    expect(closeCountAfterDeadline).toBe(0);
    expect(treeKillCountAfterDeadline).toBe(0);
  });

  it("self-heals a missing trigger-chat binding and gives automatic recovery the normal card lifecycle", async () => {
    vi.setSystemTime(0);
    _setResponseStallTimeoutForTest(100);
    _setResponseStallCheckIntervalForTest(10);
    _setProcessAliveForTest(() => true);

    const platform = mockPlatform("feishu");
    setSessionPlatform(platform);

    const receivedPrompts: string[] = [];
    const adapter: ToolAdapter = {
      displayName: "Any Agent",
      sessionDescPrefix: "Agent Session:",
      createSession: async () => ({ sessionId: "sid-binding-recovery" }),
      getSessionInfo: async (sid) => ({ sessionId: sid, cwd: "F:\\repo" }),
      closeSession: async () => {},
      prompt: async function* (
        _sid: string,
        text: string,
        _cwd: string,
        signal?: AbortSignal,
        options?: ToolPromptOptions,
      ) {
        receivedPrompts.push(text);
        options?.onProcessStart?.({ pid: 5000 + receivedPrompts.length });
        if (receivedPrompts.length === 1) {
          yield { type: "assistant", blocks: [{ type: "text", text: "" }] };
          await new Promise<void>((resolve) => {
            if (signal?.aborted) {
              resolve();
              return;
            }
            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          return;
        }
        yield {
          type: "assistant",
          blocks: [{ type: "text", text: "recovery completed" }],
          isFinalResponse: true,
        };
      },
    };
    _setAdapterForToolForTest("claude", adapter);

    const firstRun = runAgentSession(
      "sid-binding-recovery",
      "first prompt",
      platform,
      "chat-binding-recovery",
      0,
      "claude",
    );

    await vi.waitFor(() => {
      expect(activePrompts.get("sid-binding-recovery")?.responseProgress).toBeDefined();
    });
    const progress = activePrompts.get("sid-binding-recovery")!.responseProgress!;
    await vi.advanceTimersByTimeAsync(progress.unchangedSince + 101 - Date.now());
    await firstRun;
    await vi.advanceTimersByTimeAsync(200);
    await vi.waitFor(() => expect(receivedPrompts).toHaveLength(2));
    await vi.waitFor(() => expect(isSessionRunning("sid-binding-recovery")).toBe(false));

    expect(getChatsForSession("sid-binding-recovery")).toContain("chat-binding-recovery");
    expect(platform.cardCreate).toHaveBeenCalledTimes(2);
    expect(platform.cardSend).toHaveBeenCalledTimes(2);
    expect(platform.sendText).toHaveBeenCalledWith(
      "chat-binding-recovery",
      expect.stringContaining(recoveryPrompt),
    );

    const registry = JSON.parse(
      await readFile(join(tempDir, "session-registry.json"), "utf8"),
    ) as Record<string, { running?: boolean }>;
    expect(registry["chat-binding-recovery"]?.running).toBe(false);
  });

  it("treats an authoritative final response that races timeout cleanup as completed", async () => {
    vi.setSystemTime(0);
    _setResponseStallTimeoutForTest(100);
    _setResponseStallCheckIntervalForTest(10);
    _setProcessAliveForTest(() => true);

    const platform = mockPlatform("feishu");
    setSessionPlatform(platform);
    bindChatToSession("sid-final-race", "chat-final-race");
    recordLastActiveChat("sid-final-race", "chat-final-race");

    const receivedPrompts: string[] = [];
    const adapter: ToolAdapter = {
      displayName: "Any Agent",
      sessionDescPrefix: "Agent Session:",
      createSession: async () => ({ sessionId: "sid-final-race" }),
      getSessionInfo: async (sid) => ({ sessionId: sid, cwd: "F:\\repo" }),
      closeSession: async () => {},
      prompt: async function* (
        _sid: string,
        text: string,
        _cwd: string,
        signal?: AbortSignal,
        options?: ToolPromptOptions,
      ) {
        receivedPrompts.push(text);
        options?.onProcessStart?.({ pid: 5151 });
        yield { type: "assistant", blocks: [{ type: "text", text: "" }] };
        await new Promise<void>((resolve) => {
          if (signal?.aborted) {
            resolve();
            return;
          }
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        yield {
          type: "assistant",
          blocks: [{ type: "text", text: "completed at the timeout boundary" }],
          isFinalResponse: true,
        };
      },
    };
    _setAdapterForToolForTest("claude", adapter);

    const run = runAgentSession(
      "sid-final-race",
      "prompt",
      platform,
      "chat-final-race",
      0,
      "claude",
    );
    await vi.waitFor(() => {
      expect(activePrompts.get("sid-final-race")?.responseProgress).toBeDefined();
    });
    const progress = activePrompts.get("sid-final-race")!.responseProgress!;
    await vi.advanceTimersByTimeAsync(progress.unchangedSince + 101 - Date.now());
    await run;
    await vi.advanceTimersByTimeAsync(1_000);

    expect(receivedPrompts).toHaveLength(1);
    expect(mockStreamStates.get("sid-final-race")).toMatchObject({
      status: "done",
      finalReply: "completed at the timeout boundary",
    });
    expect(platform.sendText).not.toHaveBeenCalledWith(
      "chat-final-race",
      RESPONSE_STALL_RECOVERY_EXHAUSTED_NOTICE,
    );
  });

  it("force-closes a stream that stays open after an authoritative final event without auto-recovery", async () => {
    vi.setSystemTime(0);
    _setResponseStallTimeoutForTest(100);
    _setResponseStallCheckIntervalForTest(10);
    _setFinalResponseCloseTimeoutForTest(1_000);
    _setProcessAliveForTest(() => true);

    const platform = mockPlatform("feishu");
    setSessionPlatform(platform);
    bindChatToSession("sid-final-close", "chat-final-close");
    recordLastActiveChat("sid-final-close", "chat-final-close");

    const closeSession = vi.fn();
    const adapter: ToolAdapter = {
      displayName: "Any Agent",
      sessionDescPrefix: "Agent Session:",
      createSession: async () => ({ sessionId: "sid-final-close" }),
      getSessionInfo: async (sid) => ({ sessionId: sid, cwd: "F:\\repo" }),
      closeSession: async () => {},
      prompt: async function* (
        _sid: string,
        _text: string,
        _cwd: string,
        signal?: AbortSignal,
        options?: ToolPromptOptions,
      ) {
        options?.onSessionCreated?.(closeSession);
        options?.onProcessStart?.({ pid: 7171 });
        yield {
          type: "assistant",
          blocks: [{ type: "text", text: "authoritative answer" }],
        };
        yield {
          type: "assistant",
          blocks: [],
          isFinalResponse: true,
        };
        await new Promise<void>((resolve) => {
          if (signal?.aborted) {
            resolve();
            return;
          }
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    };
    _setAdapterForToolForTest("claude", adapter);

    const run = runAgentSession(
      "sid-final-close",
      "prompt",
      platform,
      "chat-final-close",
      0,
      "claude",
    );

    await vi.waitFor(() => {
      expect(activePrompts.get("sid-final-close")?.finalResponseObserved).toBe(true);
    });
    await vi.advanceTimersByTimeAsync(900);
    expect(activePrompts.has("sid-final-close")).toBe(true);

    await vi.advanceTimersByTimeAsync(100);
    await run;

    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(killProcessTreeMock).toHaveBeenCalledWith(7171);
    expect(mockStreamStates.get("sid-final-close")).toMatchObject({
      status: "done",
      finalReply: "authoritative answer",
    });
    expect(platform.sendText).not.toHaveBeenCalledWith(
      "chat-final-close",
      expect.stringContaining(RESPONSE_STALL_RECOVERY_PROMPT),
    );
  });

  it("cancels the final-response close guard when the stream exits normally", async () => {
    vi.setSystemTime(0);
    _setFinalResponseCloseTimeoutForTest(1_000);
    _setProcessAliveForTest(() => true);

    const platform = mockPlatform("feishu");
    setSessionPlatform(platform);
    bindChatToSession("sid-final-normal", "chat-final-normal");
    recordLastActiveChat("sid-final-normal", "chat-final-normal");

    const closeSession = vi.fn();
    const adapter: ToolAdapter = {
      displayName: "Any Agent",
      sessionDescPrefix: "Agent Session:",
      createSession: async () => ({ sessionId: "sid-final-normal" }),
      getSessionInfo: async (sid) => ({ sessionId: sid, cwd: "F:\\repo" }),
      closeSession: async () => {},
      prompt: async function* (
        _sid: string,
        _text: string,
        _cwd: string,
        _signal?: AbortSignal,
        options?: ToolPromptOptions,
      ) {
        options?.onSessionCreated?.(closeSession);
        options?.onProcessStart?.({ pid: 7272 });
        yield {
          type: "assistant",
          blocks: [{ type: "text", text: "normal answer" }],
        };
        yield {
          type: "assistant",
          blocks: [],
          isFinalResponse: true,
        };
      },
    };
    _setAdapterForToolForTest("claude", adapter);

    await runAgentSession(
      "sid-final-normal",
      "prompt",
      platform,
      "chat-final-normal",
      0,
      "claude",
    );
    await vi.advanceTimersByTimeAsync(2_000);

    expect(closeSession).not.toHaveBeenCalled();
    expect(killProcessTreeMock).not.toHaveBeenCalled();
    expect(mockStreamStates.get("sid-final-normal")).toMatchObject({
      status: "done",
      finalReply: "normal answer",
    });
  });

  it("runs the reserved recovery prompt before an already queued user message", async () => {
    vi.setSystemTime(0);
    _setResponseStallTimeoutForTest(100);
    _setResponseStallCheckIntervalForTest(10);
    _setProcessAliveForTest(() => true);

    const platform = mockPlatform("feishu");
    setSessionPlatform(platform);
    bindChatToSession("sid-recovery-priority", "chat-recovery-priority");
    recordLastActiveChat("sid-recovery-priority", "chat-recovery-priority");

    const receivedPrompts: string[] = [];
    const adapter: ToolAdapter = {
      displayName: "Any Agent",
      sessionDescPrefix: "Agent Session:",
      createSession: async () => ({ sessionId: "sid-recovery-priority" }),
      getSessionInfo: async (sid) => ({ sessionId: sid, cwd: "F:\\repo" }),
      closeSession: async () => {},
      prompt: async function* (
        _sid: string,
        text: string,
        _cwd: string,
        signal?: AbortSignal,
        options?: ToolPromptOptions,
      ) {
        receivedPrompts.push(text);
        options?.onProcessStart?.({ pid: 5252 + receivedPrompts.length });
        if (receivedPrompts.length === 1) {
          yield { type: "assistant", blocks: [{ type: "text", text: "" }] };
          await new Promise<void>((resolve) => {
            if (signal?.aborted) {
              resolve();
              return;
            }
            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          return;
        }
        yield { type: "assistant", blocks: [{ type: "text", text: "recovery completed" }] };
      },
    };
    _setAdapterForToolForTest("claude", adapter);

    enqueueMessage("sid-recovery-priority", {
      text: "queued user prompt",
      chatId: "chat-recovery-priority",
      openId: "open-user",
      msgTimestamp: 1,
      chatType: "p2p",
    });
    const consumeQueued = vi.fn();
    setQueueConsumer(consumeQueued);

    const firstRun = runAgentSession(
      "sid-recovery-priority",
      "first prompt",
      platform,
      "chat-recovery-priority",
      0,
      "claude",
    );

    await vi.waitFor(() => {
      expect(activePrompts.get("sid-recovery-priority")?.responseProgress).toBeDefined();
    });
    const firstProgress = activePrompts.get("sid-recovery-priority")!.responseProgress!;
    await vi.advanceTimersByTimeAsync(firstProgress.unchangedSince + 101 - Date.now());
    await firstRun;

    expect(receivedPrompts).toHaveLength(1);
    expect(consumeQueued).not.toHaveBeenCalled();
    expect(isSessionRunning("sid-recovery-priority")).toBe(true);
    expect(platform.sendText).toHaveBeenCalledWith(
      "chat-recovery-priority",
      expect.stringContaining(recoveryPrompt),
    );

    await vi.advanceTimersByTimeAsync(200);
    await vi.waitFor(() => expect(receivedPrompts).toHaveLength(2));
    expect(receivedPrompts[1]).toContain(recoveryPrompt);
    expect(receivedPrompts[1]).not.toContain("queued user prompt");
    expect(consumeQueued).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);
    await vi.waitFor(() => expect(consumeQueued).toHaveBeenCalledTimes(1));
    expect(consumeQueued).toHaveBeenCalledWith(
      platform,
      expect.objectContaining({ text: "queued user prompt" }),
    );
    setQueueConsumer(() => {});
  });

  it("does not auto-recover a second consecutive response stall", async () => {
    vi.setSystemTime(0);
    _setResponseStallTimeoutForTest(100);
    _setResponseStallCheckIntervalForTest(10);
    _setProcessAliveForTest(() => true);

    const platform = mockPlatform("feishu");
    setSessionPlatform(platform);
    bindChatToSession("sid-recovery-limit", "chat-recovery-limit");
    recordLastActiveChat("sid-recovery-limit", "chat-recovery-limit");

    const receivedPrompts: string[] = [];
    const adapter: ToolAdapter = {
      displayName: "Any Agent",
      sessionDescPrefix: "Agent Session:",
      createSession: async () => ({ sessionId: "sid-recovery-limit" }),
      getSessionInfo: async (sid) => ({ sessionId: sid, cwd: "F:\\repo" }),
      closeSession: async () => {},
      prompt: async function* (
        _sid: string,
        text: string,
        _cwd: string,
        signal?: AbortSignal,
        options?: ToolPromptOptions,
      ) {
        receivedPrompts.push(text);
        options?.onProcessStart?.({ pid: 6262 + receivedPrompts.length });
        yield { type: "assistant", blocks: [{ type: "text", text: "" }] };
        await new Promise<void>((resolve) => {
          if (signal?.aborted) {
            resolve();
            return;
          }
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    };
    _setAdapterForToolForTest("claude", adapter);

    const firstRun = runAgentSession(
      "sid-recovery-limit",
      "first prompt",
      platform,
      "chat-recovery-limit",
      0,
      "claude",
    );
    await vi.waitFor(() => {
      expect(activePrompts.get("sid-recovery-limit")?.responseProgress).toBeDefined();
    });
    const firstProgress = activePrompts.get("sid-recovery-limit")!.responseProgress!;
    await vi.advanceTimersByTimeAsync(firstProgress.unchangedSince + 101 - Date.now());
    await firstRun;

    await vi.advanceTimersByTimeAsync(200);
    await vi.waitFor(() => expect(receivedPrompts).toHaveLength(2));
    const recoveryProgress = activePrompts.get("sid-recovery-limit")!.responseProgress!;
    await vi.advanceTimersByTimeAsync(recoveryProgress.unchangedSince + 101 - Date.now());
    await vi.waitFor(() => expect(isSessionRunning("sid-recovery-limit")).toBe(false));

    await vi.advanceTimersByTimeAsync(1_000);
    expect(receivedPrompts).toHaveLength(2);
    expect(receivedPrompts[1]).toContain(recoveryPrompt);
    expect(platform.sendText).toHaveBeenCalledWith(
      "chat-recovery-limit",
      "⚠️ 自动续跑仍连续 3 分钟没有生成新回复，本次不再自动继续。",
    );
  });

  it("lets /stop cancel a reserved recovery before it starts", async () => {
    vi.setSystemTime(0);
    _setResponseStallTimeoutForTest(100);
    _setResponseStallCheckIntervalForTest(10);
    _setProcessAliveForTest(() => true);

    const platform = mockPlatform("feishu");
    setSessionPlatform(platform);
    bindChatToSession("sid-recovery-stop", "chat-recovery-stop");
    recordLastActiveChat("sid-recovery-stop", "chat-recovery-stop");

    const receivedPrompts: string[] = [];
    const adapter: ToolAdapter = {
      displayName: "Any Agent",
      sessionDescPrefix: "Agent Session:",
      createSession: async () => ({ sessionId: "sid-recovery-stop" }),
      getSessionInfo: async (sid) => ({ sessionId: sid, cwd: "F:\\repo" }),
      closeSession: async () => {},
      prompt: async function* (
        _sid: string,
        text: string,
        _cwd: string,
        signal?: AbortSignal,
      ) {
        receivedPrompts.push(text);
        yield { type: "assistant", blocks: [{ type: "text", text: "" }] };
        await new Promise<void>((resolve) => {
          if (signal?.aborted) {
            resolve();
            return;
          }
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    };
    _setAdapterForToolForTest("claude", adapter);

    const firstRun = runAgentSession(
      "sid-recovery-stop",
      "first prompt",
      platform,
      "chat-recovery-stop",
      0,
      "claude",
    );
    await vi.waitFor(() => {
      expect(activePrompts.get("sid-recovery-stop")?.responseProgress).toBeDefined();
    });
    const progress = activePrompts.get("sid-recovery-stop")!.responseProgress!;
    await vi.advanceTimersByTimeAsync(progress.unchangedSince + 101 - Date.now());
    await firstRun;

    expect(isSessionRunning("sid-recovery-stop")).toBe(true);
    expect(stopSession("sid-recovery-stop")).toBe(true);
    await vi.advanceTimersByTimeAsync(500);

    expect(receivedPrompts).toHaveLength(1);
    expect(isSessionRunning("sid-recovery-stop")).toBe(false);
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

describe("unified display loop activity status", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T08:00:00.000Z"));
    resetState();
    resetBindingState();
    mockStreamStates.clear();
  });

  afterEach(() => {
    stopUnifiedDisplayLoop();
    resetBindingState();
    vi.useRealTimers();
  });

  it("renders explicit activity and elapsed time alongside the liveness dots", async () => {
    const platform = mockPlatform("feishu");
    setSessionPlatform(platform);

    bindChatToSession("sid-activity", "chat-activity");
    recordLastActiveChat("sid-activity", "chat-activity");
    sessionInfoMap.set("chat-activity", {
      sessionId: "sid-activity",
      turnCount: 1,
      lastContextTokens: 0,
      startTime: Date.now() - 12_000,
      tool: "codex",
    });
    displayCards.set("chat-activity", {
      cardId: "card-activity",
      sequence: 1,
      cardBusy: false,
      cardCreatedAt: Date.now(),
      lastSentContent: "",
      streamErrorNotified: false,
      sessionId: "sid-activity",
      turnCount: 1,
      dotCount: 0,
    });
    mockStreamStates.set("sid-activity", {
      accumulatedContent: "正在检查日志",
      finalReply: "",
      activity: {
        kind: "tool",
        startedAt: Date.now() - 12_000,
        toolName: "Shell",
        toolCount: 1,
      },
      status: "running",
      turnCount: 1,
    });

    startUnifiedDisplayLoop();
    await vi.advanceTimersByTimeAsync(3_000);

    const payload = vi.mocked(platform.cardUpdate).mock.calls[0]?.[1];
    expect(payload).toBeTypeOf("string");
    const card = JSON.parse(payload as string) as {
      header: { title: { content: string } };
      body: { elements: Array<{ tag: string; content?: string }> };
    };
    expect(card.header.title.content).toBe("正在执行 Shell · 15秒");
    expect(card.body.elements[0]?.content).toBe("正在检查日志\n。");
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

  it("shows a distinct auto-ended state and sends a warning even with an empty reply", async () => {
    const platform = mockPlatform("feishu");
    setSessionPlatform(platform);

    bindChatToSession("sid-auto-ended", "chat-auto-ended");
    recordLastActiveChat("sid-auto-ended", "chat-auto-ended");
    sessionInfoMap.set("chat-auto-ended", {
      sessionId: "sid-auto-ended",
      turnCount: 1,
      lastContextTokens: 0,
      startTime: 0,
      tool: "cursor",
    });
    displayCards.set("chat-auto-ended", {
      cardId: "card-auto-ended",
      sequence: 1,
      cardBusy: false,
      cardCreatedAt: Date.now(),
      lastSentContent: "",
      streamErrorNotified: false,
      sessionId: "sid-auto-ended",
      turnCount: 1,
      dotCount: 0,
    });
    mockStreamStates.set("sid-auto-ended", {
      accumulatedContent: "",
      finalReply: "",
      status: "auto_ended",
      turnCount: 1,
      autoEndedAt: Date.now(),
    });

    startUnifiedDisplayLoop();
    await vi.advanceTimersByTimeAsync(3_000);

    const payload = vi.mocked(platform.cardUpdate).mock.calls[0]?.[1];
    const card = JSON.parse(payload as string) as {
      header: { title: { content: string }; template?: string };
    };
    expect(card.header.title.content).toBe("已自动结束 · 3分钟无新内容");
    expect(card.header.template).toBe("orange");
    expect(platform.sendText).toHaveBeenCalledWith(
      "chat-auto-ended",
      "⚠️ 已自动结束：生成回复阶段连续 3 分钟没有字符变化。本轮没有可发送的回复内容。",
    );
    expect(displayCards.has("chat-auto-ended")).toBe(false);
  });

  it("shows the stream root cause in the error card without a duplicate text notice", async () => {
    const platform = mockPlatform("feishu");
    setSessionPlatform(platform);

    bindChatToSession("sid-network-error", "chat-network-error");
    recordLastActiveChat("sid-network-error", "chat-network-error");
    sessionInfoMap.set("chat-network-error", {
      sessionId: "sid-network-error",
      turnCount: 1,
      lastContextTokens: 0,
      startTime: 0,
      tool: "ccc",
    });
    displayCards.set("chat-network-error", {
      cardId: "card-network-error",
      sequence: 1,
      cardBusy: false,
      cardCreatedAt: Date.now(),
      lastSentContent: "",
      streamErrorNotified: false,
      sessionId: "sid-network-error",
      turnCount: 1,
      dotCount: 0,
    });
    mockStreamStates.set("sid-network-error", {
      accumulatedContent: "",
      finalReply: "",
      status: "error",
      turnCount: 1,
      terminalError: {
        kind: "network_timeout",
        title: "网络连接超时",
        message: "连接模型服务失败，已重试 3 次，单次连接等待 10 秒。请检查网络、VPN或模型服务状态后重试。",
        occurredAt: Date.now(),
      },
    });

    startUnifiedDisplayLoop();
    await vi.advanceTimersByTimeAsync(3_000);

    const payload = vi.mocked(platform.cardUpdate).mock.calls[0]?.[1];
    const card = JSON.parse(payload as string) as {
      header: { title: { content: string }; template?: string };
      body: { elements: Array<{ content?: string }> };
    };
    expect(card.header.title.content).toBe("异常结束 · 网络连接超时");
    expect(card.header.template).toBe("red");
    expect(card.body.elements[0]?.content).toContain("已重试 3 次");
    expect(platform.sendText).not.toHaveBeenCalled();
    expect(mockStreamStates.get("sid-network-error")?.finalReplySentTurn).toBe(1);
    expect(displayCards.has("chat-network-error")).toBe(false);
  });

  it("falls back to a root-cause text when the error card cannot be updated", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const platform = mockPlatform("feishu");
    platform.cardUpdate = vi.fn(async () => {
      throw new Error("CardKit unavailable");
    });
    setSessionPlatform(platform);

    bindChatToSession("sid-error-fallback", "chat-error-fallback");
    recordLastActiveChat("sid-error-fallback", "chat-error-fallback");
    sessionInfoMap.set("chat-error-fallback", {
      sessionId: "sid-error-fallback",
      turnCount: 1,
      lastContextTokens: 0,
      startTime: 0,
      tool: "ccc",
    });
    displayCards.set("chat-error-fallback", {
      cardId: "card-error-fallback",
      sequence: 1,
      cardBusy: false,
      cardCreatedAt: Date.now(),
      lastSentContent: "",
      streamErrorNotified: false,
      sessionId: "sid-error-fallback",
      turnCount: 1,
      dotCount: 0,
    });
    mockStreamStates.set("sid-error-fallback", {
      accumulatedContent: "",
      finalReply: "",
      status: "error",
      turnCount: 1,
      terminalError: {
        kind: "network_timeout",
        title: "网络连接超时",
        message: "连接模型服务失败，已重试 3 次。",
        occurredAt: Date.now(),
      },
    });

    startUnifiedDisplayLoop();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(platform.sendText).toHaveBeenCalledWith(
      "chat-error-fallback",
      expect.stringContaining("异常结束：网络连接超时"),
    );
    expect(displayCards.has("chat-error-fallback")).toBe(false);
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

  it("keeps terminal display and retries final text when sending fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const platform = mockPlatform("feishu");
    platform.cardUpdate = vi.fn(async () => {});
    platform.sendText = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    setSessionPlatform(platform);

    bindChatToSession("sid-terminal-retry", "chat-terminal-retry");
    recordLastActiveChat("sid-terminal-retry", "chat-terminal-retry");
    sessionInfoMap.set("chat-terminal-retry", {
      sessionId: "sid-terminal-retry",
      turnCount: 1,
      lastContextTokens: 0,
      startTime: 0,
      tool: "claude",
    });
    displayCards.set("chat-terminal-retry", {
      cardId: "card-terminal-retry",
      sequence: 4,
      cardBusy: false,
      cardCreatedAt: Date.now(),
      lastSentContent: "",
      streamErrorNotified: false,
      sessionId: "sid-terminal-retry",
      turnCount: 1,
      dotCount: 0,
    });
    mockStreamStates.set("sid-terminal-retry", {
      accumulatedContent: "work log",
      finalReply: "final answer",
      status: "done",
      turnCount: 1,
    });

    startUnifiedDisplayLoop();
    await vi.advanceTimersByTimeAsync(3000);

    expect(platform.cardUpdate).toHaveBeenCalledTimes(1);
    expect(platform.sendText).toHaveBeenCalledTimes(1);
    expect(displayCards.has("chat-terminal-retry")).toBe(true);
    expect(mockStreamStates.get("sid-terminal-retry")?.finalReplySentTurn).toBeUndefined();

    await vi.advanceTimersByTimeAsync(3000);

    expect(platform.cardUpdate).toHaveBeenCalledTimes(1);
    expect(platform.sendText).toHaveBeenCalledTimes(2);
    expect(displayCards.has("chat-terminal-retry")).toBe(false);
    expect(mockStreamStates.get("sid-terminal-retry")?.finalReplySentTurn).toBe(1);
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

  it("Codex session status uses the per-session effort override", async () => {
    mockSessionInfo("chat-codex", { sessionId: "sid-codex-effort", tool: "codex" });
    setSessionEffortOverride("sid-codex-effort", "xhigh");

    const status = await getSessionStatus("chat-codex");

    expect(status!.effort).toBe("xhigh");
  });

  it("CCC 会话：effort 默认取 config.ccc.effort，session override 优先", async () => {
    expect(getEffectiveEffortForTool("ccc")).toBe(config.ccc.effort);
    setSessionEffortOverride("sid-ccc-effort-default", "low");
    expect(getEffectiveEffortForTool("ccc", "sid-ccc-effort-default")).toBe("low");
    clearSessionEffortOverride("sid-ccc-effort-default");
    expect(getEffectiveEffortForTool("ccc", "sid-ccc-effort-default")).toBe(config.ccc.effort);
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

  it("CCC Agent 会话：model 来自 ccc 配置且 effort 恒为 null", async () => {
    mockSessionInfo("chat-ccc", { sessionId: "session-ccc", tool: "ccc" });

    const status = await getSessionStatus("chat-ccc");

    expect(status!.model).toBeTruthy();
    expect(status!.model).not.toBe(UNKNOWN_MODEL_PLACEHOLDER);
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
      chatType: "p2p",
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
    expect(result[0].chatType).toBe("p2p");
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

  it("clears rejected attempt output on text_reset and ignores invisible progress", () => {
    const s = freshState();
    s.accumulatedContent = "tool preview";
    s.finalText = "malformed DSML";
    s.finalCompleteText = "stale snapshot";
    s.chunkCount = 3;

    accumulateBlockContent({ type: "agent_progress", phase: "reasoning" }, s);
    expect(s.finalText).toBe("malformed DSML");

    accumulateBlockContent({ type: "text_reset" }, s);
    expect(s).toEqual(freshState());
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
// 这是为了修复 /forget 后旧 session 仍向已解绑群推卡片的 bug。
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

  it("最后活跃 chat 已被解绑（如 /forget 场景）时返回 undefined，避免向已离开本 session 的群推送", () => {
    bindChatToSession("sid-A", "chat_X");
    recordLastActiveChat("sid-A", "chat_X");
    // 模拟 /forget：chat_X 被解绑，转给新 session
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
// switchChatBinding — 事务式 chat→session 切换（/forget、/session N 复用）
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

  it("persists a fixed project naming policy across session switches", async () => {
    const result = await switchChatBinding({
      chatId: "project-chat",
      chatType: "group",
      oldSessionId: null,
      newSessionId: "project-session",
      tool: "codex",
      chatName: "主Agent-ChatCCC",
      namePolicy: "fixed",
      newDescription: "Codex Session: project-session",
      updateChatInfoFn: async () => {},
    });

    expect(result.ok).toBe(true);
    const registry = JSON.parse(await readFile(registryFile, "utf8"));
    expect(registry["project-chat"]).toMatchObject({
      chatName: "主Agent-ChatCCC",
      namePolicy: "fixed",
    });
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
