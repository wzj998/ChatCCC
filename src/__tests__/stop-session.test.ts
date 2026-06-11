// =============================================================================
// stop-session.test.ts — stopSession 单测护栏
// =============================================================================
// 覆盖修复"幽灵 codex 会话"的两条关键行为：
// 1) controller.abort() 必须被触发（让 adapter finally 走 killProcessTree）
// 2) 立刻把 stream-state.status 改成 stopped，不依赖 runAgentSession 的 finally
//    （那个 finally 要等 generator 自然结束，子进程没死透就一直停在 running）
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StreamState } from "../stream-state.ts";

// mock stream-state，使用模块内可观测的 Map 记录读写
const stateStore = new Map<string, StreamState>();
const writeCalls: StreamState[] = [];

vi.mock("../stream-state.ts", () => ({
  readStreamState: async (sid: string): Promise<StreamState | null> => {
    return stateStore.get(sid) ?? null;
  },
  writeStreamState: async (state: StreamState): Promise<void> => {
    writeCalls.push(structuredClone(state));
    stateStore.set(state.sessionId, state);
  },
  createEmptyStreamState: (sid: string, cwd: string, tool: string, turnCount: number) => ({
    sessionId: sid,
    status: "running" as const,
    accumulatedContent: "",
    finalReply: "",
    chunkCount: 0,
    turnCount,
    contextTokens: 0,
    updatedAt: Date.now(),
    cwd,
    tool,
  }),
  fixStaleStreamStates: async () => {},
  STREAMS_DIR: "/tmp/streams-mock",
}));

import { stopSession } from "../session.ts";
import { activePrompts } from "../session-chat-binding.ts";

function seedRunningSession(
  sid: string,
  accumulated = "partial output",
  closeSession?: () => void,
): AbortController {
  const controller = new AbortController();
  activePrompts.set(sid, { controller, stopped: false, startTime: Date.now(), closeSession });
  stateStore.set(sid, {
    sessionId: sid,
    status: "running",
    accumulatedContent: accumulated,
    finalReply: "",
    chunkCount: 1,
    turnCount: 1,
    contextTokens: 0,
    updatedAt: Date.now(),
    cwd: "F:/repo",
    tool: "codex",
  });
  return controller;
}

async function flush(): Promise<void> {
  // 让 stopSession 内 fire-and-forget 的 microtask 跑完
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
  await new Promise((r) => setTimeout(r, 10));
}

beforeEach(() => {
  activePrompts.clear();
  stateStore.clear();
  writeCalls.length = 0;
});

describe("stopSession 行为护栏", () => {
  it("没有活跃 session 时返回 false，不做任何事", async () => {
    const ok = stopSession("nonexistent");
    expect(ok).toBe(false);
    await flush();
    expect(writeCalls).toHaveLength(0);
  });

  it("abort controller + 立刻把 stream-state.status 写成 stopped", async () => {
    const controller = seedRunningSession("sid-A", "hello world");
    let aborted = false;
    controller.signal.addEventListener("abort", () => { aborted = true; });

    const ok = stopSession("sid-A");
    expect(ok).toBe(true);
    expect(aborted).toBe(true);

    await flush();

    // 关键护栏：必须有一次 writeStreamState 把 status 改成 stopped
    expect(writeCalls.length).toBeGreaterThanOrEqual(1);
    const lastWrite = writeCalls[writeCalls.length - 1];
    expect(lastWrite.sessionId).toBe("sid-A");
    expect(lastWrite.status).toBe("stopped");
    // 累积内容不丢
    expect(lastWrite.accumulatedContent).toBe("hello world");
  });

  it("已经是终态(done/stopped/error)的 stream-state 不会被覆盖", async () => {
    seedRunningSession("sid-B");
    // 模拟 generator finally 已经先写了 done
    stateStore.set("sid-B", {
      ...stateStore.get("sid-B")!,
      status: "done",
    });

    const ok = stopSession("sid-B");
    expect(ok).toBe(true);
    await flush();

    // 不应再有 stopped 覆盖 done 的写入
    const stoppedWrites = writeCalls.filter((w) => w.status === "stopped");
    expect(stoppedWrites).toHaveLength(0);
  });

  it("activePrompts 标记 stopped=true", async () => {
    seedRunningSession("sid-C");
    stopSession("sid-C");
    expect(activePrompts.get("sid-C")?.stopped).toBe(true);
  });

  it("调用 adapter 提供的 closeSession 以主动关闭底层 SDK session", () => {
    const closeSession = vi.fn();
    seedRunningSession("sid-D", "partial output", closeSession);

    const ok = stopSession("sid-D");

    expect(ok).toBe(true);
    expect(closeSession).toHaveBeenCalledTimes(1);
  });
});
