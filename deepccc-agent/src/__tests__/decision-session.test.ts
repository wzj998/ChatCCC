import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonSchema } from "ai";

const { streamMock } = vi.hoisted(() => ({ streamMock: vi.fn() }));
vi.mock("ai", async (original) => ({ ...await original<typeof import("ai")>(), streamText: streamMock }));

const schema = jsonSchema<{ action: string }>({
  type: "object", properties: { action: { type: "string" } }, required: ["action"], additionalProperties: false,
}, { validate: (v: any) => v && typeof v.action === "string" && Object.keys(v).length === 1
  ? { success: true, value: v } : { success: false, error: new Error("Invalid action") } });
const inputSchema = jsonSchema<Record<string, never>>({ type: "object", additionalProperties: false }, {
  validate: (v: any) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0
    ? { success: true, value: v } : { success: false, error: new Error("Expected empty object") },
});
const config = { apiKey: "test-key", baseURL: "https://example.invalid/v1", model: "example-model", effort: "" };
const request = (context: unknown = { position: 1 }) => ({ requestId: "req-1", stateVersion: 1, context, timeoutMs: 1000 });
const call = (toolName = "submit_result", input: unknown = { action: "wait" }) => ({ type: "tool-call", toolCallId: "c1", toolName, input });
function response(parts: unknown[] = [call()], finish = "tool-calls") {
  return { fullStream: (async function* () { for (const p of parts) yield p; yield { type: "finish", finishReason: finish }; })() };
}
async function create(options: Record<string, unknown> = {}) {
  const { DecisionSession } = await import("../decision-session.js");
  return new DecisionSession(config, { systemPrompt: "Choose an action.", outputSchema: schema, ...options });
}
afterEach(() => { streamMock.mockReset(); vi.useRealTimers(); });

