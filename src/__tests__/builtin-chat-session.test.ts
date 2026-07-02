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
}));

async function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

async function* textStream(...chunks: string[]): AsyncIterable<string> {
  for (const chunk of chunks) yield chunk;
}

afterEach(() => {
  streamTextMock.mockReset();
  generateTextMock.mockReset();
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
});
