import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BadJsonIdleTimeoutError,
  readJsonLinesWithBadJsonIdleWatchdog,
} from "../adapters/jsonl-stream.ts";

function createReader(input: PassThrough, idleTimeoutMs = 100): AsyncIterator<unknown> {
  return readJsonLinesWithBadJsonIdleWatchdog({
    input,
    tool: "test-agent",
    tag: "sid-test",
    idleTimeoutMs,
    parse: (line) => JSON.parse(line) as unknown,
  })[Symbol.asyncIterator]();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("readJsonLinesWithBadJsonIdleWatchdog", () => {
  it("throws when a JSON-like bad line remains the last stdout past the idle timeout", async () => {
    vi.useFakeTimers();
    const input = new PassThrough();
    const iterator = createReader(input);

    const pending = iterator.next().catch((error: unknown) => error);
    input.write("{\"type\":\"tool_call\",\"subtype\":\"started\"\n");

    await vi.advanceTimersByTimeAsync(100);

    const error = await pending;
    expect(error).toBeInstanceOf(BadJsonIdleTimeoutError);
    expect(error).toMatchObject({
      code: "BAD_JSON_IDLE_TIMEOUT",
      tool: "test-agent",
      tag: "sid-test",
    });
  });

  it("does not throw when a valid JSON line arrives after the bad line before timeout", async () => {
    vi.useFakeTimers();
    const input = new PassThrough();
    const iterator = createReader(input);

    const pending = iterator.next();
    input.write("{\"type\":\"tool_call\"\n");
    await vi.advanceTimersByTimeAsync(50);
    input.write("{\"type\":\"ok\"}\n");

    await expect(pending).resolves.toEqual({
      done: false,
      value: { type: "ok" },
    });

    const done = iterator.next();
    input.end();
    await expect(done).resolves.toEqual({ done: true, value: undefined });
  });

  it("ignores non-JSON banner lines for the bad JSON idle watchdog", async () => {
    vi.useFakeTimers();
    const input = new PassThrough();
    const iterator = createReader(input);

    const pending = iterator.next();
    input.write("Reading prompt from stdin...\n");
    await vi.advanceTimersByTimeAsync(200);
    input.write("{\"type\":\"ok\"}\n");

    await expect(pending).resolves.toEqual({
      done: false,
      value: { type: "ok" },
    });
  });
});
