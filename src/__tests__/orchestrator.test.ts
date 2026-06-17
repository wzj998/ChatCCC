import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PlatformAdapter } from "../platform-adapter.ts";
import type { SessionInfo, ToolAdapter } from "../adapters/adapter-interface.ts";

const mockStreamStates = new Map<string, { status: "running" | "done" | "stopped"; finalReply: string }>();
const mockGetCodexUsageSummary = vi.hoisted(() => vi.fn());
const mockGetCursorUsageSummary = vi.hoisted(() => vi.fn());

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
} from "../session.ts";
import { activePrompts, resetBindingState } from "../session-chat-binding.ts";

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
    mockStreamStates.clear();
    mockGetCodexUsageSummary.mockReset();
    mockGetCursorUsageSummary.mockReset();
    mockGetCodexUsageSummary.mockResolvedValue({
      fiveHour: { usedPercent: 0, remainingPercent: 100, resetAtEpochSeconds: null, resetAfterSeconds: null },
      weekly: { usedPercent: 0, remainingPercent: 100, resetAtEpochSeconds: null, resetAfterSeconds: null },
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
    _setAdapterForToolForTest("claude", mockAdapter());
  });

  afterEach(async () => {
    resetState();
    resetBindingState();
    _clearAdapterCacheForTest();
    _resetSessionRegistryFileForTest();
    _resetSessionToolsFileForTest();
    vi.useRealTimers();
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

  it("cleans stale Feishu p2p binding, creates a group, and sends the private message as first prompt", async () => {
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
        cwd: "F:\\repo",
      }),
      closeSession: async () => {},
    });
    await recordSessionRegistry({
      chatId: "feishu-p2p",
      sessionId: "stale-sid",
      tool: "claude",
      chatName: "旧私聊绑定",
      running: false,
    });

    await handleCommand(platform, "帮我看一下日志", "feishu-p2p", "ou-user", Date.now(), "p2p");

    expect(platform.createGroup).toHaveBeenCalledWith(expect.stringContaining("帮我看一下日志"), ["ou-user"]);
    expect(platform.updateChatInfo).toHaveBeenCalledWith(
      "feishu-group",
      expect.stringContaining("帮我看一下日志"),
      expect.stringContaining("sid-feishu-new"),
    );
    expect(prompt).toHaveBeenCalledWith(
      "sid-feishu-new",
      expect.stringContaining("帮我看一下日志"),
      "F:\\repo",
      expect.any(AbortSignal),
      expect.any(Object),
    );

    const registry = await loadSessionRegistryForBinding();
    expect(registry["feishu-p2p"]).toBeUndefined();
    expect(registry["feishu-group"]?.sessionId).toBe("sid-feishu-new");
  });

  it("cleans stale Feishu p2p binding but keeps valid commands from auto-creating a group", async () => {
    const platform = mockPlatform("feishu");
    await recordSessionRegistry({
      chatId: "feishu-p2p",
      sessionId: "stale-sid",
      tool: "claude",
      chatName: "旧私聊绑定",
      running: false,
    });

    await handleCommand(platform, "/model", "feishu-p2p", "ou-user", Date.now(), "p2p");

    expect(platform.createGroup).not.toHaveBeenCalled();
    expect(platform.sendRawCard).toHaveBeenCalled();
    const registry = await loadSessionRegistryForBinding();
    expect(registry["feishu-p2p"]).toBeUndefined();
  });

  it("handles /usage without creating a new Feishu group", async () => {
    const platform = mockPlatform("feishu");
    mockGetCodexUsageSummary.mockResolvedValue({
      fiveHour: { usedPercent: 37, remainingPercent: 63, resetAtEpochSeconds: 1781528212, resetAfterSeconds: 10349 },
      weekly: { usedPercent: 12, remainingPercent: 88, resetAtEpochSeconds: 1781842926, resetAfterSeconds: 325063 },
    });

    await handleCommand(platform, "/usage", "feishu-p2p", "ou-user", Date.now(), "p2p");

    expect(platform.createGroup).not.toHaveBeenCalled();
    expect(platform.sendCard).toHaveBeenCalledWith(
      "feishu-p2p",
      "Codex Usage",
      expect.stringContaining("**5h:** 已用 37%，剩余 63%，重置:"),
      "blue",
    );
    expect(platform.sendCard).toHaveBeenCalledWith(
      "feishu-p2p",
      "Codex Usage",
      expect.stringContaining("约 2小时52分钟后"),
      "blue",
    );
    expect(platform.sendCard).toHaveBeenCalledWith(
      "feishu-p2p",
      "Codex Usage",
      expect.stringContaining("[███████░░░░░░░░░░░░░]"),
      "blue",
    );
    expect(platform.sendCard).toHaveBeenCalledWith(
      "feishu-p2p",
      "Codex Usage",
      expect.stringContaining("**周:** 已用 12%，剩余 88%，重置:"),
      "blue",
    );
    expect(platform.sendCard).toHaveBeenCalledWith(
      "feishu-p2p",
      "Codex Usage",
      expect.stringContaining("约 3天18小时17分钟后"),
      "blue",
    );
    expect(platform.sendCard).toHaveBeenCalledWith(
      "feishu-p2p",
      "Codex Usage",
      expect.stringContaining("[██░░░░░░░░░░░░░░░░░░]"),
      "blue",
    );
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
  });

  it("advertises /usage in new Codex and Cursor session ready messages", async () => {
    const codexPlatform = mockPlatform("feishu");
    _setAdapterForToolForTest("codex", mockAdapter("sid-codex"));

    await handleCommand(codexPlatform, "/new codex", "feishu-p2p", "ou-user", Date.now(), "p2p");

    expect(codexPlatform.sendCard).toHaveBeenCalledWith(
      "feishu-group",
      "Codex Session Ready",
      expect.stringContaining("发送 **/usage** 查看 Codex 5h 和周用量。"),
      "green",
    );

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
});
