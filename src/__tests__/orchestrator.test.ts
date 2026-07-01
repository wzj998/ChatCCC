import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PlatformAdapter } from "../platform-adapter.ts";
import type { SessionInfo, ToolAdapter } from "../adapters/adapter-interface.ts";

const mockStreamStates = new Map<string, { status: "running" | "done" | "stopped"; finalReply: string }>();
const mockGetCodexUsageSummary = vi.hoisted(() => vi.fn());
const mockGetCursorUsageSummary = vi.hoisted(() => vi.fn());
const mockGetChatGptSubscriptionStatus = vi.hoisted(() => vi.fn());

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
} from "../session.ts";
import { activePrompts, resetBindingState } from "../session-chat-binding.ts";
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
    mockStreamStates.clear();
    mockGetCodexUsageSummary.mockReset();
    mockGetCursorUsageSummary.mockReset();
    mockGetChatGptSubscriptionStatus.mockReset();
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

  it("auto-creates a Feishu group for /abd private messages and sends the transformed prompt", async () => {
    const platform = mockPlatform("feishu");
    const prompt = vi.fn(async function* (_sessionId: string, userText: string) {
      yield {
        type: "assistant" as const,
        blocks: [{ type: "text" as const, text: "done" }],
      };
    });
    _setAdapterForToolForTest("claude", {
      displayName: "Claude",
      sessionDescPrefix: "Claude Session:",
      createSession: vi.fn(async () => ({ sessionId: "sid-feishu-abd" })),
      prompt,
      getSessionInfo: async (sessionId: string): Promise<SessionInfo> => ({
        sessionId,
        cwd: "F:\\repo",
      }),
      closeSession: async () => {},
    });

    await handleCommand(platform, "/abd帮我看一下日志", "feishu-p2p", "ou-user", Date.now(), "p2p");

    expect(platform.createGroup).toHaveBeenCalledWith(expect.stringContaining("帮我看一下日志"), ["ou-user"]);
    expect(platform.createGroup).not.toHaveBeenCalledWith(expect.stringContaining("---"), expect.anything());
    const updateCall = vi.mocked(platform.updateChatInfo).mock.calls[0];
    expect(updateCall[1]).not.toContain("---");
    expect(updateCall[1]).not.toContain(ABD_APPEND_PROMPT);
    const userText = prompt.mock.calls[0][1];
    expect(userText).toContain(`[User message]\n帮我看一下日志\n\n---\n${ABD_APPEND_PROMPT}\n[/User message]`);
    expect(userText).not.toContain("/abd");
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
    expect(card.elements[0].text.content).toContain("**周:** 已用 12%，剩余 88%，重置:");
    expect(card.elements[0].text.content).toContain("约 3天18小时17分钟后");
    expect(card.elements[0].text.content).toContain("[██░░░░░░░░░░░░░░░░░░]");
    expect(card.elements[2].actions[0].text.content).toBe("发起重置");
    expect(card.elements[2].actions[0].value).toEqual({ action: "codex_reset_request", availableCount: 2 });
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
      expect.stringContaining("发送 **/usage** 查看 Codex 5h/周用量，以及查询/使用主动重置卡。"),
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
