import { afterEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn,
}));

import { createAntigravityAdapter } from "../adapters/antigravity-adapter.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  spawn.mockReset();
});

describe("Antigravity ACP adapter", () => {
  it("requires API credentials before launching agy", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    await expect(createAntigravityAdapter({ enabled: true }).createSession(process.cwd()))
      .rejects.toThrow("GEMINI_API_KEY");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("authenticates with an API key, resumes a session, and streams its reply", async () => {
    vi.stubEnv("GEMINI_API_KEY", "unit-test-key");
    const permissions: unknown[] = [];
    const requests: Array<{ method: string; params: unknown }> = [];
    spawn.mockImplementation(() => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const process = Object.assign(new PassThrough(), { stdin, stdout, stderr });
      const send = (message: object) => stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
      createInterface({ input: stdin }).on("line", (line) => {
        const { id, method, params } = JSON.parse(line);
        if (!method) {
          if (id === 99) permissions.push(JSON.parse(line).result);
          return;
        }
        requests.push({ method, params });
        if (method === "initialize") {
          send({ id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } } });
        } else if (method === "session/new") {
          send({ id, result: { sessionId: "agy-test-session" } });
        } else if (method === "session/prompt") {
          send({
            id: 99,
            method: "session/request_permission",
            params: { sessionId: params.sessionId, toolCall: { toolCallId: "call" }, options: [] },
          });
          send({
            method: "session/update",
            params: {
              sessionId: params.sessionId,
              update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "你好" } },
            },
          });
          send({ id, result: { stopReason: "end_turn" } });
        } else {
          send({ id, result: {} });
        }
      });
      return process;
    });

    const store = { get: vi.fn(), set: vi.fn() };
    const adapter = createAntigravityAdapter({ enabled: true, store });
    const cwd = process.cwd();
    const { sessionId } = await adapter.createSession(cwd);
    const blocks = [];
    for await (const message of adapter.prompt(sessionId, "Say hi", cwd)) {
      blocks.push(...message.blocks);
    }

    expect(blocks).toEqual([{ type: "text", text: "你好" }]);
    expect(permissions).toEqual([{ outcome: { outcome: "cancelled" } }]);
    expect(store.set).toHaveBeenCalledWith(sessionId, { cwd });
    expect(requests.filter((request) => request.method === "authenticate")).toEqual([
      { method: "authenticate", params: { methodId: "gemini-api-key" } },
      { method: "authenticate", params: { methodId: "gemini-api-key" } },
    ]);
    expect(requests).toContainEqual({ method: "session/resume", params: { sessionId, cwd, mcpServers: [] } });
    expect(requests).toContainEqual({
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "Say hi" }] },
    });
    expect(spawn).toHaveBeenLastCalledWith("agy", ["acp", "--sandbox"], expect.objectContaining({ cwd, shell: false }));
  });
});