describe("DecisionSession", () => {
  it("returns validated data, identity and metrics without coding prompts or builtin tools", async () => {
    streamMock.mockReturnValue(response());
    const session = await create();
    const result = await session.decide(request());
    expect(result).toMatchObject({ status: "success", value: { action: "wait" }, requestId: "req-1", stateVersion: 1 });
    expect(result.metrics.modelCalls).toBe(1);
    const opts = streamMock.mock.calls[0][0];
    expect(Object.keys(opts.tools)).toEqual(["submit_result"]);
    expect(opts.system).toContain("Choose an action.");
    expect(opts.system).not.toContain("read_file");
    expect(opts.maxRetries).toBe(0);
  });
  it("does not accumulate previous snapshots or run compaction", async () => {
    streamMock.mockImplementation(() => response());
    const session = await create();
    await session.decide(request({ marker: "OLD_STATE" }));
    await session.decide(request({ marker: "NEW_STATE" }));
    const messages = streamMock.mock.calls[1][0].messages;
    expect(messages).toHaveLength(1);
    expect(JSON.stringify(messages)).not.toContain("OLD_STATE");
    expect(JSON.stringify(messages)).toContain("NEW_STATE");
  });
  it.each(["length", "error", "other"])("rejects a provider finish of %s even with a complete tool call", async (finish) => {
    streamMock.mockReturnValue(response([call()], finish));
    expect((await (await create()).decide(request())).status).toBe("invalid_output");
  });
  it("never accepts partial text or an unvalidated object", async () => {
    streamMock.mockReturnValueOnce(response([{ type: "text-delta", text: '{"action":' }], "stop"));
    const session = await create();
    expect((await session.decide(request())).status).toBe("invalid_output");
    streamMock.mockReturnValueOnce(response([call("submit_result", { action: 3 })]));
    expect((await session.decide(request())).status).toBe("invalid_output");
  });
  it("rejects streams without a finish event", async () => {
    streamMock.mockReturnValue({ fullStream: (async function* () { yield call(); })() });
    expect((await (await create()).decide(request())).status).toBe("invalid_output");
  });
  it("times out even when a provider ignores cancellation; no late tools execute", async () => {
    const session = await create();
    vi.useFakeTimers();
    streamMock.mockReturnValue({ fullStream: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) } });
    const pending = session.decide({ ...request(), timeoutMs: 20 });
    await vi.advanceTimersByTimeAsync(21);
    expect(await pending).toMatchObject({ status: "timed_out" });
    expect(streamMock.mock.calls[0][0].abortSignal.aborted).toBe(true);
  });
  it("distinguishes cancellation and rejects pre-cancelled calls without inference", async () => {
    const abort = new AbortController(); abort.abort();
    expect((await (await create()).decide(request(), abort.signal)).status).toBe("cancelled");
    expect(streamMock).not.toHaveBeenCalled();
  });
  it("only exposes allowlisted tools and returns their observations to the next step", async () => {
    const inspect = vi.fn(async () => ({ remaining: 2 }));
    streamMock.mockReturnValueOnce(response([call("inspect", {})])).mockReturnValueOnce(response());
    const session = await create({ maxSteps: 2, allowedTools: ["inspect"], tools: {
      inspect: { description: "Inspect state", inputSchema, execute: inspect },
      hidden: { description: "Hidden", inputSchema, execute: vi.fn() },
    } });
    expect((await session.decide(request())).status).toBe("success");
    expect(inspect).toHaveBeenCalledOnce();
    expect(Object.keys(streamMock.mock.calls[0][0].tools)).toEqual(["inspect", "submit_result"]);
    expect(streamMock.mock.calls[0][0].tools.inspect.execute).toBeUndefined();
    expect(JSON.stringify(streamMock.mock.calls[1][0].messages)).toContain("remaining");
  });
  it("rejects unknown tools and mixed submission batches before any execution", async () => {
    const execute = vi.fn();
    const session = await create({ allowedTools: ["inspect"], tools: { inspect: { description: "Inspect", inputSchema, execute } } });
    streamMock.mockReturnValueOnce(response([call("unknown", {})]));
    expect((await session.decide(request())).status).toBe("invalid_output");
    streamMock.mockReturnValueOnce(response([call("inspect", {}), { ...call(), toolCallId: "c2" }]));
    expect((await session.decide(request())).status).toBe("invalid_output");
    expect(execute).not.toHaveBeenCalled();
  });
  it("caps input context without silently truncating state", async () => {
    const session = await create({ maxContextChars: 20 });
    expect((await session.decide(request({ big: "x".repeat(40) }))).status).toBe("context_limit");
    expect(streamMock).not.toHaveBeenCalled();
  });
  it("requires runtime validators, not just model-facing JSON schemas", async () => {
    await expect(create({ outputSchema: jsonSchema({ type: "object" }) })).rejects.toThrow(/validat/i);
  });
  it("enforces step limits without executing tools that cannot lead to a result", async () => {
    const execute = vi.fn();
    const session = await create({ tools: { inspect: { description: "Inspect", inputSchema, execute } }, allowedTools: ["inspect"] });
    streamMock.mockReturnValue(response([call("inspect", {})]));
    expect((await session.decide(request())).status).toBe("step_limit");
    expect(execute).not.toHaveBeenCalled();
  });
  it("validates every tool in a batch before executing the first", async () => {
    const execute = vi.fn();
    const session = await create({ maxSteps: 2, tools: { inspect: { description: "Inspect", inputSchema, execute } }, allowedTools: ["inspect"] });
    streamMock.mockReturnValue(response([call("inspect", {}), { ...call("inspect", { unexpected: true }), toolCallId: "c2" }]));
    expect((await session.decide(request())).status).toBe("invalid_output");
    expect(execute).not.toHaveBeenCalled();
  });
  it("shares the deadline with tools, including ones that ignore cancellation", async () => {
    const execute = vi.fn((_input: unknown, _context: { signal: AbortSignal }) => new Promise(() => {}));
    const session = await create({ maxSteps: 2, tools: { inspect: { description: "Inspect", inputSchema, execute } }, allowedTools: ["inspect"] });
    vi.useFakeTimers();
    streamMock.mockReturnValue(response([call("inspect", {})]));
    const pending = session.decide({ ...request(), timeoutMs: 20 });
    await vi.advanceTimersByTimeAsync(21);
    expect((await pending).status).toBe("timed_out");
    expect(execute.mock.calls[0][1].signal.aborted).toBe(true);
    expect(streamMock).toHaveBeenCalledOnce();
  });
  it("does not return partial data when cancelled mid-generation", async () => {
    const controller = new AbortController();
    streamMock.mockReturnValue({ fullStream: (async function* () { yield call(); controller.abort(); })() });
    expect(await (await create()).decide(request(), controller.signal)).toMatchObject({ status: "cancelled" });
  });
  it("propagates a cancellation while awaiting a provider promise", async () => {
    const controller = new AbortController();
    streamMock.mockReturnValue({ fullStream: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) } });
    const session = await create();
    const pending = session.decide(request(), controller.signal);
    controller.abort();
    expect((await pending).status).toBe("cancelled");
  });
  it("caps tool results and does not leak tool exceptions", async () => {
    const execute = vi.fn().mockResolvedValueOnce({ big: "x".repeat(100) }).mockRejectedValueOnce(new Error("private error text"));
    const session = await create({ maxSteps: 2, maxToolResultChars: 20, tools: { inspect: { description: "Inspect", inputSchema, execute } }, allowedTools: ["inspect"] });
    streamMock.mockImplementation(() => response([call("inspect", {})]));
    expect((await session.decide(request())).status).toBe("context_limit");
    const failed = await session.decide(request());
    expect(failed.status).toBe("tool_error");
    expect(JSON.stringify(failed)).not.toContain("private error text");
  });
  it("rejects oversized responses and input serialization failures", async () => {
    streamMock.mockReturnValue(response([call("submit_result", { action: "x".repeat(100) })]));
    const result = await (await create({ maxResponseChars: 20 })).decide(request());
    expect(result.status).not.toBe("success");
    expect((await (await create()).decide(request({ invalid: 1n }))).status).toBe("context_limit");
  });
  it("requires known allowed names and positive budgets", async () => {
    await expect(create({ allowedTools: ["missing"] })).rejects.toThrow(/Unknown/);
    await expect(create({ allowedTools: ["submit_result"] })).rejects.toThrow(/reserved/);
    await expect(create({ maxSteps: 0 })).rejects.toThrow(/positive/);
    await expect((await create()).decide({ ...request(), timeoutMs: 0 })).rejects.toThrow(/positive/);
  });
  it("does not expose tools just because they are supplied", async () => {
    streamMock.mockReturnValue(response());
    await (await create({ tools: { inspect: { description: "Inspect", inputSchema, execute: vi.fn() } } })).decide(request());
    expect(Object.keys(streamMock.mock.calls[0][0].tools)).toEqual(["submit_result"]);
  });
  it("supports unrelated caller-defined result vocabularies without changing the core", async () => {
    const allocationSchema = jsonSchema<{ amount: number }>({ type: "object", properties: { amount: { type: "integer", minimum: 0, maximum: 3 } }, required: ["amount"], additionalProperties: false }, {
      validate: (v: any) => v && Object.keys(v).length === 1 && Number.isInteger(v.amount) && v.amount >= 0 && v.amount <= 3
        ? { success: true, value: v } : { success: false, error: new Error("Invalid allocation") },
    });
    streamMock.mockReturnValue(response([call("submit_result", { amount: 2 })]));
    const result = await (await create({ outputSchema: allocationSchema })).decide(request({ stock: 3, demand: 2 }));
    expect(result).toMatchObject({ status: "success", value: { amount: 2 } });
  });
  it("captures request identity before asynchronous work", async () => {
    streamMock.mockReturnValue(response());
    const session = await create();
    const input = request();
    const pending = session.decide(input);
    input.stateVersion = 99;
    input.requestId = "changed";
    expect(await pending).toMatchObject({ requestId: "req-1", stateVersion: 1 });
  });
});
