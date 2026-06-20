import { Readable } from "node:stream";
import { describe, expect, it, vi, beforeEach } from "vitest";

import type { PlatformAdapter } from "../platform-adapter.ts";

const mockDelegateAgentTask = vi.hoisted(() => vi.fn());

vi.mock("../agent-delegate-task.ts", () => ({
  delegateAgentTask: mockDelegateAgentTask,
}));

import {
  AGENT_DELEGATE_TASK_PATH,
  buildAgentDelegateTaskCapabilityPrompt,
  handleAgentDelegateTaskRequest,
} from "../agent-delegate-task-rpc.ts";
import { ABD_APPEND_PROMPT } from "../shared-prefix.ts";

function request(body: unknown, path = AGENT_DELEGATE_TASK_PATH, method = "POST"): Readable & {
  url?: string;
  method?: string;
  headers: Record<string, string>;
} {
  const req = Readable.from([Buffer.from(JSON.stringify(body), "utf8")]) as Readable & {
    url?: string;
    method?: string;
    headers: Record<string, string>;
  };
  req.url = path;
  req.method = method;
  req.headers = { "content-type": "application/json; charset=utf-8" };
  return req;
}

function response() {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: "",
    writeHead(status: number, headers: Record<string, string>) {
      this.statusCode = status;
      this.headers = headers;
      return this;
    },
    end(chunk?: string) {
      this.body += chunk ?? "";
      return this;
    },
  };
  return res;
}

function platform(kind: "feishu" | "wechat" = "feishu"): PlatformAdapter {
  return {
    kind,
    sendText: vi.fn(async () => true),
    sendCard: vi.fn(async () => true),
    sendRawCard: vi.fn(async () => true),
    createGroup: vi.fn(async () => "chat-id"),
    updateChatInfo: vi.fn(async () => {}),
    getChatInfo: vi.fn(async () => ({ name: "chat", description: "" })),
    disbandChat: vi.fn(async () => {}),
    setChatAvatar: vi.fn(async () => {}),
    extractSessionInfo: vi.fn(() => null),
    cardCreate: vi.fn(async () => "card-id"),
    cardSend: vi.fn(async () => "message-id"),
    cardUpdate: vi.fn(async () => {}),
  };
}

describe("agent delegate task RPC", () => {
  beforeEach(() => {
    mockDelegateAgentTask.mockReset();
    mockDelegateAgentTask.mockResolvedValue({
      chatId: "chat-new",
      sessionId: "sid-new",
      tool: "codex",
      cwd: "F:\\repo",
    });
  });

  it("delegates a task through the local API", async () => {
    const req = request({
      tool: "codex",
      cwd: "F:\\repo",
      open_id: "ou-user",
      prompt: "帮我分析日志",
    });
    const res = response();

    await handleAgentDelegateTaskRequest(req as never, res as never, platform());

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      ok: true,
      chat_id: "chat-new",
      session_id: "sid-new",
      tool: "codex",
    });
    expect(mockDelegateAgentTask).toHaveBeenCalledWith(expect.objectContaining({
      tool: "codex",
      cwd: expect.stringContaining("repo"),
      promptText: "帮我分析日志",
      openIds: ["ou-user"],
      chatNamePrefix: "帮我分析日志",
    }));
  });

  it("applies the shared ABD prefix to API prompts", async () => {
    const req = request({
      tool: "claude",
      cwd: "F:\\repo",
      openIds: ["ou-user"],
      prompt: "/abd帮我分析",
    });
    const res = response();

    await handleAgentDelegateTaskRequest(req as never, res as never, platform());

    expect(res.statusCode).toBe(200);
    expect(mockDelegateAgentTask).toHaveBeenCalledWith(expect.objectContaining({
      promptText: `帮我分析\n\n---\n${ABD_APPEND_PROMPT}`,
      chatNamePrefix: "帮我分析",
    }));
  });

  it("rejects non-Feishu platforms", async () => {
    const req = request({
      tool: "codex",
      cwd: "F:\\repo",
      open_id: "ou-user",
      prompt: "task",
    });
    const res = response();

    await handleAgentDelegateTaskRequest(req as never, res as never, platform("wechat"));

    expect(res.statusCode).toBe(409);
    expect(mockDelegateAgentTask).not.toHaveBeenCalled();
  });

  it("rejects missing required parameters", async () => {
    const req = request({ tool: "codex", cwd: "F:\\repo", prompt: "task" });
    const res = response();

    await handleAgentDelegateTaskRequest(req as never, res as never, platform());

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("open_id");
    expect(mockDelegateAgentTask).not.toHaveBeenCalled();
  });

  it("builds prompt instructions for the delegate endpoint", () => {
    const prompt = buildAgentDelegateTaskCapabilityPrompt({
      url: `http://127.0.0.1:18080${AGENT_DELEGATE_TASK_PATH}`,
      cwd: "F:/repo",
    });

    expect(prompt).toContain("POST http://127.0.0.1:18080/api/agent/delegate-task");
    expect(prompt).toContain('"tool":"codex|claude|cursor"');
    expect(prompt).toContain('"cwd":"absolute working directory"');
    expect(prompt).toContain("project prompt injection and IM skills still apply");
    expect(prompt).toContain("Current working directory: F:/repo");
  });
});
