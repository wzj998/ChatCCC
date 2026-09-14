// =============================================================================
// stop-session.test.ts — stopSession 单测护栏
// =============================================================================
// 覆盖修复"幽灵 codex 会话"的两条关键行为：
// 1) controller.abort() 必须被触发（让 adapter finally 走 killProcessTree）
// 2) 清理确认前保留 running 和会话占用，防止“已停止”掩盖残留进程
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StreamState } from "../stream-state.ts";

// mock stream-state，使用模块内可观测的 Map 记录读写
const stateStore = new Map<string, StreamState>();
const writeCalls: StreamState[] = [];
const killProcessTreeMock = vi.hoisted(() => vi.fn(async (_pid?: number) => {}));

vi.mock("../adapters/proc-tree-kill.ts", () => ({
  killProcessTree: killProcessTreeMock,
}));

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
  killProcessTreeMock.mockClear();
});

describe("stopSession 行为护栏", () => {
  it("没有活跃 session 时返回 false，不做任何事", async () => {
    const ok = stopSession("nonexistent");
    expect(ok).toBe(false);
    await flush();
    expect(writeCalls).toHaveLength(0);
  });

  it("abort controller 后保持 running，直到 adapter 确认清理完成", async () => {
    const controller = seedRunningSession("sid-A", "hello world");
    let aborted = false;
    controller.signal.addEventListener("abort", () => { aborted = true; });

    const ok = stopSession("sid-A");
    expect(ok).toBe(true);
    expect(aborted).toBe(true);

    await flush();

    expect(writeCalls).toHaveLength(0);
    expect(stateStore.get("sid-A")?.status).toBe("running");
    expect(stateStore.get("sid-A")?.accumulatedContent).toBe("hello world");
    expect(activePrompts.has("sid-A")).toBe(true);
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

  it("按完整进程树停止 CLI，不先杀壳进程造成后代进程逃逸", async () => {
    seedRunningSession("sid-tree");
    activePrompts.get("sid-tree")!.processPid = 4242;
    const processKillSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    try {
      expect(stopSession("sid-tree")).toBe(true);
      await flush();

      expect(killProcessTreeMock).toHaveBeenCalledWith(4242);
      expect(processKillSpy).not.toHaveBeenCalled();
    } finally {
      processKillSpy.mockRestore();
    }
  });
});
