import { afterEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn,
}));

import { createAntigravityAdapter } from "../adapters/antigravity-adapter.ts";

function fakeProcess() {
  return Object.assign(new PassThrough(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  spawn.mockReset();
});

describe("Antigravity adapter", () => {
  it("requires API credentials before launching agy", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    await expect(createAntigravityAdapter({ enabled: true }).createSession(process.cwd()))
      .rejects.toThrow("GEMINI_API_KEY");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("uses API-key authentication to create a session without sending a prompt", async () => {
    vi.stubEnv("GEMINI_API_KEY", "unit-test-key");
    const requests: Array<{ method: string; params: unknown }> = [];
    const proc = fakeProcess();
    spawn.mockReturnValue(proc);
    createInterface({ input: proc.stdin }).on("line", (line) => {
      const { id, method, params } = JSON.parse(line);
      requests.push({ method, params });
      const result = method === "initialize" ? { protocolVersion: 1 }
        : method === "session/new" ? { sessionId: "agy-test-session" }
        : {};
      proc.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
    });
    const store = { get: vi.fn(), set: vi.fn() };
    const cwd = process.cwd();
    const adapter = createAntigravityAdapter({ enabled: true, store });
    await expect(adapter.createSession(cwd)).resolves.toEqual({ sessionId: "agy-test-session" });
    expect(requests.map(({ method }) => method)).toEqual(["initialize", "authenticate", "session/new"]);
    expect(requests[1].params).toEqual({ methodId: "gemini-api-key" });
    expect(store.set).toHaveBeenCalledWith("agy-test-session", { cwd, model: "gemini-3.1-flash-lite" });
  });

  it.each([
    { model: undefined, expected: "gemini-3.1-flash-lite", plan: false },
    { model: "gemini-2.5-flash-lite", expected: "gemini-2.5-flash-lite", plan: true },
  ])("pins $expected before resuming and prompting", async ({ model, expected, plan }) => {
    vi.stubEnv("GEMINI_API_KEY", "unit-test-key");
    const proc = fakeProcess();
    spawn.mockReturnValue(proc);
    const sent = vi.fn();
    createInterface({ input: proc.stdin }).on("line", (line) => {
      sent(JSON.parse(line));
      for (const data of [
        { event: "step_update", step_update: { step_type: "agent_response", text_delta: "你好" } },
        { event: "result", result: { status: "SUCCESS", response: "你好" } },
      ]) {
        proc.stdout.write(JSON.stringify(data) + "\n");
      }
      proc.stdout.end();
      proc.emit("close", 0);
    });

    const cwd = process.cwd();
    const store = { get: vi.fn(), set: vi.fn() };
    const adapter = createAntigravityAdapter({ enabled: true, model, store });
    const prompt = plan ? "[User message]\n/plan Say hi\n[/User message]" : "Say hi";
    const blocks = [];
    for await (const message of adapter.prompt("agy-test-session", prompt, cwd)) blocks.push(...message.blocks);

    expect(blocks).toEqual([{ type: "text", text: "你好" }, { type: "text_final", text: "你好" }]);
    expect(sent).toHaveBeenCalledWith({ event: "user", message: { content: prompt } });
    const [executable, args, options] = spawn.mock.calls[0];
    expect(executable).toBe("agy");
    expect(args).toEqual(expect.arrayContaining(["--sandbox", "--conversation", "agy-test-session", "--model", "chatccc-gemini"]));
    expect(args.includes("plan")).toBe(plan);
    expect(options).toEqual(expect.objectContaining({ cwd, shell: false }));
    expect(JSON.parse(args[args.indexOf("--settings") + 1])).toMatchObject({
      modelProvider: "gemini",
      customModelsConfig: { customModels: { "chatccc-gemini": { modelName: "gemini-api://" + expected } } },
    });
  });

  it("propagates unavailable-model errors without launching a fallback", async () => {
    vi.stubEnv("GEMINI_API_KEY", "unit-test-key");
    const proc = fakeProcess();
    spawn.mockReturnValue(proc);
    proc.stdin.on("finish", () => {
      proc.stdout.end(JSON.stringify({ event: "result", result: { status: "ERROR", error: "model unavailable" } }) + "\n");
      proc.emit("close", 1);
    });

    const adapter = createAntigravityAdapter({ enabled: true, model: "gemini-unavailable" });
    const messages = adapter.prompt("agy-test-session", "Say hi", process.cwd());
    await expect(messages[Symbol.asyncIterator]().next()).rejects.toThrow("model unavailable");
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
