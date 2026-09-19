import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../config.js";

const streamTextMock = vi.fn();
const generateTextMock = vi.fn();
const createRawStreamLogMock = vi.fn();
const createOpenAICompatibleMock = vi.fn(() => (modelId: string) => ({ modelId }));
const createAnthropicMock = vi.fn(() => (modelId: string) => ({ modelId, provider: "anthropic" }));

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: createOpenAICompatibleMock,
}));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: createAnthropicMock,
}));

vi.mock("ai", () => ({
  streamText: streamTextMock,
  generateText: generateTextMock,
  isLoopFinished: vi.fn(() => ({ loopFinished: true })),
  stepCountIs: vi.fn((count: number) => ({ count })),
  jsonSchema: vi.fn((schema: unknown) => schema),
  tool: vi.fn((definition: unknown) => definition),
}));

vi.mock("../raw-stream-log.js", () => ({
  createRawStreamLog: createRawStreamLogMock,
}));

async function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

const original = {
  streaming: config.streaming,
  provider: config.provider,
  effort: config.effort,
  maxOutputTokens: config.maxOutputTokens,
  rawStreamLogs: config.rawStreamLogs,
};

beforeEach(() => {
  config.provider = "openai";
  config.streaming = true;
  config.effort = "";
  config.maxOutputTokens = undefined;
});

afterEach(() => {
  streamTextMock.mockReset();
  generateTextMock.mockReset();
  createRawStreamLogMock.mockReset();
  config.provider = original.provider;
  config.streaming = original.streaming;
  config.effort = original.effort;
  config.maxOutputTokens = original.maxOutputTokens;
  config.rawStreamLogs = original.rawStreamLogs;
  createOpenAICompatibleMock.mockClear();
  createAnthropicMock.mockClear();
});

describe("ChatSession collaborative input injection", () => {
  it("injects a drained message at a step boundary and continues the same turn", async () => {
    const { ChatSession } = await import("../index.js");
    const session = new ChatSession({ apiKey: "sk-test" }, { persist: false });

    const drained = ["补充指令"];
    const drainInput = () => drained.shift();

    let callIndex = 0;
    streamTextMock.mockImplementation((options: any) => {
      const index = callIndex;
      callIndex += 1;
      const parts = (async function* () {
        try {
          await options.prepareStep({ messages: options.messages, stepNumber: 0 });
          yield { type: "text-delta", text: `reply-${index}` };
          yield { type: "finish", finishReason: "stop" };
        } catch (err) {
          yield { type: "error", error: err };
        }
      })();
      return { fullStream: parts };
    });

    const events = await collect(session.chat("原始任务", undefined, drainInput));

    // 第一次调用在 prepareStep 注入中断，第二次调用正常完成同一轮。
    expect(streamTextMock).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual({ type: "input_injected", text: "补充指令" });
    expect(events.some((event) => (event as { type: string }).type === "done")).toBe(true);
    expect(events.some((event) => (event as { type: string; text?: string }).text === "reply-1")).toBe(true);

    const secondMessages = streamTextMock.mock.calls[1][0].messages as Array<{ role: string; content: unknown }>;
    const userContents = secondMessages.filter((message) => message.role === "user").map((message) => message.content);
    expect(userContents).toContain("补充指令");
  });

  it("persists the in-progress segment before injecting so tool results are not lost", async () => {
    const { ChatSession } = await import("../index.js");
    const session = new ChatSession({ apiKey: "sk-test" }, { persist: false });

    // 第二次 prepareStep（step 1）才 drain 到消息：此时已有 text + 工具结果中间态。
    let drainCalls = 0;
    const drainInput = () => (++drainCalls === 2 ? "注入指令" : undefined);

    streamTextMock.mockImplementation((options: any) => {
      const parts = (async function* () {
        let step = 0;
        while (true) {
          try {
            await options.prepareStep({ messages: options.messages, stepNumber: step });
          } catch (err) {
            yield { type: "error", error: err };
            return;
          }
          if (step === 0) {
            yield { type: "text-delta", text: "先看" };
            yield { type: "tool-call", toolCallId: "t1", toolName: "read_file", input: { path: "a.txt" } };
            yield { type: "tool-result", toolCallId: "t1", toolName: "read_file", output: { type: "text", value: "文件内容" } };
            step = 1;
          } else {
            yield { type: "text-delta", text: "继续回复" };
            yield { type: "finish", finishReason: "stop" };
            return;
          }
        }
      })();
      return { fullStream: parts };
    });

    const events = await collect(session.chat("原始任务", undefined, drainInput));

    expect(streamTextMock).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual({ type: "input_injected", text: "注入指令" });
    expect(events.some((event) => (event as { type: string; text?: string }).text === "继续回复")).toBe(true);

    const secondMessages = JSON.stringify(streamTextMock.mock.calls[1][0].messages);
    expect(secondMessages).toContain("read_file");
    expect(secondMessages).toContain("文件内容");
    expect(secondMessages).toContain("注入指令");
  });
});
