import { describe, it, expect } from "vitest";
import {
  normalizeCodexNotification,
  createCodexAdapter,
} from "../adapters/codex-adapter.ts";
import type { UnifiedStreamMessage } from "../adapters/adapter-interface.ts";
import {
  type CodexSessionMeta,
  type CodexSessionMetaStore,
} from "../adapters/codex-session-meta-store.ts";
import { accumulateBlockContent, pickFinalReply, type AccumulatorState } from "../session.ts";

// 进程内内存版 meta store
function createInMemoryMetaStore(
  initial: Record<string, CodexSessionMeta> = {},
): CodexSessionMetaStore & { snapshot(): Record<string, CodexSessionMeta> } {
  const map = new Map<string, CodexSessionMeta>(Object.entries(initial));
  return {
    async get(sid) {
      return map.get(sid);
    },
    async set(sid, partial) {
      const existing = map.get(sid) ?? { cwd: "" };
      const merged: CodexSessionMeta = { ...existing, ...partial };
      if (typeof merged.cwd !== "string" || merged.cwd.length === 0) return;
      map.set(sid, merged);
    },
    async setThreadId(sid, threadId) {
      const existing = map.get(sid);
      if (existing) {
        map.set(sid, { ...existing, threadId });
      }
    },
    snapshot() {
      return Object.fromEntries(map);
    },
  };
}

// ---------------------------------------------------------------------------
// normalizeCodexNotification — app-server 通知映射（纯函数）
// ---------------------------------------------------------------------------

