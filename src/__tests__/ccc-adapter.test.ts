import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const streamTextMock = vi.fn();
const generateTextMock = vi.fn();

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: vi.fn(() => (modelId: string) => ({ modelId })),
}));

vi.mock("ai", () => ({
  streamText: streamTextMock,
  generateText: generateTextMock,
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
  it("creates a persisted ccc session and exposes model/cwd metadata", async () => {
    const { createCccAdapter } = await import("../adapters/ccc-adapter.ts");
    const contextDir = await mkdtemp(join(tmpdir(), "chatccc-ccc-adapter-meta-"));
    const adapter = createCccAdapter({
      apiKey: "sk-test",
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
      { type: "assistant", blocks: [{ type: "text", text: "hello" }] },
      { type: "assistant", blocks: [{ type: "text", text: " world" }] },
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
      {
        type: "assistant",
        blocks: [{ type: "tool_use", id: "call-1", name: "read_file", input: { path: "README.md" } }],
      },
      {
        type: "assistant",
        blocks: [{ type: "tool_result", tool_use_id: "call-1", content: { content: "hello" }, is_error: false }],
      },
    ]);
  });
});
