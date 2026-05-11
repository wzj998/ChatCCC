import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeCodexMessage,
  createCodexAdapter,
  type CreateCodexAdapterOptions,
} from "../adapters/codex-adapter.ts";
import type { UnifiedStreamMessage } from "../adapters/adapter-interface.ts";
import {
  type CodexSessionMeta,
  type CodexSessionMetaStore,
} from "../adapters/codex-session-meta-store.ts";
import { accumulateBlockContent, pickFinalReply, type AccumulatorState } from "../session.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readFixture(name: string): unknown[] {
  const raw = readFileSync(join(__dirname, "fixtures", name), "utf-8");
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

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
// normalizeCodexMessage — 核心映射逻辑测试（纯函数）
// ---------------------------------------------------------------------------

describe("normalizeCodexMessage", () => {
  it("normalizes agent_message into assistant text block", () => {
    const result = normalizeCodexMessage({
      type: "item.completed",
      item: { id: "item_0", type: "agent_message", text: "hello" },
    });
    expect(result).not.toBeNull();
    expect(result!.type).toBe("assistant");
    expect(result!.blocks).toEqual([{ type: "text", text: "hello" }]);
  });

  it("normalizes command_execution start into tool_use block", () => {
    const result = normalizeCodexMessage({
      type: "item.started",
      item: {
        id: "item_0",
        type: "command_execution",
        command: "powershell.exe -Command ls",
        status: "in_progress",
      },
    });
    expect(result).not.toBeNull();
    expect(result!.type).toBe("assistant");
    expect(result!.blocks).toEqual([
      { type: "tool_use", name: "Bash", input: { command: "powershell.exe -Command ls" } },
    ]);
  });

  it("normalizes command_execution completion as tool_result (success)", () => {
    const result = normalizeCodexMessage({
      type: "item.completed",
      item: {
        id: "item_0",
        type: "command_execution",
        command: "ls",
        aggregated_output: "file1\nfile2\n",
        exit_code: 0,
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

  it("normalizes command_execution completion as tool_result (error)", () => {
    const result = normalizeCodexMessage({
      type: "item.completed",
      item: {
        id: "item_err",
        type: "command_execution",
        command: "nonexistent",
        aggregated_output: "command not found",
        exit_code: 127,
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

  it("returns null for thread.started events", () => {
    expect(
      normalizeCodexMessage({
        type: "thread.started",
        thread_id: "abc-123",
      }),
    ).toBeNull();
  });

  it("returns null for turn.started events", () => {
    expect(normalizeCodexMessage({ type: "turn.started" })).toBeNull();
  });

  it("returns null for turn.completed events", () => {
    expect(
      normalizeCodexMessage({
        type: "turn.completed",
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    ).toBeNull();
  });

  it("returns null for unknown event types", () => {
    expect(normalizeCodexMessage({ type: "unknown" })).toBeNull();
    expect(normalizeCodexMessage({} as Parameters<typeof normalizeCodexMessage>[0])).toBeNull();
  });

  it("returns null for agent_message with empty text", () => {
    const result = normalizeCodexMessage({
      type: "item.completed",
      item: { id: "item_0", type: "agent_message", text: "" },
    });
    expect(result).toBeNull();
  });

  it("returns null for command_execution start without command text", () => {
    const result = normalizeCodexMessage({
      type: "item.started",
      item: { id: "item_0", type: "command_execution", status: "in_progress" },
    });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Fixture 端到端测试
// ---------------------------------------------------------------------------

describe("Codex stream fixtures", () => {
  it("simple text: 流结束后 pickFinalReply 返回正确文本", () => {
    const lines = readFixture("codex_simple_text.jsonl");
    const state: AccumulatorState = {
      accumulatedContent: "",
      finalText: "",
      finalCompleteText: "",
      chunkCount: 0,
    };
    for (const raw of lines) {
      const normalized = normalizeCodexMessage(
        raw as Parameters<typeof normalizeCodexMessage>[0],
      );
      if (!normalized) continue;
      for (const block of normalized.blocks) {
        accumulateBlockContent(block, state);
      }
    }

    expect(pickFinalReply(state)).toBe("hello");
  });

  it("with tool: 流结束后 pickFinalReply 返回最终文本（不含工具输出在 finalText 中）", () => {
    const lines = readFixture("codex_with_tool.jsonl");
    const state: AccumulatorState = {
      accumulatedContent: "",
      finalText: "",
      finalCompleteText: "",
      chunkCount: 0,
    };
    for (const raw of lines) {
      const normalized = normalizeCodexMessage(
        raw as Parameters<typeof normalizeCodexMessage>[0],
      );
      if (!normalized) continue;
      for (const block of normalized.blocks) {
        accumulateBlockContent(block, state);
      }
    }

    // finalText 应该只包含最终的 agent_message
    expect(pickFinalReply(state)).toBe("tool_test");
    // accumulatedContent 包含工具调用信息
    expect(state.accumulatedContent).toContain("Bash");
    expect(state.accumulatedContent).toContain("tool_test");
  });

  it("with tool: 只映射 agent_message 和 command_execution，不映射元事件", () => {
    const lines = readFixture("codex_with_tool.jsonl");
    const messages: UnifiedStreamMessage[] = [];
    for (const raw of lines) {
      const normalized = normalizeCodexMessage(
        raw as Parameters<typeof normalizeCodexMessage>[0],
      );
      if (normalized) messages.push(normalized);
    }

    // 应有: tool_use + tool_result + text = 3 条消息
    expect(messages.length).toBe(3);
    expect(messages[0].blocks[0].type).toBe("tool_use");
    expect(messages[1].blocks[0].type).toBe("tool_result");
    expect(messages[2].blocks[0].type).toBe("text");
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