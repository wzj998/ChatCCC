import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PlatformAdapter } from "../platform-adapter.ts";
import type { SessionInfo, ToolAdapter } from "../adapters/adapter-interface.ts";

const mockStreamStates = new Map<string, { status: "running" | "done" | "stopped"; finalReply: string }>();

vi.mock("../im-skills.ts", () => ({
  buildImSkillsPrompt: async () => "",
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
  recordSessionRegistry,
  resetState,
} from "../session.ts";
import { activePrompts, resetBindingState } from "../session-chat-binding.ts";

function mockPlatform(): PlatformAdapter {
  return {
    kind: "wechat",
    sendText: vi.fn(async () => true),
    sendCard: vi.fn(async () => true),
    sendRawCard: vi.fn(async () => true),
    createGroup: vi.fn(async () => "unused-group"),
    updateChatInfo: vi.fn(async () => {}),
    getChatInfo: vi.fn(async () => ({ name: "微信会话", description: "" })),
    disbandChat: vi.fn(async () => {}),
    setChatAvatar: vi.fn(async () => {}),
    extractSessionInfo: vi.fn(() => null),
    cardCreate: vi.fn(async () => "card-id"),
    cardSend: vi.fn(async () => "message-id"),
    cardUpdate: vi.fn(async () => {}),
  };
}

function mockAdapter(): ToolAdapter {
  return {
    displayName: "Claude",
    sessionDescPrefix: "Claude Session:",
    createSession: async () => ({ sessionId: "sid-wechat" }),
    prompt: async function* () {
      yield {
        type: "assistant",
        blocks: [{ type: "text", text: "done" }],
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

    expect(platform.sendText).not.toHaveBeenCalledWith("wx-chat", "生成中...");
    expect(platform.sendCard).toHaveBeenCalledWith(
      "wx-chat",
      "生成中",
      "该会话正在生成回复中，请等待完成后再发送新消息。如需中断生成，请发送 /stop 指令。",
      "yellow",
    );
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
});
