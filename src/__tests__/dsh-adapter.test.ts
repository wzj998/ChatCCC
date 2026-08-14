import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../engines/engine-specs.ts", () => ({
  engineManager: {
    getEntryPath: vi.fn(async () => "C:/fake/engine/node_modules/@deepseek-ai/dsh-sdk-client/lib/index.js"),
  },
}));

import { __setDshSdkModuleForTest, createDshAdapter } from "../adapters/dsh-adapter.ts";

afterEach(() => __setDshSdkModuleForTest(null));

describe("DshAdapter", () => {
  it("maps live JSON-RPC notifications and emits one authoritative final response", async () => {
    class FakeHarness {
      async start(): Promise<void> {}
      async close(): Promise<void> {}
      async run(_input: string, options: { sessionId: string; onNotification: (value: unknown) => void }) {
        options.onNotification({ method: "session.status", params: { sessionId: options.sessionId, status: "running" } });
        options.onNotification({ method: "session.event", params: { event: {
          type: "tool/call",
          data: { callId: "call-1", name: "read_file", arguments: '{"path":"README.md"}' },
        } } });
        options.onNotification({ method: "session.event", params: { event: {
          type: "tool/result",
          data: { message: { toolCallId: "call-1", content: "ok" } },
        } } });
        return { sessionId: options.sessionId, finalResponse: "完成" };
      }
    }
    __setDshSdkModuleForTest({ DeepSeekHarness: FakeHarness as never });
    const adapter = createDshAdapter({ model: "deepseek-v4-flash" });
    const created = await adapter.createSession("C:/workspace");
    const messages = [];
    for await (const message of adapter.prompt(created.sessionId, "read it", "C:/workspace")) messages.push(message);

    expect(messages.flatMap((message) => message.blocks).map((block) => block.type)).toEqual([
      "agent_status",
      "tool_use",
      "tool_result",
      "text_final",
    ]);
    expect(messages.at(-1)).toEqual({
      type: "assistant",
      blocks: [{ type: "text_final", text: "完成" }],
      isFinalResponse: true,
    });
    expect((await adapter.getSessionInfo(created.sessionId))?.cwd).toBe("C:/workspace");
  });
});
