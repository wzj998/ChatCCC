import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PlatformAdapter } from "../platform-adapter.ts";
import type { SessionInfo, ToolAdapter } from "../adapters/adapter-interface.ts";

const mockStreamStates = new Map<string, { status: "running" | "done" | "stopped"; finalReply: string }>();

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
});
