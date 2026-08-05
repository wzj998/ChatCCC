import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resumeSessionMock = vi.hoisted(() => vi.fn());
const createRawStreamLogMock = vi.hoisted(() => vi.fn());
const rawLogWriteLineMock = vi.hoisted(() => vi.fn());
const rawLogCloseMock = vi.hoisted(() => vi.fn());

// 注意：SDK 已从 chatccc 依赖中移除，改为按需安装 + 动态 import（变量路径），
// vi.mock 无法拦截；这里通过 __setClaudeSdkModuleForTest 注入假 SDK 模块。

vi.mock("../adapters/raw-stream-log.ts", () => ({
  createRawStreamLog: createRawStreamLogMock,
}));

import { config } from "../config.ts";
import {
  __setClaudeSdkModuleForTest,
  createClaudeAdapter,
} from "../adapters/claude-adapter.ts";

const originalRawStreamLogs = structuredClone(config.rawStreamLogs);

async function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

beforeEach(() => {
  __setClaudeSdkModuleForTest({
    getSessionInfo: vi.fn(),
    unstable_v2_createSession: vi.fn(),
    unstable_v2_resumeSession: resumeSessionMock,
  });
});

afterEach(() => {
  __setClaudeSdkModuleForTest(null);
  resumeSessionMock.mockReset();
  createRawStreamLogMock.mockReset();
  rawLogWriteLineMock.mockReset();
  rawLogCloseMock.mockReset();
  config.rawStreamLogs = structuredClone(originalRawStreamLogs);
});

describe("Claude raw stream logs", () => {
  it("writes raw Claude SDK stream messages when enabled", async () => {
    const rawMessages = [
      { type: "system", subtype: "init", session_id: "sid-raw", cwd: "F:/project", model: "claude-test" },
      { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } },
    ];
    const session = {
      send: vi.fn(async () => {}),
      stream: async function* () {
        for (const msg of rawMessages) yield msg;
      },
      close: vi.fn(),
    };
    resumeSessionMock.mockReturnValueOnce(session);
    createRawStreamLogMock.mockResolvedValueOnce({
      filePath: "claude.jsonl.gz",
      writeLine: rawLogWriteLineMock,
      close: rawLogCloseMock,
    });
    config.rawStreamLogs.claude = {
      enabled: true,
      maxBytesPerTurn: 4096,
      retentionDays: 5,
      keepCompleted: false,
    };

    const adapter = createClaudeAdapter({
      model: "claude-test",
      effort: "high",
      isEmpty: (value) => value.trim() === "",
    });
    const events = await collect(adapter.prompt("sid-raw", "hi", "F:/project"));

    expect(createRawStreamLogMock).toHaveBeenCalledWith(expect.objectContaining({
      enabled: true,
      tool: "claude",
      sessionId: "sid-raw",
      label: "prompt",
      maxBytesPerTurn: 4096,
      retentionDays: 5,
    }));
    expect(rawLogWriteLineMock).toHaveBeenNthCalledWith(1, JSON.stringify(rawMessages[0]));
    expect(rawLogWriteLineMock).toHaveBeenNthCalledWith(2, JSON.stringify(rawMessages[1]));
    expect(rawLogCloseMock).toHaveBeenCalledWith({ keep: false });
    expect(session.close).toHaveBeenCalledOnce();
    expect(events).toContainEqual({
      type: "assistant",
      blocks: [{ type: "text", text: "hello" }],
    });
  });
});
