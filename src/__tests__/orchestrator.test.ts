import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import type { PlatformAdapter } from "../platform-adapter.ts";
import type { SessionInfo, ToolAdapter } from "../adapters/adapter-interface.ts";

const mockStreamStates = new Map<string, { status: "running" | "done" | "stopped"; finalReply: string }>();
const mockGetCodexUsageSummary = vi.hoisted(() => vi.fn());
const mockGetCursorUsageSummary = vi.hoisted(() => vi.fn());
const mockGetChatGptSubscriptionStatus = vi.hoisted(() => vi.fn());
const mockReloadRuntimeConfig = vi.hoisted(() => vi.fn());

vi.mock("../im-skills.ts", () => ({
  buildImSkillsPrompt: async () => "",
  buildImSkillsPromptCached: async () => "",
  exportSkillSubDocs: async () => {},
}));

vi.mock("../stream-state.ts", () => ({
  readStreamState: async (sessionId: string) => {
    const state = mockStreamStates.get(sessionId);
    if (!state) return null;
    return {
      sessionId,
      status: state.status,
      accumulatedContent: "",
      finalReply: state.finalReply,
      chunkCount: 0,
      turnCount: 1,
      contextTokens: 0,
      updatedAt: Date.now(),
      cwd: "F:\\repo",
      tool: "claude",
    };
  },
  writeStreamState: async (state: { sessionId: string; status: "running" | "done" | "stopped"; finalReply: string }) => {
    mockStreamStates.set(state.sessionId, {
      status: state.status,
      finalReply: state.finalReply,
    });
  },
  createEmptyStreamState: (sessionId: string, cwd: string, tool: string, turnCount: number) => ({
    sessionId,
    status: "running" as const,
    accumulatedContent: "",
    finalReply: "",
    chunkCount: 0,
    turnCount,
    contextTokens: 0,
    updatedAt: Date.now(),
    cwd,
    tool,
  }),
  fixStaleStreamStates: async () => {},
}));

vi.mock("../feishu-platform.ts", () => ({
  getCodexUsageSummary: mockGetCodexUsageSummary,
  getTenantAccessToken: vi.fn(async () => "tenant-token"),
  sendPostMessage: vi.fn(async () => true),
}));

vi.mock("../cursor-usage.ts", () => ({
  getCursorUsageSummary: mockGetCursorUsageSummary,
}));

vi.mock("../chatgpt-subscription.ts", () => ({
  getChatGptSubscriptionStatus: mockGetChatGptSubscriptionStatus,
}));

vi.mock("../runtime-reload.ts", () => ({
  reloadRuntimeConfig: mockReloadRuntimeConfig,
}));

import { handleCommand } from "../orchestrator.ts";
import {
  _clearAdapterCacheForTest,
  _resetSessionRegistryFileForTest,
  _resetSessionToolsFileForTest,
  _setAdapterForToolForTest,
  _setSessionRegistryFileForTest,
  _setSessionToolsFileForTest,
  loadSessionRegistryForBinding,
  recordSessionRegistry,
  resetState,
  sessionInfoMap,
  getEffectiveEffortForTool,
  getEffectiveFastModeForTool,
} from "../session.ts";
import {
  activePrompts,
  dequeueMessage,
  getChatsForSession,
  resetBindingState,
} from "../session-chat-binding.ts";
import { ABD_APPEND_PROMPT } from "../shared-prefix.ts";
import { config } from "../config.ts";

function mockPlatform(kind: "wechat" | "feishu" = "wechat"): PlatformAdapter {
  return {
    kind,
    sendText: vi.fn(async () => true),
    sendCard: vi.fn(async () => true),
    sendRawCard: vi.fn(async () => true),
    createGroup: vi.fn(async () => "feishu-group"),
    updateChatInfo: vi.fn(async () => {}),
    getChatInfo: vi.fn(async () => ({ name: kind === "wechat" ? "微信会话" : "飞书会话", description: "" })),
    disbandChat: vi.fn(async () => {}),
    setChatAvatar: vi.fn(async () => {}),
    extractSessionInfo: vi.fn(() => null),
    cardCreate: vi.fn(async () => "card-id"),
    cardSend: vi.fn(async () => "message-id"),
    cardUpdate: vi.fn(async () => {}),
  };
}

function mockAdapter(sessionId = "sid-wechat", promptText = "done"): ToolAdapter {
  return {
    displayName: "Claude",
    sessionDescPrefix: "Claude Session:",
    createSession: vi.fn(async () => ({ sessionId })),
    prompt: async function* () {
      yield {
        type: "assistant",
        blocks: [{ type: "text", text: promptText }],
      };
    },
    getSessionInfo: async (sessionId: string): Promise<SessionInfo> => ({
      sessionId,
      cwd: "F:\\repo",
    }),
    closeSession: async () => {},
  };
}

