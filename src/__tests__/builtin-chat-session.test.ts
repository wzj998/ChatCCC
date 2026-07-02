import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { config } from "../config.ts";

const streamTextMock = vi.fn();
const generateTextMock = vi.fn();
const createRawStreamLogMock = vi.fn();
const rawLogWriteLineMock = vi.fn();
const rawLogCloseMock = vi.fn();
const originalRawStreamLogs = structuredClone(config.rawStreamLogs);

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

vi.mock("../adapters/raw-stream-log.ts", () => ({
  createRawStreamLog: createRawStreamLogMock,
}));

async function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

async function* textStream(...chunks: string[]): AsyncIterable<string> {
  for (const chunk of chunks) yield chunk;
}

async function* fullStream(...parts: unknown[]): AsyncIterable<unknown> {
  for (const part of parts) yield part;
}

afterEach(() => {
  streamTextMock.mockReset();
  generateTextMock.mockReset();
  createRawStreamLogMock.mockReset();
  rawLogWriteLineMock.mockReset();
  rawLogCloseMock.mockReset();
  config.rawStreamLogs = structuredClone(originalRawStreamLogs);
});

describe("ChatSession context management", () => {
  it("loads persisted context, compacts older messages, and persists the new assistant reply", async () => {
    const { ChatSession } = await import("../builtin/index.ts");
    const dir = await mkdtemp(join(tmpdir(), "chatccc-session-context-"));

    const seed = new ChatSession(
      { apiKey: "sk-test" },
      {
        persist: true,
        contextDir: dir,
        sessionId: "integration",
        compactAtTokens: 10_000,
      },
    );
    streamTextMock.mockReturnValueOnce({ textStream: textStream("old answer") });
    await collect(seed.chat("old question"));

    generateTextMock.mockResolvedValueOnce({ text: "## 当前任务状态\n- 旧问题已总结" });
    streamTextMock.mockReturnValueOnce({ textStream: textStream("new answer") });

    const restored = new ChatSession(
      { apiKey: "sk-test" },
      {
        persist: true,
        contextDir: dir,
        sessionId: "integration",
        compactAtTokens: 1,
        keepRecentMessages: 1,
      },
    );
    const events = await collect(restored.chat("new question"));

    expect(generateTextMock).toHaveBeenCalledOnce();
    expect(streamTextMock).toHaveBeenLastCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({ content: expect.stringContaining("旧问题已总结") }),
        expect.objectContaining({ role: "user", content: "new question" }),
      ]),
    }));
    expect(events).toContainEqual({ type: "compact", compactedMessages: 2 });
    expect(restored.history.map((m) => m.content).join("\n")).toContain("new answer");
  });

  it("streams tool calls and tool results from fullStream", async () => {
    const { ChatSession } = await import("../builtin/index.ts");
    const dir = await mkdtemp(join(tmpdir(), "chatccc-session-tools-"));
    const session = new ChatSession(
      { apiKey: "sk-test" },
      {
        persist: true,
        contextDir: dir,
        sessionId: "tools",
      },
    );

    streamTextMock.mockReturnValueOnce({
      fullStream: fullStream(
        { type: "tool-call", toolCallId: "call-1", toolName: "read_file", input: { path: "package.json" } },
        { type: "tool-result", toolCallId: "call-1", toolName: "read_file", output: { content: "{}" } },
        { type: "text-delta", text: "done" },
      ),
    });

    const events = await collect(session.chat("read package"));

    expect(events).toContainEqual({
      type: "tool_use",
      id: "call-1",
      name: "read_file",
      input: { path: "package.json" },
    });
    expect(events).toContainEqual({
      type: "tool_result",
      tool_use_id: "call-1",
      name: "read_file",
      content: { content: "{}" },
      is_error: false,
    });
    expect(events).toContainEqual({ type: "text", text: "done", accumulated: "done" });
  });

  it("writes raw CCC fullStream parts when raw stream logs are enabled", async () => {
    const { ChatSession } = await import("../builtin/index.ts");
    config.rawStreamLogs.ccc = {
      enabled: true,
      maxBytesPerTurn: 4096,
      retentionDays: 3,
      keepCompleted: true,
    };
    createRawStreamLogMock.mockResolvedValueOnce({
      filePath: "raw.jsonl.gz",
      writeLine: rawLogWriteLineMock,
      close: rawLogCloseMock,
    });
    const session = new ChatSession(
      { apiKey: "sk-test" },
      {
        sessionId: "raw-log-session",
      },
    );
    const textPart = { type: "text-delta", text: "hello" };
    const toolPart = {
      type: "tool-call",
      toolCallId: "call-1",
      toolName: "read_file",
      input: { path: "package.json" },
    };

    streamTextMock.mockReturnValueOnce({
      fullStream: fullStream(textPart, toolPart),
    });

    await collect(session.chat("hi"));

    expect(createRawStreamLogMock).toHaveBeenCalledWith(expect.objectContaining({
      enabled: true,
      tool: "ccc",
      sessionId: "raw-log-session",
      label: "prompt",
      maxBytesPerTurn: 4096,
      retentionDays: 3,
    }));
    expect(rawLogWriteLineMock).toHaveBeenNthCalledWith(1, JSON.stringify(textPart));
    expect(rawLogWriteLineMock).toHaveBeenNthCalledWith(2, JSON.stringify(toolPart));
    expect(rawLogCloseMock).toHaveBeenCalledWith({ keep: true });
  });
});
