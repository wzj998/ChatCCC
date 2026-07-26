import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const createRawStreamLogMock = vi.hoisted(() => vi.fn());
const rawLogWriteLineMock = vi.hoisted(() => vi.fn());
const rawLogCloseMock = vi.hoisted(() => vi.fn());
const killProcessTreeMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

vi.mock("../adapters/raw-stream-log.ts", () => ({
  createRawStreamLog: createRawStreamLogMock,
}));

vi.mock("../adapters/proc-tree-kill.ts", () => ({
  killProcessTree: killProcessTreeMock,
}));

import { config } from "../config.ts";
import { createCodexAdapter } from "../adapters/codex-adapter.ts";
import { BadJsonIdleTimeoutError } from "../adapters/jsonl-stream.ts";
import type { CodexSessionMetaStore } from "../adapters/codex-session-meta-store.ts";

const originalRawStreamLogs = structuredClone(config.rawStreamLogs);

function createProc(lines: string[]): EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  pid: number;
} {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
    pid: number;
  };
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new PassThrough();
  proc.pid = 4242;
  queueMicrotask(() => {
    for (const line of lines) proc.stdout.write(`${line}\n`);
    proc.stdout.end();
    proc.stderr.end();
    proc.emit("close", 0);
  });
  return proc;
}

function createHangingProc(lines: string[]): EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  pid: number;
} {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
    pid: number;
  };
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new PassThrough();
  proc.pid = 4242;
  queueMicrotask(() => {
    for (const line of lines) proc.stdout.write(`${line}\n`);
  });
  return proc;
}

async function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function metaStore(): CodexSessionMetaStore {
  return {
    async get(sessionId) {
      return sessionId === "sid-raw" ? { cwd: "F:/project" } : undefined;
    },
    async set() {},
    async setThreadId() {},
  };
}

afterEach(() => {
  vi.useRealTimers();
  spawnMock.mockReset();
  createRawStreamLogMock.mockReset();
  rawLogWriteLineMock.mockReset();
  rawLogCloseMock.mockReset();
  killProcessTreeMock.mockClear();
  config.rawStreamLogs = structuredClone(originalRawStreamLogs);
});

describe("Codex raw stream logs", () => {
  it("writes raw Codex JSONL stdout lines when enabled", async () => {
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
      JSON.stringify({ type: "item.completed", item: { id: "item-1", type: "agent_message", text: "hello" } }),
      JSON.stringify({ type: "turn.completed" }),
    ];
    spawnMock.mockReturnValueOnce(createProc(lines));
    createRawStreamLogMock.mockResolvedValueOnce({
      filePath: "codex.jsonl.gz",
      writeLine: rawLogWriteLineMock,
      close: rawLogCloseMock,
    });
    config.rawStreamLogs.codex = {
      enabled: true,
      maxBytesPerTurn: 2048,
      retentionDays: 2,
      keepCompleted: false,
    };

    const adapter = createCodexAdapter({ metaStore: metaStore() });
    const events = await collect(adapter.prompt("sid-raw", "hi", "F:/project"));

    expect(createRawStreamLogMock).toHaveBeenCalledWith(expect.objectContaining({
      enabled: true,
      tool: "codex",
      sessionId: "sid-raw",
      label: "prompt",
      maxBytesPerTurn: 2048,
      retentionDays: 2,
    }));
    expect(rawLogWriteLineMock).toHaveBeenNthCalledWith(1, lines[0]);
    expect(rawLogWriteLineMock).toHaveBeenNthCalledWith(2, lines[1]);
    expect(rawLogWriteLineMock).toHaveBeenNthCalledWith(3, lines[2]);
    expect(rawLogCloseMock).toHaveBeenCalledWith({ keep: false });
    expect(events).toEqual([
      {
        type: "assistant",
        blocks: [{ type: "text", text: "hello" }],
      },
      {
        type: "assistant",
        blocks: [],
        isFinalResponse: true,
      },
    ]);
  });

  it("fails the turn and kills the process tree when bad JSON is followed by idle stdout", async () => {
    vi.useFakeTimers();
    spawnMock.mockReturnValueOnce(createHangingProc([
      "{\"type\":\"item.started\",\"item\":{\"type\":\"command_execution\"",
    ]));
    createRawStreamLogMock.mockResolvedValueOnce(null);

    const adapter = createCodexAdapter({ metaStore: metaStore() });
    const pending = collect(adapter.prompt("sid-raw", "hi", "F:/project"))
      .catch((error: unknown) => error);

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(120_000);

    const error = await pending;
    expect(error).toBeInstanceOf(BadJsonIdleTimeoutError);
    expect(killProcessTreeMock).toHaveBeenCalledWith(4242);
  });
});
