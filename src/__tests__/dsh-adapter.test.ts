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

  it("passes subModel to the child agent via DSH_SUBAGENT_* env", async () => {
    let capturedEnv: Record<string, unknown> | undefined;
    class CapturingHarness {
      constructor(options: { launch?: { env?: Record<string, unknown> } }) {
        capturedEnv = options.launch?.env;
      }
      async start(): Promise<void> {}
      async close(): Promise<void> {}
      async run(_input: string, _options: unknown) {
        return { sessionId: "dsh-s", finalResponse: "ok" };
      }
    }
    __setDshSdkModuleForTest({ DeepSeekHarness: CapturingHarness as never });

    const adapter = createDshAdapter({ model: "dsh-main", subModel: "dsh-sub", provider: "custom-provider", maxTokens: 1234 });
    const created = await adapter.createSession("C:/workspace");
    for await (const _message of adapter.prompt(created.sessionId, "hi", "C:/workspace")) { /* drain */ }

    expect(capturedEnv?.DSH_SUBAGENT_MODEL).toBe("dsh-sub");
    expect(capturedEnv?.DSH_SUBAGENT_PROVIDER).toBe("custom-provider");
    expect(capturedEnv?.DSH_SUBAGENT_MAX_TOKENS).toBe("1234");
  });

  it("falls back to the main model for the subagent when subModel is empty", async () => {
    let capturedEnv: Record<string, unknown> | undefined;
    class CapturingHarness {
      constructor(options: { launch?: { env?: Record<string, unknown> } }) {
        capturedEnv = options.launch?.env;
      }
      async start(): Promise<void> {}
      async close(): Promise<void> {}
      async run(_input: string, _options: unknown) {
        return { sessionId: "dsh-s", finalResponse: "ok" };
      }
    }
    __setDshSdkModuleForTest({ DeepSeekHarness: CapturingHarness as never });

    const adapter = createDshAdapter({ model: "dsh-main" });
    const created = await adapter.createSession("C:/workspace");
    for await (const _message of adapter.prompt(created.sessionId, "hi", "C:/workspace")) { /* drain */ }

    expect(capturedEnv?.DSH_SUBAGENT_MODEL).toBe("dsh-main");
  });
});
