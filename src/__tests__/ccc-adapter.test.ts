import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const streamTextMock = vi.fn();
const generateTextMock = vi.fn();

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: vi.fn(() => (modelId: string) => ({ modelId })),
}));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: vi.fn(() => (modelId: string) => ({ modelId })),
}));

vi.mock("ai", () => ({
  streamText: streamTextMock,
  generateText: generateTextMock,
  isLoopFinished: vi.fn(() => ({ loopFinished: true })),
  stepCountIs: vi.fn((count: number) => ({ count })),
  jsonSchema: vi.fn((schema: unknown) => schema),
  tool: vi.fn((definition: unknown) => definition),
}));

async function* textStream(...chunks: string[]): AsyncIterable<string> {
  for (const chunk of chunks) yield chunk;
}

async function* fullStream(...parts: unknown[]): AsyncIterable<unknown> {
  for (const part of parts) yield part;
}

afterEach(() => {
  streamTextMock.mockReset();
  generateTextMock.mockReset();
});

describe("createCccAdapter", () => {
  it("disables response-stall detection when DeepCCC streaming is disabled", async () => {
    const { config: deepCccConfig } = await import("../../deepccc-agent/src/config.ts");
    const previousStreaming = deepCccConfig.streaming;
    deepCccConfig.streaming = false;

    try {
      const { createCccAdapter } = await import("../adapters/ccc-adapter.ts");
      const adapter = createCccAdapter({ apiKey: "sk-test" });

      expect(adapter.responseStallDetectionEnabled).toBe(false);
    } finally {
      deepCccConfig.streaming = previousStreaming;
    }
  });

  it("creates a persisted ccc session and exposes model/cwd metadata", async () => {
    const { createCccAdapter } = await import("../adapters/ccc-adapter.ts");
    const contextDir = await mkdtemp(join(tmpdir(), "chatccc-ccc-adapter-meta-"));
    const adapter = createCccAdapter({
      apiKey: "sk-test",
      provider: "openai",
      contextDir,
      model: "deepseek-v4-pro",
    });

    const created = await adapter.createSession("F:\\repo");
    const info = await adapter.getSessionInfo(created.sessionId);

    expect(created.sessionId).toMatch(/^session-\d{8}-\d{6}-[a-f0-9]{6}$/);
    expect(info).toEqual(expect.objectContaining({
      sessionId: created.sessionId,
      cwd: "F:\\repo",
      model: "deepseek-v4-pro",
    }));
  });

  it("maps ChatSession text chunks to unified assistant text blocks", async () => {
    const { createCccAdapter } = await import("../adapters/ccc-adapter.ts");
    const contextDir = await mkdtemp(join(tmpdir(), "chatccc-ccc-adapter-stream-"));
    const adapter = createCccAdapter({
      apiKey: "sk-test",
      provider: "openai",
      contextDir,
      model: "deepseek-v4-flash",
    });
    const { sessionId } = await adapter.createSession("F:\\repo");
    streamTextMock.mockReturnValueOnce({ textStream: textStream("hello", " world") });

    const messages = [];
    for await (const message of adapter.prompt(sessionId, "hi", "F:\\repo")) {
      messages.push(message);
    }

    expect(messages).toEqual([
      { type: "assistant", blocks: [{ type: "agent_status", status: "responding" }] },
      { type: "assistant", blocks: [{ type: "text", text: "hello" }] },
      { type: "assistant", blocks: [{ type: "text", text: " world" }] },
      { type: "assistant", blocks: [], isFinalResponse: true },
    ]);
    expect(streamTextMock).toHaveBeenCalledWith(expect.objectContaining({
      model: { modelId: "deepseek-v4-flash" },
    }));
  });

  it("maps ChatSession tool events to unified tool blocks", async () => {
    const { createCccAdapter } = await import("../adapters/ccc-adapter.ts");
    const contextDir = await mkdtemp(join(tmpdir(), "chatccc-ccc-adapter-tools-"));
    const adapter = createCccAdapter({
      apiKey: "sk-test",
      provider: "openai",
      contextDir,
      model: "deepseek-v4-flash",
    });
    const { sessionId } = await adapter.createSession("F:\\repo");
    streamTextMock.mockReturnValueOnce({
      fullStream: fullStream(
        { type: "tool-call", toolCallId: "call-1", toolName: "read_file", input: { path: "README.md" } },
        { type: "tool-result", toolCallId: "call-1", toolName: "read_file", output: { content: "hello" } },
      ),
    });

    const messages = [];
    for await (const message of adapter.prompt(sessionId, "read", "F:\\repo")) {
      messages.push(message);
    }

    expect(messages).toEqual([
      { type: "assistant", blocks: [{ type: "agent_status", status: "responding" }] },
      {
        type: "assistant",
        blocks: [{ type: "tool_use", id: "call-1", name: "read_file", input: { path: "README.md" } }],
      },
      {
        type: "assistant",
        blocks: [{ type: "tool_result", tool_use_id: "call-1", content: { content: "hello" }, is_error: false }],
      },
      { type: "assistant", blocks: [], isFinalResponse: true },
    ]);
  });

  it("maps DeepCCC reasoning heartbeats without exposing reasoning text", async () => {
    const { createCccAdapter } = await import("../adapters/ccc-adapter.ts");
    const contextDir = await mkdtemp(join(tmpdir(), "chatccc-ccc-adapter-reasoning-"));
    const adapter = createCccAdapter({ apiKey: "sk-test", provider: "openai", contextDir });
    const { sessionId } = await adapter.createSession("F:\\repo");
    streamTextMock.mockReturnValueOnce({
      fullStream: fullStream(
        { type: "reasoning-delta", text: "private chain of thought" },
        { type: "text-delta", text: "answer" },
      ),
    });

    const messages = [];
    for await (const message of adapter.prompt(sessionId, "think", "F:\\repo")) messages.push(message);

    expect(messages).toContainEqual({
      type: "assistant",
      blocks: [{ type: "agent_progress", phase: "reasoning" }],
    });
    expect(JSON.stringify(messages)).not.toContain("private chain of thought");
  });

  it("maps DeepCCC compaction and generation phases to unified activity blocks", async () => {
    const { createCccAdapter } = await import("../adapters/ccc-adapter.ts");
    const contextDir = await mkdtemp(join(tmpdir(), "chatccc-ccc-adapter-status-"));
    const adapter = createCccAdapter({
      apiKey: "sk-test",
      provider: "openai",
      contextDir,
      compactAtTokens: 1,
      keepRecentMessages: 1,
    });
    const { sessionId } = await adapter.createSession("F:\\repo");
    streamTextMock.mockReturnValueOnce({ textStream: textStream("old") });
    for await (const _message of adapter.prompt(sessionId, "old question", "F:\\repo")) {
      // drain
    }

    generateTextMock.mockResolvedValueOnce({ text: "summary" });
    streamTextMock.mockReturnValueOnce({ textStream: textStream("new") });
    const messages = [];
    for await (const message of adapter.prompt(sessionId, "new question", "F:\\repo")) {
      messages.push(message);
    }

    expect(messages[0]).toEqual({
      type: "assistant",
      blocks: [{ type: "agent_status", status: "compacting" }],
    });
    expect(messages).toContainEqual({
      type: "assistant",
      blocks: [{ type: "agent_status", status: "responding" }],
    });
  });

  it("passes effort into ChatSession so streamText receives reasoningEffort", async () => {
    const { createCccAdapter } = await import("../adapters/ccc-adapter.ts");
    const contextDir = await mkdtemp(join(tmpdir(), "chatccc-ccc-adapter-effort-"));
    const adapter = createCccAdapter({
      apiKey: "sk-test",
      provider: "openai",
      contextDir,
      effort: "xhigh",
    });
    const { sessionId } = await adapter.createSession("F:\\repo");
    streamTextMock.mockReturnValueOnce({ textStream: textStream("ok") });

    for await (const _message of adapter.prompt(sessionId, "hi", "F:\\repo")) {
      // drain
    }

    expect(streamTextMock).toHaveBeenLastCalledWith(expect.objectContaining({
      providerOptions: { deepseek: { reasoningEffort: "xhigh" } },
    }));
  });
});