describe("normalizeCodexNotification", () => {
  it("normalizes agentMessage into assistant text block", () => {
    const result = normalizeCodexNotification("item/completed", {
      item: { id: "item_0", type: "agentMessage", text: "hello" },
    });
    expect(result).not.toBeNull();
    expect(result!.type).toBe("assistant");
    expect(result!.blocks).toEqual([{ type: "text", text: "hello" }]);
    expect(result!.isFinalResponse).toBeUndefined();
  });

  it("normalizes commandExecution start into tool_use block", () => {
    const result = normalizeCodexNotification("item/started", {
      item: {
        id: "item_0",
        type: "commandExecution",
        command: "powershell.exe -Command ls",
        status: "in_progress",
      },
    });
    expect(result).not.toBeNull();
    expect(result!.type).toBe("assistant");
    expect(result!.blocks).toEqual([
      { type: "tool_use", id: "item_0", name: "Bash", input: { command: "powershell.exe -Command ls" } },
    ]);
  });

  it("normalizes commandExecution completion as tool_result (success)", () => {
    const result = normalizeCodexNotification("item/completed", {
      item: {
        id: "item_0",
        type: "commandExecution",
        command: "ls",
        aggregatedOutput: "file1\nfile2\n",
        exitCode: 0,
        status: "completed",
      },
    });
    expect(result).not.toBeNull();
    expect(result!.blocks).toEqual([
      {
        type: "tool_result",
        tool_use_id: "item_0",
        content: "file1\nfile2\n",
        is_error: undefined,
      },
    ]);
  });

  it("normalizes commandExecution completion as tool_result (error)", () => {
    const result = normalizeCodexNotification("item/completed", {
      item: {
        id: "item_err",
        type: "commandExecution",
        command: "nonexistent",
        aggregatedOutput: "command not found",
        exitCode: 127,
        status: "completed",
      },
    });
    expect(result).not.toBeNull();
    expect(result!.blocks).toEqual([
      {
        type: "tool_result",
        tool_use_id: "item_err",
        content: "command not found",
        is_error: true,
      },
    ]);
  });

  it("returns null for thread/started notifications", () => {
    expect(normalizeCodexNotification("thread/started", { thread: { id: "abc-123" } })).toBeNull();
  });

  it("returns null for turn/started notifications", () => {
    expect(normalizeCodexNotification("turn/started", { turn: { id: "t1", status: "inProgress" } })).toBeNull();
  });

  it("returns null for item/agentMessage/delta (streaming text ignored;整段 agentMessage 才是正文)", () => {
    expect(
      normalizeCodexNotification("item/agentMessage/delta", { itemId: "i1", delta: "partial" }),
    ).toBeNull();
  });

  it("surfaces fatal error notifications (willRetry=false)", () => {
    expect(() =>
      normalizeCodexNotification("error", {
        error: { message: "Selected model is at capacity. Please try a different model." },
        willRetry: false,
      }),
    ).toThrow("Selected model is at capacity. Please try a different model.");
  });

  it("ignores transient error notifications (willRetry=true)", () => {
    expect(
      normalizeCodexNotification("error", {
        error: { message: "transient hiccup" },
        willRetry: true,
      }),
    ).toBeNull();
  });

  it("surfaces turn/completed with status=failed", () => {
    expect(() =>
      normalizeCodexNotification("turn/completed", {
        turn: { id: "t1", status: "failed", error: { message: "request failed after partial output" } },
      }),
    ).toThrow("request failed after partial output");
  });

  it("marks turn/completed (status=completed) as the authoritative final response", () => {
    expect(
      normalizeCodexNotification("turn/completed", {
        turn: { id: "t1", status: "completed" },
      }),
    ).toEqual({
      type: "assistant",
      blocks: [],
      isFinalResponse: true,
    });
  });

  it("marks turn/completed (status=interrupted) as final response too", () => {
    expect(
      normalizeCodexNotification("turn/completed", {
        turn: { id: "t1", status: "interrupted" },
      }),
    ).toEqual({
      type: "assistant",
      blocks: [],
      isFinalResponse: true,
    });
  });

  it("returns null for unknown notification methods", () => {
    expect(normalizeCodexNotification("unknown", {})).toBeNull();
  });

  it("returns null for agentMessage with empty text", () => {
    const result = normalizeCodexNotification("item/completed", {
      item: { id: "item_0", type: "agentMessage", text: "" },
    });
    expect(result).toBeNull();
  });

  it("returns null for commandExecution start without command text", () => {
    const result = normalizeCodexNotification("item/started", {
      item: { id: "item_0", type: "commandExecution", status: "in_progress" },
    });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 端到端事件流测试（app-server 通知格式）
// ---------------------------------------------------------------------------

type AppServerEvent = [method: string, params: Record<string, unknown>];

function runEvents(events: AppServerEvent[], state: AccumulatorState): UnifiedStreamMessage[] {
  const messages: UnifiedStreamMessage[] = [];
  for (const [method, params] of events) {
    const normalized = normalizeCodexNotification(method, params);
    if (normalized) {
      messages.push(normalized);
      for (const block of normalized.blocks) accumulateBlockContent(block, state);
    }
  }
  return messages;
}

describe("Codex app-server stream", () => {
  it("fails the turn when turn/completed status=failed arrives after partial output", () => {
    const state: AccumulatorState = {
      accumulatedContent: "",
      finalText: "",
      finalCompleteText: "",
      chunkCount: 0,
    };
    const events: AppServerEvent[] = [
      ["item/completed", { item: { type: "agentMessage", text: "partial reply" } }],
      ["turn/completed", { turn: { status: "failed", error: { message: "model became unavailable" } } }],
    ];

    expect(() => runEvents(events, state)).toThrow("model became unavailable");
    expect(pickFinalReply(state)).toBe("partial reply");
  });

  it("simple text: 流结束后 pickFinalReply 返回正确文本", () => {
    const state: AccumulatorState = {
      accumulatedContent: "",
      finalText: "",
      finalCompleteText: "",
      chunkCount: 0,
    };
    const events: AppServerEvent[] = [
      ["item/completed", { item: { type: "agentMessage", text: "hello" } }],
      ["turn/completed", { turn: { status: "completed" } }],
    ];
    runEvents(events, state);
    expect(pickFinalReply(state)).toBe("hello");
  });

  it("with tool: 流结束后 pickFinalReply 返回最终文本（不含工具输出在 finalText 中）", () => {
    const state: AccumulatorState = {
      accumulatedContent: "",
      finalText: "",
      finalCompleteText: "",
      chunkCount: 0,
    };
    const events: AppServerEvent[] = [
      ["item/started", { item: { id: "i1", type: "commandExecution", command: "powershell.exe -Command echo tool_test" } }],
      ["item/completed", { item: { id: "i1", type: "commandExecution", aggregatedOutput: "tool_test\r\n", exitCode: 0 } }],
      ["item/completed", { item: { id: "i2", type: "agentMessage", text: "tool_test" } }],
      ["turn/completed", { turn: { status: "completed" } }],
    ];
    runEvents(events, state);
    expect(pickFinalReply(state)).toBe("tool_test");
    expect(state.accumulatedContent).toContain("Bash");
    expect(state.accumulatedContent).toContain("tool_test");
  });

  it("with tool: 普通输出不标终态，只有 turn/completed 标记终态", () => {
    const events: AppServerEvent[] = [
      ["item/started", { item: { id: "i1", type: "commandExecution", command: "ls" } }],
      ["item/completed", { item: { id: "i1", type: "commandExecution", aggregatedOutput: "a", exitCode: 0 } }],
      ["item/completed", { item: { id: "i2", type: "agentMessage", text: "tool_test" } }],
      ["turn/completed", { turn: { status: "completed" } }],
    ];
    const messages: UnifiedStreamMessage[] = [];
    for (const [method, params] of events) {
      const normalized = normalizeCodexNotification(method, params);
      if (normalized) messages.push(normalized);
    }

    // 应有: tool_use + tool_result + text + turn.completed = 4 条消息
    expect(messages.length).toBe(4);
    expect(messages[0].blocks[0].type).toBe("tool_use");
    expect(messages[1].blocks[0].type).toBe("tool_result");
    expect(messages[2].blocks[0].type).toBe("text");
    expect(messages[2].isFinalResponse).toBeUndefined();
    expect(messages[3]).toEqual({
      type: "assistant",
      blocks: [],
      isFinalResponse: true,
    });
  });
});

// ---------------------------------------------------------------------------
// createCodexAdapter — 工厂函数测试
// ---------------------------------------------------------------------------

describe("createCodexAdapter", () => {
  it("returns adapter with correct displayName and sessionDescPrefix", () => {
    const adapter = createCodexAdapter();
    expect(adapter.displayName).toBe("Codex");
    expect(adapter.sessionDescPrefix).toBe("Codex Session:");
  });

  it("closeSession does not throw", async () => {
    const adapter = createCodexAdapter();
    await expect(adapter.closeSession("any-id")).resolves.toBeUndefined();
  });

  it("getSessionInfo: store 中无该 sessionId 时返回 undefined", async () => {
    const store = createInMemoryMetaStore();
    const adapter = createCodexAdapter({ metaStore: store });
    const info = await adapter.getSessionInfo("unknown-sid");
    expect(info).toBeUndefined();
  });

  it("getSessionInfo: store 有 cwd 时返回 cwd，无 threadId", async () => {
    const store = createInMemoryMetaStore({
      "sid-known": { cwd: "F:/proj/Foo" },
    });
    const adapter = createCodexAdapter({ metaStore: store });
    const info = await adapter.getSessionInfo("sid-known");
    expect(info).toEqual({ sessionId: "sid-known", cwd: "F:/proj/Foo" });
  });

  it("getSessionInfo: 有 cwd + threadId 时一并返回", async () => {
    const store = createInMemoryMetaStore({
      "sid-known": { cwd: "F:/proj/Foo", threadId: "thread-123" },
    });
    const adapter = createCodexAdapter({ metaStore: store });
    const info = await adapter.getSessionInfo("sid-known");
    expect(info).toEqual({
      sessionId: "sid-known",
      cwd: "F:/proj/Foo",
    });
  });

  it("getSessionInfo: 不同 sessionId 互不影响", async () => {
    const store = createInMemoryMetaStore({
      "sid-A": { cwd: "/a", threadId: "tA" },
      "sid-B": { cwd: "/b" },
    });
    const adapter = createCodexAdapter({ metaStore: store });
    expect(await adapter.getSessionInfo("sid-A")).toEqual({
      sessionId: "sid-A",
      cwd: "/a",
    });
    expect(await adapter.getSessionInfo("sid-B")).toEqual({
      sessionId: "sid-B",
      cwd: "/b",
    });
    expect(await adapter.getSessionInfo("sid-C")).toBeUndefined();
  });
});