describe("handleCommand WeChat processing ack", () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    tempDir = await mkdtemp(join(tmpdir(), "chatccc-orchestrator-"));
    _setSessionRegistryFileForTest(join(tempDir, "session-registry.json"));
    _setSessionToolsFileForTest(join(tempDir, "sessions.json"));
    resetState();
    resetBindingState();
    config.claude.defaultAgent = true;
    config.cursor.defaultAgent = false;
    config.codex.defaultAgent = false;
    config.codex.fastMode = false;
    config.ccc.enabled = true;
    config.ccc.defaultAgent = false;
    config.ccc.DEEPSEEK_API_KEY = "sk-test-ccc";
    config.ccc.DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";
    config.ccc.model = "deepseek-v4-pro";
    config.ccc.alternativeModel = "deepseek-v4-flash";
    config.dsh.enabled = true;
    config.dsh.defaultAgent = false;
    config.dsh.apiKey = "sk-test-dsh";
    config.dsh.baseUrl = "https://api.deepseek.com/v1";
    config.dsh.model = "deepseek-v4-flash";
    mockStreamStates.clear();
    mockGetCodexUsageSummary.mockReset();
    mockGetCursorUsageSummary.mockReset();
    mockGetChatGptSubscriptionStatus.mockReset();
    mockReloadRuntimeConfig.mockReset();
    mockGetCodexUsageSummary.mockResolvedValue({
      fiveHour: { usedPercent: 0, remainingPercent: 100, resetAtEpochSeconds: null, resetAfterSeconds: null },
      weekly: { usedPercent: 0, remainingPercent: 100, resetAtEpochSeconds: null, resetAfterSeconds: null },
      rateLimitResetCreditsAvailable: null,
      rateLimitResetCredits: null,
    });
    mockGetCursorUsageSummary.mockResolvedValue({
      billingCycleStart: "1779357999000",
      billingCycleEnd: "1782036399000",
      planUsage: {
        totalSpend: 8159,
        includedSpend: 2000,
        bonusSpend: 6159,
        limit: 2000,
        remainingBonus: false,
        autoPercentUsed: 0,
        apiPercentUsed: 100,
        totalPercentUsed: 100,
      },
      spendLimitUsage: {
        pooledLimit: 48950000,
        pooledUsed: 31808224,
        pooledRemaining: 17141776,
        individualUsed: 101252,
        limitType: "team",
      },
      displayThreshold: 200,
      enabled: true,
      displayMessage: "You've hit your usage limit",
      autoBucketModels: ["default"],
    });
    mockGetChatGptSubscriptionStatus.mockResolvedValue({
      ok: false,
      code: "chrome_cdp_disabled",
      reason: "Chrome CDP guard is disabled in ChatCCC config.",
      chromeCdp: { enabled: false, port: 15166, status: "skipped" },
    });
    mockReloadRuntimeConfig.mockResolvedValue({
      configPath: "C:\\Users\\me\\.chatccc\\config.json",
      defaultAgent: "codex",
      reloadedAt: "2026-07-02T05:00:00.000Z",
    });
    _setAdapterForToolForTest("claude", mockAdapter());
  });

  afterEach(async () => {
    resetState();
    resetBindingState();
    _clearAdapterCacheForTest();
    _resetSessionRegistryFileForTest();
    _resetSessionToolsFileForTest();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("does not send the WeChat processing ack when the session is already running", async () => {
    const platform = mockPlatform();
    await recordSessionRegistry({
      chatId: "wx-chat",
      sessionId: "sid-wechat",
      tool: "claude",
      chatName: "busy-session",
      running: true,
    });
    activePrompts.set("sid-wechat", {
      controller: new AbortController(),
      stopped: false,
      startTime: Date.now(),
    });

    await handleCommand(platform, "继续说明", "wx-chat", "wx-user", Date.now(), "p2p");

    // 不再发"生成中"卡片，改为入队文本通知
    expect(platform.sendText).not.toHaveBeenCalledWith("wx-chat", "生成中...");
    expect(platform.sendText).toHaveBeenCalledWith(
      "wx-chat",
      "当前会话正在生成中，你的消息已进入缓存队列，生成完成后会立即处理。发送 /cancel 可取消缓存。",
    );
    // sendCard 不再被调用（WeChat 用 sendText）
    expect(platform.sendCard).not.toHaveBeenCalled();
  });

  it("sends the WeChat processing ack after the busy check for normal prompts", async () => {
    const platform = mockPlatform();
    await recordSessionRegistry({
      chatId: "wx-chat",
      sessionId: "sid-wechat",
      tool: "claude",
      chatName: "ready-session",
      running: false,
    });

    await handleCommand(platform, "继续说明", "wx-chat", "wx-user", Date.now(), "p2p");

    expect(platform.sendText).toHaveBeenCalledWith("wx-chat", "生成中...");
  });

  it("treats /abd as a shared prompt prefix in an existing session", async () => {
    const platform = mockPlatform();
    const prompt = vi.fn(async function* (_sessionId: string, userText: string) {
      yield {
        type: "assistant" as const,
        blocks: [{ type: "text" as const, text: "done" }],
      };
    });
    _setAdapterForToolForTest("claude", {
      displayName: "Claude",
      sessionDescPrefix: "Claude Session:",
      createSession: vi.fn(async () => ({ sessionId: "sid-wechat" })),
      prompt,
      getSessionInfo: async (sessionId: string): Promise<SessionInfo> => ({
        sessionId,
        cwd: "F:\\repo",
      }),
      closeSession: async () => {},
    });
    await recordSessionRegistry({
      chatId: "wx-chat",
      sessionId: "sid-wechat",
      tool: "claude",
      chatName: "ready-session",
      running: false,
    });

    await handleCommand(platform, "/abd帮我分析", "wx-chat", "wx-user", Date.now(), "p2p");

    expect(platform.sendText).toHaveBeenCalledWith("wx-chat", "生成中...");
    const userText = prompt.mock.calls[0][1];
    expect(userText).toContain(`[User message]\n帮我分析\n\n---\n${ABD_APPEND_PROMPT}\n[/User message]`);
    expect(userText).not.toContain("/abd");
  });

  it("does not send the stopped success text until the running prompt really exits", async () => {
    const platform = mockPlatform();
    await recordSessionRegistry({
      chatId: "wx-chat",
      sessionId: "sid-wechat",
      tool: "claude",
      chatName: "busy-session",
      running: true,
    });
    activePrompts.set("sid-wechat", {
      controller: new AbortController(),
      stopped: false,
      startTime: Date.now(),
    });

    await handleCommand(platform, "/stop", "wx-chat", "wx-user", Date.now(), "p2p");

    expect(platform.sendText).not.toHaveBeenCalledWith("wx-chat", "会话已停止。");
  });

  it("resumes the Feishu p2p session in place instead of creating a group", async () => {
    const platform = mockPlatform("feishu");
    const prompt = vi.fn(async function* (_sessionId: string, userText: string) {
      yield {
        type: "assistant" as const,
        blocks: [{ type: "text" as const, text: `收到: ${userText}` }],
      };
    });
    _setAdapterForToolForTest("claude", {
      displayName: "Claude",
      sessionDescPrefix: "Claude Session:",
      createSession: vi.fn(async () => ({ sessionId: "sid-feishu-new" })),
      prompt,
      getSessionInfo: async (sessionId: string): Promise<SessionInfo> => ({
        sessionId,
        cwd: homedir(),
      }),
      closeSession: async () => {},
    });
    await recordSessionRegistry({
      chatId: "feishu-p2p",
      sessionId: "sid-feishu-private",
      tool: "claude",
      chatType: "p2p",
      chatName: "飞书私聊",
      running: false,
    });

    await handleCommand(platform, "帮我看一下日志", "feishu-p2p", "ou-user", Date.now(), "p2p");

    expect(platform.createGroup).not.toHaveBeenCalled();
    expect(platform.updateChatInfo).not.toHaveBeenCalled();
    expect(prompt).toHaveBeenCalledWith(
      "sid-feishu-private",
      expect.stringContaining("帮我看一下日志"),
      homedir(),
      expect.any(AbortSignal),
      expect.any(Object),
    );

    const registry = await loadSessionRegistryForBinding();
    expect(registry["feishu-p2p"]?.sessionId).toBe("sid-feishu-private");
  });

  it("sends the normal session state card in an established Feishu p2p chat", async () => {
    const platform = mockPlatform("feishu");
    _setAdapterForToolForTest("claude", mockAdapter("sid-feishu-state"));
    await recordSessionRegistry({
      chatId: "feishu-p2p-state",
      sessionId: "sid-feishu-state",
      tool: "claude",
      chatType: "p2p",
      chatName: "飞书私聊",
      turnCount: 2,
      running: false,
    });

    await handleCommand(platform, "/state", "feishu-p2p-state", "ou-user", Date.now(), "p2p");

    expect(platform.getChatInfo).not.toHaveBeenCalled();
    expect(platform.sendRawCard).toHaveBeenCalledTimes(1);
    const cardText = vi.mocked(platform.sendRawCard).mock.calls[0][1];
    expect(cardText).toContain("sid-feishu-state");
    expect(cardText).toContain("Claude Code");
    expect(cardText).toContain("2");
  });

  it("shows an explicit state card without creating an Agent when a Feishu p2p chat is not bound yet", async () => {
    const platform = mockPlatform("feishu");
    const adapter = mockAdapter("should-not-be-created");
    _setAdapterForToolForTest("claude", adapter);

    await handleCommand(platform, "/state", "feishu-p2p-empty", "ou-user", Date.now(), "p2p");

    expect(adapter.createSession).not.toHaveBeenCalled();
    expect(platform.sendRawCard).toHaveBeenCalledTimes(1);
    const cardText = vi.mocked(platform.sendRawCard).mock.calls[0][1];
    expect(cardText).toContain("未建立会话");
    expect(cardText).toContain("Claude Code");
  });

  it("switches an idle Feishu p2p chat to a fresh session when the default Agent changes", async () => {
    const platform = mockPlatform("feishu");
    const oldPrompt = vi.fn(async function* () {
      yield { type: "assistant" as const, blocks: [{ type: "text" as const, text: "old" }] };
    });
    _setAdapterForToolForTest("claude", {
      ...mockAdapter("sid-old-claude"),
      prompt: oldPrompt,
    });

    const createCursorSession = vi.fn(async () => ({ sessionId: "sid-new-cursor" }));
    const cursorPrompt = vi.fn(async function* () {
      yield { type: "assistant" as const, blocks: [{ type: "text" as const, text: "new" }] };
    });
    _setAdapterForToolForTest("cursor", {
      ...mockAdapter("sid-new-cursor"),
      displayName: "Cursor",
      sessionDescPrefix: "Cursor Session:",
      createSession: createCursorSession,
      prompt: cursorPrompt,
      getSessionInfo: async (sessionId: string): Promise<SessionInfo> => ({ sessionId, cwd: homedir() }),
    });
    await recordSessionRegistry({
      chatId: "feishu-p2p",
      sessionId: "sid-old-claude",
      tool: "claude",
      chatType: "p2p",
      chatName: "飞书私聊",
      running: false,
    });

    const originalCursorEnabled = config.cursor.enabled;
    try {
      config.cursor.enabled = true;
      config.claude.defaultAgent = false;
      config.cursor.defaultAgent = true;

      await handleCommand(platform, "/state", "feishu-p2p", "ou-user", Date.now(), "p2p");
      expect(createCursorSession).not.toHaveBeenCalled();
      expect((await loadSessionRegistryForBinding())["feishu-p2p"]?.sessionId).toBe("sid-old-claude");

      await handleCommand(platform, "使用新的默认 Agent", "feishu-p2p", "ou-user", Date.now(), "p2p");

      expect(createCursorSession).toHaveBeenCalledWith(homedir(), expect.any(AbortSignal));
      expect(oldPrompt).not.toHaveBeenCalled();
      expect(cursorPrompt).toHaveBeenCalledWith(
        "sid-new-cursor",
        expect.stringContaining("使用新的默认 Agent"),
        homedir(),
        expect.any(AbortSignal),
        expect.any(Object),
      );
      expect(platform.updateChatInfo).not.toHaveBeenCalled();
      expect(platform.sendCard).toHaveBeenCalledWith(
        "feishu-p2p",
        "默认 Agent 已切换",
        expect.stringContaining("Claude Code → Cursor"),
        "green",
      );

      const registry = await loadSessionRegistryForBinding();
      expect(registry["feishu-p2p"]).toMatchObject({
        sessionId: "sid-new-cursor",
        tool: "cursor",
        chatType: "p2p",
        turnCount: 1,
      });
    } finally {
      config.cursor.enabled = originalCursorEnabled;
    }
  });

  it("waits for a running Feishu p2p Agent before switching the queued message to the new default", async () => {
    const platform = mockPlatform("feishu");
    const createCursorSession = vi.fn(async () => ({ sessionId: "sid-cursor-after-wait" }));
    const cursorPrompt = vi.fn(async function* () {
      yield { type: "assistant" as const, blocks: [{ type: "text" as const, text: "new" }] };
    });
    _setAdapterForToolForTest("cursor", {
      ...mockAdapter("sid-cursor-after-wait"),
      displayName: "Cursor",
      sessionDescPrefix: "Cursor Session:",
      createSession: createCursorSession,
      prompt: cursorPrompt,
      getSessionInfo: async (sessionId: string): Promise<SessionInfo> => ({ sessionId, cwd: homedir() }),
    });
    await recordSessionRegistry({
      chatId: "feishu-p2p-wait",
      sessionId: "sid-running-claude",
      tool: "claude",
      chatType: "p2p",
      chatName: "飞书私聊",
      running: true,
    });
    activePrompts.set("sid-running-claude", {
      controller: new AbortController(),
      stopped: false,
      startTime: Date.now(),
    });

    const originalCursorEnabled = config.cursor.enabled;
    try {
      config.cursor.enabled = true;
      config.claude.defaultAgent = false;
      config.cursor.defaultAgent = true;

      await handleCommand(platform, "等当前回复完成后处理", "feishu-p2p-wait", "ou-user", Date.now(), "p2p");

      expect(createCursorSession).not.toHaveBeenCalled();
      const queued = dequeueMessage("sid-running-claude");
      expect(queued?.text).toContain("等当前回复完成后处理");
      expect(platform.sendCard).toHaveBeenCalledWith(
        "feishu-p2p-wait",
        "Agent 切换等待中",
        expect.stringContaining("完成后会切换到 Cursor"),
        "blue",
      );

      activePrompts.delete("sid-running-claude");
      await handleCommand(
        platform,
        queued!.text,
        queued!.chatId,
        queued!.openId,
        queued!.msgTimestamp,
        queued!.chatType,
        queued!.traceId,
      );

      expect(createCursorSession).toHaveBeenCalledTimes(1);
      expect(cursorPrompt).toHaveBeenCalledWith(
        "sid-cursor-after-wait",
        expect.stringContaining("等当前回复完成后处理"),
        homedir(),
        expect.any(AbortSignal),
        expect.any(Object),
      );
    } finally {
      config.cursor.enabled = originalCursorEnabled;
    }
  });

  it("creates the first Feishu p2p session in the OS user directory and sends the first prompt in place", async () => {
    const platform = mockPlatform("feishu");
    const createSession = vi.fn(async () => ({ sessionId: "sid-feishu-private" }));
    const prompt = vi.fn(async function* (_sessionId: string, userText: string) {
      yield {
        type: "assistant" as const,
        blocks: [{ type: "text" as const, text: `收到: ${userText}` }],
      };
    });
    _setAdapterForToolForTest("claude", {
      displayName: "Claude",
      sessionDescPrefix: "Claude Session:",
      createSession,
      prompt,
      getSessionInfo: async (sessionId: string): Promise<SessionInfo> => ({
        sessionId,
        cwd: homedir(),
      }),
      closeSession: async () => {},
    });

    await handleCommand(platform, "帮我看一下日志", "feishu-p2p", "ou-user", Date.now(), "p2p");

    expect(createSession).toHaveBeenCalledWith(homedir(), expect.any(AbortSignal));
    expect(platform.createGroup).not.toHaveBeenCalled();
    expect(platform.updateChatInfo).not.toHaveBeenCalled();
    expect(prompt).toHaveBeenCalledWith(
      "sid-feishu-private",
      expect.stringContaining("帮我看一下日志"),
      homedir(),
      expect.any(AbortSignal),
      expect.any(Object),
    );

    const registry = await loadSessionRegistryForBinding();
    expect(registry["feishu-p2p"]?.sessionId).toBe("sid-feishu-private");
    expect(registry["feishu-p2p"]?.tool).toBe("claude");
    expect(registry["feishu-p2p"]?.chatType).toBe("p2p");
  });

  it("replaces an unmarked legacy Feishu p2p binding with a home-directory session", async () => {
    const platform = mockPlatform("feishu");
    const createSession = vi.fn(async () => ({ sessionId: "sid-feishu-migrated" }));
    const prompt = vi.fn(async function* () {
      yield {
        type: "assistant" as const,
        blocks: [{ type: "text" as const, text: "done" }],
      };
    });
    _setAdapterForToolForTest("claude", {
      displayName: "Claude",
      sessionDescPrefix: "Claude Session:",
      createSession,
      prompt,
      getSessionInfo: async (sessionId: string): Promise<SessionInfo> => ({
        sessionId,
        cwd: homedir(),
      }),
      closeSession: async () => {},
    });
    await recordSessionRegistry({
      chatId: "feishu-p2p",
      sessionId: "sid-feishu-legacy",
      tool: "claude",
      chatName: "旧私聊绑定",
      running: false,
    });

    await handleCommand(platform, "继续", "feishu-p2p", "ou-user", Date.now(), "p2p");

    expect(createSession).toHaveBeenCalledWith(homedir(), expect.any(AbortSignal));
    expect(prompt).toHaveBeenCalledWith(
      "sid-feishu-migrated",
      expect.stringContaining("继续"),
      homedir(),
      expect.any(AbortSignal),
      expect.any(Object),
    );
    expect(platform.createGroup).not.toHaveBeenCalled();
    const registry = await loadSessionRegistryForBinding();
    expect(registry["feishu-p2p"]?.sessionId).toBe("sid-feishu-migrated");
    expect(registry["feishu-p2p"]?.chatType).toBe("p2p");
  });

  it("creates a Feishu p2p session for /abd and sends the transformed prompt without creating a group", async () => {
    const platform = mockPlatform("feishu");
    const createSession = vi.fn(async () => ({ sessionId: "sid-feishu-abd" }));
    const prompt = vi.fn(async function* (_sessionId: string, userText: string) {
      yield {
        type: "assistant" as const,
        blocks: [{ type: "text" as const, text: "done" }],
      };
    });
    _setAdapterForToolForTest("claude", {
      displayName: "Claude",
      sessionDescPrefix: "Claude Session:",
      createSession,
      prompt,
      getSessionInfo: async (sessionId: string): Promise<SessionInfo> => ({
        sessionId,
        cwd: homedir(),
      }),
      closeSession: async () => {},
    });

    await handleCommand(platform, "/abd帮我看一下日志", "feishu-p2p", "ou-user", Date.now(), "p2p");

    expect(createSession).toHaveBeenCalledWith(homedir(), expect.any(AbortSignal));
    expect(platform.createGroup).not.toHaveBeenCalled();
    expect(platform.updateChatInfo).not.toHaveBeenCalled();
    const userText = prompt.mock.calls[0][1];
    expect(userText).toContain(`[User message]\n帮我看一下日志\n\n---\n${ABD_APPEND_PROMPT}\n[/User message]`);
    expect(userText).not.toContain("/abd");
  });

  it("keeps the Feishu p2p binding when handling commands", async () => {
    const platform = mockPlatform("feishu");
    await recordSessionRegistry({
      chatId: "feishu-p2p",
      sessionId: "sid-feishu-private",
      tool: "claude",
      chatType: "p2p",
      chatName: "飞书私聊",
      running: false,
    });

    await handleCommand(platform, "/model", "feishu-p2p", "ou-user", Date.now(), "p2p");

    expect(platform.createGroup).not.toHaveBeenCalled();
    expect(platform.sendRawCard).toHaveBeenCalled();
    const registry = await loadSessionRegistryForBinding();
    expect(registry["feishu-p2p"]?.sessionId).toBe("sid-feishu-private");
  });

  it("queries and switches Fast mode for the current Codex session", async () => {
    const platform = mockPlatform("feishu");
    await recordSessionRegistry({
      chatId: "feishu-codex",
      sessionId: "sid-codex-fast",
      tool: "codex",
      chatType: "p2p",
      chatName: "Codex",
      running: false,
    });

    await handleCommand(platform, "/fast", "feishu-codex", "ou-user", Date.now(), "p2p");
    let card = JSON.parse(
      vi.mocked(platform.sendRawCard).mock.calls.at(-1)?.[1] ?? "{}",
    ) as { elements?: Array<{ tag: string; text?: { content: string } }> };
    expect(card.elements?.find((element) => element.tag === "div")?.text?.content).toContain("OFF");

    await handleCommand(platform, "/fast on", "feishu-codex", "ou-user", Date.now(), "p2p");
    expect(getEffectiveFastModeForTool("codex", "sid-codex-fast")).toBe(true);
    expect(platform.setChatAvatar).toHaveBeenLastCalledWith(
      "feishu-codex",
      "codex",
      "idle",
      { fastMode: true },
    );

    await handleCommand(platform, "/fast off", "feishu-codex", "ou-user", Date.now(), "p2p");
    expect(getEffectiveFastModeForTool("codex", "sid-codex-fast")).toBe(false);
    expect(platform.setChatAvatar).toHaveBeenLastCalledWith(
      "feishu-codex",
      "codex",
      "idle",
      { fastMode: false },
    );
    card = JSON.parse(
      vi.mocked(platform.sendRawCard).mock.calls.at(-1)?.[1] ?? "{}",
    ) as { elements?: Array<{ tag: string; text?: { content: string } }> };
    expect(card.elements?.find((element) => element.tag === "div")?.text?.content).toContain("OFF");
  });

  it("uses a text fallback for Fast mode commands on WeChat", async () => {
    const platform = mockPlatform("wechat");
    await recordSessionRegistry({
      chatId: "wechat-codex",
      sessionId: "sid-wechat-codex-fast",
      tool: "codex",
      chatType: "p2p",
      chatName: "Codex",
      running: false,
    });

    await handleCommand(platform, "/fast on", "wechat-codex", "wx-user", Date.now(), "p2p");

    expect(getEffectiveFastModeForTool("codex", "sid-wechat-codex-fast")).toBe(true);
    expect(platform.sendText).toHaveBeenCalledWith(
      "wechat-codex",
      expect.stringContaining("ON (Fast)"),
    );
    expect(platform.sendRawCard).not.toHaveBeenCalled();
  });

  it("keeps the Feishu p2p session bound when /new creates a separate group", async () => {
    const platform = mockPlatform("feishu");
    const createSession = vi.fn(async () => ({ sessionId: "sid-feishu-group" }));
    _setAdapterForToolForTest("claude", {
      ...mockAdapter("sid-feishu-group"),
      createSession,
    });
    await recordSessionRegistry({
      chatId: "feishu-p2p",
      sessionId: "sid-feishu-private",
      tool: "claude",
      chatType: "p2p",
      chatName: "飞书私聊",
      running: false,
    });

    await handleCommand(platform, "/new", "feishu-p2p", "ou-user", Date.now(), "p2p");

    expect(platform.createGroup).toHaveBeenCalledWith(expect.any(String), ["ou-user"]);
    const registry = await loadSessionRegistryForBinding();
    expect(registry["feishu-p2p"]?.sessionId).toBe("sid-feishu-private");
    expect(registry["feishu-group"]?.sessionId).toBe("sid-feishu-group");
  });

  it("resets a Feishu p2p session in place with /forget and forces the OS user directory", async () => {
    const platform = mockPlatform("feishu");
    const createSession = vi.fn(async () => ({ sessionId: "sid-feishu-private-reset" }));
    _setAdapterForToolForTest("claude", {
      ...mockAdapter("sid-feishu-private-reset"),
      createSession,
      getSessionInfo: async (sessionId: string): Promise<SessionInfo> => ({
        sessionId,
        cwd: "F:\\some-project",
      }),
    });
    await recordSessionRegistry({
      chatId: "feishu-p2p",
      sessionId: "sid-feishu-private",
      tool: "claude",
      chatType: "p2p",
      chatName: "飞书私聊",
      running: false,
    });

    await handleCommand(platform, "/forget", "feishu-p2p", "ou-user", Date.now(), "p2p");

    expect(createSession).toHaveBeenCalledWith(homedir(), expect.any(AbortSignal));
    expect(platform.createGroup).not.toHaveBeenCalled();
    expect(platform.updateChatInfo).not.toHaveBeenCalled();
    const registry = await loadSessionRegistryForBinding();
    expect(registry["feishu-p2p"]?.sessionId).toBe("sid-feishu-private-reset");
    expect(platform.sendCard).toHaveBeenCalledWith(
      "feishu-p2p",
      "Claude Code Session Reset",
      expect.stringContaining(`${homedir()}\`（飞书私聊固定使用系统用户目录）`),
      "green",
    );
  });

  it("treats the removed /newh alias as a plain message and does not reset the session", async () => {
    const platform = mockPlatform("feishu");
    const createSession = vi.fn(async () => ({ sessionId: "sid-should-not-exist" }));
    _setAdapterForToolForTest("claude", {
      ...mockAdapter("sid-feishu-private"),
      createSession,
      getSessionInfo: async (sessionId: string): Promise<SessionInfo> => ({
        sessionId,
        cwd: "F:\\some-project",
      }),
    });
    await recordSessionRegistry({
      chatId: "feishu-p2p",
      sessionId: "sid-feishu-private",
      tool: "claude",
      chatType: "p2p",
      chatName: "飞书私聊",
      running: false,
    });

    await handleCommand(platform, "/newh", "feishu-p2p", "ou-user", Date.now(), "p2p");

    expect(createSession).not.toHaveBeenCalled();
    const registry = await loadSessionRegistryForBinding();
    expect(registry["feishu-p2p"]?.sessionId).toBe("sid-feishu-private");
  });

  it("does not allow /session to replace the dedicated Feishu p2p session", async () => {
    const platform = mockPlatform("feishu");
    await recordSessionRegistry({
      chatId: "feishu-p2p",
      sessionId: "sid-feishu-private",
      tool: "claude",
      chatType: "p2p",
      chatName: "飞书私聊",
      running: false,
    });

    await handleCommand(platform, "/session 1", "feishu-p2p", "ou-user", Date.now(), "p2p");

    expect(platform.sendCard).toHaveBeenCalledWith(
      "feishu-p2p",
      "/session",
      expect.stringContaining("下一条普通消息时跟随默认 Agent"),
      "yellow",
    );
    expect(platform.updateChatInfo).not.toHaveBeenCalled();
    const registry = await loadSessionRegistryForBinding();
    expect(registry["feishu-p2p"]?.sessionId).toBe("sid-feishu-private");
  });

  it("shows Claude effort switch card in an active Feishu session", async () => {
    const platform = mockPlatform("feishu");
    vi.mocked(platform.getChatInfo).mockResolvedValue({ name: "claude-session", description: "Claude Session: sid-claude-effort" });
    vi.mocked(platform.extractSessionInfo).mockReturnValue({ sessionId: "sid-claude-effort", tool: "claude" });
    await recordSessionRegistry({
      chatId: "feishu-chat",
      sessionId: "sid-claude-effort",
      tool: "claude",
      chatName: "claude-session",
      running: false,
    });
    sessionInfoMap.set("feishu-chat", {
      sessionId: "sid-claude-effort",
      tool: "claude",
      turnCount: 0,
      lastContextTokens: 0,
      startTime: Date.now(),
    });

    await handleCommand(platform, "/effort", "feishu-chat", "ou-user", Date.now(), "group");

    expect(platform.sendRawCard).toHaveBeenCalled();
    const card = JSON.parse(vi.mocked(platform.sendRawCard).mock.calls[0][1]);
    const raw = JSON.stringify(card);
    expect(raw).toContain("/effort low");
    expect(raw).toContain("/effort xhigh");
    expect(raw).toContain("/effort max");
  });

  it("switches Codex effort for the current session and reflects it in /state", async () => {
    const platform = mockPlatform("feishu");
    vi.mocked(platform.getChatInfo).mockResolvedValue({ name: "codex-session", description: "Codex Session: sid-codex-effort" });
    vi.mocked(platform.extractSessionInfo).mockReturnValue({ sessionId: "sid-codex-effort", tool: "codex" });
    _setAdapterForToolForTest("codex", mockAdapter("sid-codex-effort"));
    await recordSessionRegistry({
      chatId: "codex-chat",
      sessionId: "sid-codex-effort",
      tool: "codex",
      chatName: "codex-session",
      running: false,
    });
    sessionInfoMap.set("codex-chat", {
      sessionId: "sid-codex-effort",
      tool: "codex",
      turnCount: 0,
      lastContextTokens: 0,
      startTime: Date.now(),
    });

    await handleCommand(platform, "/effort xhigh", "codex-chat", "ou-user", Date.now(), "group");
    expect(platform.sendCard).toHaveBeenCalledWith(
      "codex-chat",
      "Effort 切换",
      expect.stringContaining("xhigh"),
      "green",
    );

    vi.mocked(platform.sendCard).mockClear();
    vi.mocked(platform.sendRawCard).mockClear();
    await handleCommand(platform, "/state", "codex-chat", "ou-user", Date.now() + 1, "group");

    expect(platform.sendRawCard).toHaveBeenCalled();
    const card = JSON.parse(vi.mocked(platform.sendRawCard).mock.calls[0][1]);
    expect(JSON.stringify(card)).toContain("xhigh");
    expect(getChatsForSession("sid-codex-effort")).toContain("codex-chat");
  });

  it("rejects /effort in Cursor sessions", async () => {
    const platform = mockPlatform("feishu");
    vi.mocked(platform.getChatInfo).mockResolvedValue({ name: "cursor-session", description: "Cursor Session: sid-cursor-effort" });
    vi.mocked(platform.extractSessionInfo).mockReturnValue({ sessionId: "sid-cursor-effort", tool: "cursor" });
    _setAdapterForToolForTest("cursor", mockAdapter("sid-cursor-effort"));
    await recordSessionRegistry({
      chatId: "cursor-chat",
      sessionId: "sid-cursor-effort",
      tool: "cursor",
      chatName: "cursor-session",
      running: false,
    });
    sessionInfoMap.set("cursor-chat", {
      sessionId: "sid-cursor-effort",
      tool: "cursor",
      turnCount: 0,
      lastContextTokens: 0,
      startTime: Date.now(),
    });

    await handleCommand(platform, "/effort high", "cursor-chat", "ou-user", Date.now(), "group");

    expect(platform.sendCard).toHaveBeenCalledWith(
      "cursor-chat",
      "Effort 切换",
      expect.stringContaining("不支持 effort"),
      "red",
    );
  });

  it("switches CCC effort for the current session", async () => {
    const platform = mockPlatform("feishu");
    vi.mocked(platform.getChatInfo).mockResolvedValue({ name: "ccc-session", description: "CCC Session: sid-ccc-effort" });
    vi.mocked(platform.extractSessionInfo).mockReturnValue({ sessionId: "sid-ccc-effort", tool: "ccc" });
    _setAdapterForToolForTest("ccc", mockAdapter("sid-ccc-effort"));
    await recordSessionRegistry({
      chatId: "ccc-chat",
      sessionId: "sid-ccc-effort",
      tool: "ccc",
      chatName: "ccc-session",
      running: false,
    });
    sessionInfoMap.set("ccc-chat", {
      sessionId: "sid-ccc-effort",
      tool: "ccc",
      turnCount: 0,
      lastContextTokens: 0,
      startTime: Date.now(),
    });

    await handleCommand(platform, "/effort max", "ccc-chat", "ou-user", Date.now(), "group");

    expect(platform.sendCard).toHaveBeenCalledWith(
      "ccc-chat",
      "Effort 切换",
      expect.stringContaining("max"),
      "green",
    );

    expect(getEffectiveEffortForTool("ccc", "sid-ccc-effort")).toBe("max");
  });

  it("handles /usage without creating a new Feishu group", async () => {
    const platform = mockPlatform("feishu");
    const usage = {
      fiveHour: { usedPercent: 37, remainingPercent: 63, resetAtEpochSeconds: 1781528212, resetAfterSeconds: 10349 },
      weekly: { usedPercent: 12, remainingPercent: 88, resetAtEpochSeconds: 1781842926, resetAfterSeconds: 325063 },
      rateLimitResetCreditsAvailable: 2,
      rateLimitResetCredits: [
        { grantedAt: "2026-06-12T04:01:47.770016Z", expiresAt: "2026-07-12T04:01:47.770016Z" },
        { grantedAt: "2026-06-18T00:44:23.904386Z", expiresAt: "2026-07-18T00:44:23.904386Z" },
      ],
    };
    mockGetCodexUsageSummary.mockResolvedValue(usage);

    await handleCommand(platform, "/usage", "feishu-p2p", "ou-user", Date.now(), "p2p");

    expect(platform.createGroup).not.toHaveBeenCalled();
    expect(platform.sendCard).not.toHaveBeenCalled();
    expect(platform.sendRawCard).toHaveBeenCalledTimes(1);
    const card = JSON.parse(vi.mocked(platform.sendRawCard).mock.calls[0][1]);
    expect(card.header.title.content).toBe("Codex Usage");
    expect(card.elements[0].text.content).toContain("2026-07-12");
    expect(card.elements[0].text.content).toContain("2026-07-18");
    expect(card.elements[0].text.content).toContain("**主动重置:** 剩余 2 次");
    expect(card.elements[0].text.content).not.toContain("ChatGPT 订阅");
    expect(card.elements[0].text.content).toContain("**5h:** 已用 37%，剩余 63%，重置:");
    expect(card.elements[0].text.content).toContain("约 2小时52分钟后");
    expect(card.elements[0].text.content).toContain("[███████░░░░░░░░░░░░░]");
    expect(card.elements[0].text.content).toContain("**7天:** 已用 12%，剩余 88%，重置:");
    expect(card.elements[0].text.content).toContain("约 3天18小时17分钟后");
    expect(card.elements[0].text.content).toContain("[██░░░░░░░░░░░░░░░░░░]");
    expect(card.elements[2].actions[0].text.content).toBe("发起重置");
    expect(card.elements[2].actions[0].value).toEqual({ action: "codex_reset_request", availableCount: 2 });
    expect(platform.setChatAvatar).toHaveBeenCalledWith("feishu-p2p", "codex", "idle", { codexUsage: usage });
  });

  it("shows only the 7-day window when the 5h window is absent", async () => {
    const platform = mockPlatform("feishu");
    const usage = {
      fiveHour: null,
      weekly: {
        usedPercent: 23,
        remainingPercent: 77,
        resetAtEpochSeconds: 1784510226,
        resetAfterSeconds: 500000,
        limitWindowSeconds: 604800,
      },
      rateLimitResetCreditsAvailable: 0,
      rateLimitResetCredits: [],
    };
    mockGetCodexUsageSummary.mockResolvedValue(usage);

    await handleCommand(platform, "/usage", "feishu-p2p", "ou-user", Date.now(), "p2p");

    const card = JSON.parse(vi.mocked(platform.sendRawCard).mock.calls[0][1]);
    const content = card.elements[0].text.content as string;
    expect(content).not.toContain("**5h:**");
    expect(content).toContain("**7天:** 已用 23%，剩余 77%，重置:");
    expect(platform.setChatAvatar).toHaveBeenCalledWith("feishu-p2p", "codex", "idle", { codexUsage: usage });
  });

  it("adds ChatGPT subscription expiry to Codex /usage when CDP lookup succeeds", async () => {
    const platform = mockPlatform("feishu");
    mockGetCodexUsageSummary.mockResolvedValue({
      fiveHour: { usedPercent: 37, remainingPercent: 63, resetAtEpochSeconds: 1781528212, resetAfterSeconds: 10349 },
      weekly: { usedPercent: 12, remainingPercent: 88, resetAtEpochSeconds: 1781842926, resetAfterSeconds: 325063 },
      rateLimitResetCreditsAvailable: 0,
      rateLimitResetCredits: [],
    });
    mockGetChatGptSubscriptionStatus.mockResolvedValue({
      ok: true,
      code: "ok",
      chromeCdp: { enabled: true, port: 15166, status: "healthy" },
      chatgpt: { sessionOk: true, maskedEmail: "gg***@gmail.com", sessionExpiresAt: "2026-09-20T09:30:07.340Z" },
      subscription: {
        active: true,
        plan: "chatgptprolite",
        expiresAt: "2026-07-12T10:20:11+00:00",
        willRenew: false,
        purchaseOriginPlatform: "chatgpt_web",
        remainingDays: 20,
      },
    });

    await handleCommand(platform, "/usage", "feishu-p2p", "ou-user", Date.now(), "p2p");

    const card = JSON.parse(vi.mocked(platform.sendRawCard).mock.calls[0][1]);
    expect(card.elements[0].text.content).toContain("**ChatGPT 订阅:**");
    expect(card.elements[0].text.content).toContain("- 套餐: chatgptprolite");
    expect(card.elements[0].text.content).toContain("剩余 20 天");
    expect(card.elements[0].text.content).toContain("- 自动续费: 否");
  });

  it("shows an actionable ChatGPT subscription failure reason when Chrome CDP is enabled", async () => {
    const platform = mockPlatform("feishu");
    mockGetChatGptSubscriptionStatus.mockResolvedValue({
      ok: false,
      code: "chatgpt_session_missing",
      reason: "ChatGPT browser session has no access token.",
      chromeCdp: { enabled: true, port: 15166, status: "healthy" },
      chatgpt: { sessionOk: true },
    });

    await handleCommand(platform, "/usage", "feishu-p2p", "ou-user", Date.now(), "p2p");

    const card = JSON.parse(vi.mocked(platform.sendRawCard).mock.calls[0][1]);
    expect(card.elements[0].text.content).toContain("**ChatGPT 订阅查询失败:**");
    expect(card.elements[0].text.content).toContain("请在 15166 端口对应的 Chrome 浏览器中登录 ChatGPT");
    expect(card.elements[0].text.content).toContain("ChatGPT browser session has no access token.");
  });

  it("handles /usage as Cursor usage in Cursor chats", async () => {
    const platform = mockPlatform("feishu");
    await recordSessionRegistry({
      chatId: "cursor-chat",
      sessionId: "sid-cursor",
      tool: "cursor",
      chatName: "cursor-session",
      running: false,
    });

    await handleCommand(platform, "/usage", "cursor-chat", "ou-user", Date.now(), "group");

    expect(platform.createGroup).not.toHaveBeenCalled();
    expect(mockGetCodexUsageSummary).not.toHaveBeenCalled();
    expect(mockGetCursorUsageSummary).toHaveBeenCalled();
    expect(platform.sendCard).toHaveBeenCalledWith(
      "cursor-chat",
      "Cursor Usage",
      expect.stringContaining("Individual used: $1012.52"),
      "blue",
    );
    expect(platform.sendCard).toHaveBeenCalledWith(
      "cursor-chat",
      "Cursor Usage",
      expect.stringContaining("Pool remaining: $171417.76"),
      "blue",
    );
    expect(platform.setChatAvatar).toHaveBeenCalledWith(
      "cursor-chat",
      "cursor",
      "idle",
      { cursorUsage: expect.objectContaining({ displayMessage: "You've hit your usage limit" }) },
    );
  });

  it("keeps the busy avatar status when /usage runs for an active Cursor session", async () => {
    const platform = mockPlatform("feishu");
    await recordSessionRegistry({
      chatId: "cursor-chat",
      sessionId: "sid-cursor",
      tool: "cursor",
      chatName: "cursor-session",
      running: true,
    });
    activePrompts.set("sid-cursor", {
      controller: new AbortController(),
      stopped: false,
      startTime: Date.now(),
    });

    await handleCommand(platform, "/usage", "cursor-chat", "ou-user", Date.now(), "group");

    expect(platform.setChatAvatar).toHaveBeenCalledWith(
      "cursor-chat",
      "cursor",
      "busy",
      { cursorUsage: expect.objectContaining({ displayMessage: "You've hit your usage limit" }) },
    );
  });

  it("advertises /usage in new Codex and Cursor session ready messages", async () => {
    const codexPlatform = mockPlatform("feishu");
    _setAdapterForToolForTest("codex", mockAdapter("sid-codex"));

    await handleCommand(codexPlatform, "/new codex", "feishu-p2p", "ou-user", Date.now(), "p2p");

    expect(codexPlatform.sendCard).toHaveBeenCalledWith(
      "feishu-group",
      "Codex Session Ready",
      expect.stringContaining("发送 **/usage** 查看 Codex 实际存在的 5h/7天用量窗口，以及查询/使用主动重置卡。"),
      "green",
    );

    const codexReadyCall = vi.mocked(codexPlatform.sendCard).mock.calls.find(
      ([chatId, title]) => chatId === "feishu-group" && title === "Codex Session Ready",
    );
    const modelHelpIndex = codexReadyCall?.[2].indexOf("/model") ?? -1;
    const fastHelpIndex = codexReadyCall?.[2].indexOf("/fast") ?? -1;
    expect(modelHelpIndex).toBeGreaterThanOrEqual(0);
    expect(fastHelpIndex).toBeGreaterThan(modelHelpIndex);

    const cursorPlatform = mockPlatform("feishu");
    _setAdapterForToolForTest("cursor", mockAdapter("sid-cursor"));

    await handleCommand(cursorPlatform, "/new cursor", "feishu-p2p-cursor", "ou-user", Date.now(), "p2p");

    const cursorReadyCall = vi.mocked(cursorPlatform.sendCard).mock.calls.find(
      ([chatId, title]) => chatId === "feishu-group" && title === "Cursor Session Ready",
    );
    expect(cursorReadyCall?.[2]).toContain("/usage");

    const claudePlatform = mockPlatform("feishu");
    await handleCommand(claudePlatform, "/new claude", "feishu-p2p-2", "ou-user", Date.now(), "p2p");

    const claudeReadyCall = vi.mocked(claudePlatform.sendCard).mock.calls.find(
      ([chatId, title]) => chatId === "feishu-group" && title === "Claude Code Session Ready",
    );
    expect(claudeReadyCall?.[2]).not.toContain("/usage");
  });

  it("handles /usage as DeepSeek balance in CCC Agent chats", async () => {
    const platform = mockPlatform("feishu");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      is_available: true,
      balance_infos: [{
        currency: "CNY",
        total_balance: "12.34",
        topped_up_balance: "10.00",
        granted_balance: "2.34",
      }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await recordSessionRegistry({
      chatId: "ccc-chat",
      sessionId: "sid-ccc",
      tool: "ccc",
      chatName: "ccc-session",
      running: false,
    });

    await handleCommand(platform, "/usage", "ccc-chat", "ou-user", Date.now(), "group");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.deepseek.com/user/balance",
      expect.objectContaining({ headers: { Authorization: "Bearer sk-test-ccc" } }),
    );
    expect(platform.sendCard).toHaveBeenCalledWith(
      "ccc-chat",
      "CCC Usage",
      expect.stringContaining("总余额: 12.34"),
      "blue",
    );
  });

  it("does not query balance for a non-official CCC API endpoint", async () => {
    const platform = mockPlatform("feishu");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    config.ccc.DEEPSEEK_BASE_URL = "https://deepseek-proxy.example.com/v1";
    await recordSessionRegistry({
      chatId: "ccc-proxy-chat",
      sessionId: "sid-ccc-proxy",
      tool: "ccc",
      chatName: "ccc-proxy-session",
      running: false,
    });

    await handleCommand(platform, "/usage", "ccc-proxy-chat", "ou-user", Date.now(), "group");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(platform.sendCard).toHaveBeenCalledWith(
      "ccc-proxy-chat",
      "CCC Usage",
      expect.stringContaining("仅支持官方 DeepSeek API"),
      "blue",
    );
  });

  it("handles /usage as DeepSeek balance in DSH chats", async () => {
    const platform = mockPlatform("feishu");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      is_available: true,
      balance_infos: [{ currency: "CNY", total_balance: "8.88", topped_up_balance: "8.88", granted_balance: "0.00" }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await recordSessionRegistry({
      chatId: "dsh-chat",
      sessionId: "dsh-session-1",
      tool: "dsh",
      chatName: "dsh-session",
      running: false,
    });

    await handleCommand(platform, "/usage", "dsh-chat", "ou-user", Date.now(), "group");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.deepseek.com/user/balance",
      expect.objectContaining({ headers: { Authorization: "Bearer sk-test-dsh" } }),
    );
    expect(platform.sendCard).toHaveBeenCalledWith(
      "dsh-chat",
      "DeepSeek Harness Usage",
      expect.stringContaining("8.88"),
      "blue",
    );
    expect(mockGetCodexUsageSummary).not.toHaveBeenCalled();
  });

  it("does not query balance for a non-official DSH API endpoint", async () => {
    const platform = mockPlatform("feishu");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    config.dsh.baseUrl = "https://deepseek-proxy.example.com/v1";
    await recordSessionRegistry({
      chatId: "dsh-proxy-chat",
      sessionId: "dsh-session-proxy",
      tool: "dsh",
      chatName: "dsh-proxy-session",
      running: false,
    });

    await handleCommand(platform, "/usage", "dsh-proxy-chat", "ou-user", Date.now(), "group");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(platform.sendCard).toHaveBeenCalledWith(
      "dsh-proxy-chat",
      "DeepSeek Harness Usage",
      expect.stringContaining("api.deepseek.com"),
      "blue",
    );
  });

  it("reloads runtime config for the exact /reload command", async () => {
    const platform = mockPlatform("feishu");

    await handleCommand(platform, "/reload", "feishu-chat", "open-1", Date.now(), "group");

    expect(mockReloadRuntimeConfig).toHaveBeenCalledWith("chat-command");
    expect(platform.sendText).toHaveBeenCalledWith(
      "feishu-chat",
      expect.stringContaining("配置已重新加载"),
    );
    expect(platform.sendText).toHaveBeenCalledWith(
      "feishu-chat",
      expect.stringContaining("默认 Agent: Codex"),
    );
  });

  it("allows and advertises the /new ccc entry", async () => {
    const platform = mockPlatform("feishu");
    _setAdapterForToolForTest("ccc", mockAdapter("session-20260702-121530-a1b2c3"));

    await handleCommand(platform, "/new ccc", "feishu-p2p-ccc", "ou-user", Date.now(), "p2p");

    expect(platform.updateChatInfo).toHaveBeenCalledWith(
      "feishu-group",
      expect.any(String),
      "CCC Session: session-20260702-121530-a1b2c3",
    );
    expect(platform.sendCard).toHaveBeenCalledWith(
      "feishu-group",
      "CCC Agent Session Ready",
      expect.stringContaining("CCC Agent"),
      "green",
    );

    const helpPlatform = mockPlatform("feishu");
    await handleCommand(helpPlatform, "hello", "feishu-group-help", "ou-user", Date.now(), "group");
    const helpCard = vi.mocked(helpPlatform.sendRawCard).mock.calls.at(-1)?.[1] as string;
    expect(helpCard).toContain("/new ccc");
    expect(helpCard).toContain("CCC Agent");
  });

  it("shows the CCC model list when CCC Agent is the unbound default", async () => {
    const platform = mockPlatform("feishu");
    config.claude.defaultAgent = false;
    config.cursor.defaultAgent = false;
    config.codex.defaultAgent = false;
    config.ccc.defaultAgent = true;

    await handleCommand(platform, "/model", "feishu-p2p-ccc-model", "ou-user", Date.now(), "p2p");

    const card = vi.mocked(platform.sendRawCard).mock.calls.at(-1)?.[1] as string;
    expect(card).toContain("deepseek-v4-pro");
    expect(card).toContain("deepseek-v4-flash");
  });
});
