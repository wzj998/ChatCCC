import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeCursorMessage, createCursorAdapter } from "../adapters/cursor-adapter.ts";
import type { UnifiedStreamMessage } from "../adapters/adapter-interface.ts";
import type {
  CursorSessionMeta,
  CursorSessionMetaStore,
} from "../adapters/cursor-session-meta-store.ts";
import { accumulateBlockContent, pickFinalReply, type AccumulatorState } from "../session.ts";

/**
 * 进程内内存版 meta store，用于测试 getSessionInfo / 自动学习行为，避开磁盘 IO。
 * 与文件实现行为一致：set 部分合并、空字段不覆盖。
 */
function createInMemoryMetaStore(
  initial: Record<string, CursorSessionMeta> = {},
): CursorSessionMetaStore & { snapshot(): Record<string, CursorSessionMeta> } {
  const map = new Map<string, CursorSessionMeta>(Object.entries(initial));
  return {
    async get(sid) {
      return map.get(sid);
    },
    async set(sid, partial) {
      const existing = map.get(sid);
      const merged: { cwd?: string; model?: string } = { ...existing };
      if (typeof partial.cwd === "string" && partial.cwd.length > 0) merged.cwd = partial.cwd;
      if (typeof partial.model === "string" && partial.model.length > 0) merged.model = partial.model;
      // cwd 缺失时记录视为不完整（与文件 store 一致：get 会返回 undefined）
      if (!merged.cwd) return;
      map.set(sid, merged.model ? { cwd: merged.cwd, model: merged.model } : { cwd: merged.cwd });
    },
    snapshot() {
      return Object.fromEntries(map);
    },
  };
}

const __dirname = dirname(fileURLToPath(import.meta.url));

function readFixture(name: string): unknown[] {
  const raw = readFileSync(join(__dirname, "fixtures", name), "utf-8");
  return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

// ---------------------------------------------------------------------------
// normalizeCursorMessage — 核心映射逻辑测试（纯函数）
// ---------------------------------------------------------------------------

describe("normalizeCursorMessage", () => {
  // --- assistant messages ---

  it("normalizes assistant message with text block (partial 增量)", () => {
    // 带 timestamp_ms ⇒ partial（增量片段）⇒ 映射为 text（追加语义）
    const result = normalizeCursorMessage({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello world" }],
      },
      timestamp_ms: 1000,
    });
    expect(result).not.toBeNull();
    expect(result!.type).toBe("assistant");
    expect(result!.blocks).toEqual([{ type: "text", text: "Hello world" }]);
  });

  it("normalizes assistant message with thinking block", () => {
    const result = normalizeCursorMessage({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "Let me think..." }],
      },
    });
    expect(result).not.toBeNull();
    expect(result!.blocks).toEqual([{ type: "thinking", thinking: "Let me think..." }]);
  });

  it("normalizes assistant message with tool_use block", () => {
    const result = normalizeCursorMessage({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", name: "read_file", input: { filePath: "/tmp/test" } },
        ],
      },
    });
    expect(result).not.toBeNull();
    expect(result!.blocks).toEqual([
      { type: "tool_use", name: "read_file", input: { filePath: "/tmp/test" } },
    ]);
  });

  it("uses 'unknown' for tool_use without name", () => {
    const result = normalizeCursorMessage({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", input: {} }] },
    });
    expect(result!.blocks[0]).toMatchObject({ type: "tool_use", name: "unknown" });
  });

  it("normalizes assistant message with search_result block", () => {
    const result = normalizeCursorMessage({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "search_result", query: "cursor docs" }],
      },
    });
    expect(result!.blocks).toEqual([{ type: "search_result", query: "cursor docs" }]);
  });

  it("normalizes assistant message with redacted_thinking block", () => {
    const result = normalizeCursorMessage({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "redacted_thinking" }] },
    });
    expect(result!.blocks).toEqual([{ type: "redacted_thinking" }]);
  });

  // --- user messages (tool_result) ---

  it("user 消息中的 text 被丢弃（避免用户输入 echo 污染最终回复）", () => {
    const result = normalizeCursorMessage({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "原始用户输入回放" }],
      },
    });
    expect(result).not.toBeNull();
    expect(result!.type).toBe("user");
    expect(result!.blocks).toEqual([]);
  });

  it("normalizes user message with tool_result block (success)", () => {
    const result = normalizeCursorMessage({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_abc", content: "done", is_error: false },
        ],
      },
    });
    expect(result).not.toBeNull();
    expect(result!.type).toBe("user");
    expect(result!.blocks).toEqual([
      { type: "tool_result", tool_use_id: "call_abc", content: "done", is_error: false },
    ]);
  });

  it("normalizes user message with tool_result block (error)", () => {
    const result = normalizeCursorMessage({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_err", content: "fail", is_error: true },
        ],
      },
    });
    expect(result!.blocks).toEqual([
      { type: "tool_result", tool_use_id: "call_err", content: "fail", is_error: true },
    ]);
  });

  // --- mixed blocks ---

  it("normalizes message with multiple block types", () => {
    const result = normalizeCursorMessage({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Hmm..." },
          { type: "tool_use", name: "search", input: { query: "x" } },
          { type: "text", text: "Result found." },
        ],
      },
      timestamp_ms: 1000,
    });
    expect(result).not.toBeNull();
    expect(result!.blocks).toHaveLength(3);
  });

  // --- edge cases ---

  // 注：result 消息映射为 text_final 的覆盖见下方 "result 消息" describe 块。

  it("returns null for system init messages", () => {
    expect(
      normalizeCursorMessage({
        type: "system",
        subtype: "init",
        session_id: "abc",
      }),
    ).toBeNull();
  });

  it("returns null for unknown message types", () => {
    expect(normalizeCursorMessage({ type: "unknown_type" })).toBeNull();
    expect(normalizeCursorMessage({})).toBeNull();
  });

  it("skips unknown block types in content", () => {
    const result = normalizeCursorMessage({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "custom_block", data: "ignored" },
          { type: "text", text: "visible" },
        ],
      },
      timestamp_ms: 1000,
    });
    expect(result!.blocks).toEqual([{ type: "text", text: "visible" }]);
  });

  it("returns message with empty blocks for empty content array", () => {
    const result = normalizeCursorMessage({
      type: "assistant",
      message: { role: "assistant", content: [] },
    });
    expect(result).not.toBeNull();
    expect(result!.blocks).toEqual([]);
  });

  it("returns null for message without content", () => {
    const result = normalizeCursorMessage({
      type: "assistant",
      message: { role: "assistant" },
    });
    expect(result).toBeNull();
  });

  it("skips thinking block with empty string", () => {
    const result = normalizeCursorMessage({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "" }] },
    });
    expect(result!.blocks).toEqual([]);
  });

  it("skips text block with empty string", () => {
    const result = normalizeCursorMessage({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "" }] },
    });
    expect(result!.blocks).toEqual([]);
  });

  it("returns null for system message without compact_boundary subtype", () => {
    expect(
      normalizeCursorMessage({ type: "system", subtype: "notification" }),
    ).toBeNull();
  });

  it("normalizes system compact_boundary message", () => {
    const msg: Record<string, unknown> = {
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 15000, post_tokens: 8000 },
    };
    const result = normalizeCursorMessage(
      msg as Parameters<typeof normalizeCursorMessage>[0],
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe("system");
    expect(result!.blocks).toEqual([
      { type: "compact_boundary", trigger: "auto", pre_tokens: 15000, post_tokens: 8000 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// createCursorAdapter — 工厂函数测试
// ---------------------------------------------------------------------------

describe("createCursorAdapter", () => {
  it("returns adapter with correct displayName and sessionDescPrefix", () => {
    const adapter = createCursorAdapter();
    expect(adapter.displayName).toBe("Cursor");
    expect(adapter.sessionDescPrefix).toBe("Cursor Session:");
  });

  it("closeSession does not throw", async () => {
    const adapter = createCursorAdapter();
    await expect(adapter.closeSession("any-id")).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // getSessionInfo 行为契约
  //   - cwd 决定 /git 是否可用
  //   - model 决定 /state、/sessions 显示的是否是 Cursor 真实模型
  // -------------------------------------------------------------------------

  it("getSessionInfo: store 中无该 sessionId 时只返回 sessionId（cwd / model 都 undefined，让上层走错误分支）", async () => {
    const store = createInMemoryMetaStore();
    const adapter = createCursorAdapter({ metaStore: store });
    const info = await adapter.getSessionInfo("unknown-sid");
    expect(info).toEqual({ sessionId: "unknown-sid" });
    expect(info?.cwd).toBeUndefined();
    expect(info?.model).toBeUndefined();
  });

  it("getSessionInfo: store 仅有 cwd 时返回 cwd，model 仍为 undefined（防止显示陈旧/错误模型）", async () => {
    const store = createInMemoryMetaStore({ "sid-known": { cwd: "F:/proj/Foo" } });
    const adapter = createCursorAdapter({ metaStore: store });
    const info = await adapter.getSessionInfo("sid-known");
    expect(info).toEqual({ sessionId: "sid-known", cwd: "F:/proj/Foo" });
    expect(info?.model).toBeUndefined();
  });

  it("getSessionInfo: store 同时有 cwd + model 时一并返回（这是 /state 显示真实模型的关键）", async () => {
    const store = createInMemoryMetaStore({
      "sid-known": { cwd: "F:/proj/Foo", model: "Composer 2 Fast" },
    });
    const adapter = createCursorAdapter({ metaStore: store });
    const info = await adapter.getSessionInfo("sid-known");
    expect(info).toEqual({
      sessionId: "sid-known",
      cwd: "F:/proj/Foo",
      model: "Composer 2 Fast",
    });
  });

  it("getSessionInfo: 不同 sessionId 互不影响", async () => {
    const store = createInMemoryMetaStore({
      "sid-A": { cwd: "/a", model: "mA" },
      "sid-B": { cwd: "/b" },
    });
    const adapter = createCursorAdapter({ metaStore: store });
    expect(await adapter.getSessionInfo("sid-A")).toEqual({
      sessionId: "sid-A",
      cwd: "/a",
      model: "mA",
    });
    expect(await adapter.getSessionInfo("sid-B")).toEqual({
      sessionId: "sid-B",
      cwd: "/b",
    });
    expect(await adapter.getSessionInfo("sid-C")).toEqual({ sessionId: "sid-C" });
  });
});

// ---------------------------------------------------------------------------
// partial vs final 区分（防止最终消息重复出现两段）
// ---------------------------------------------------------------------------
//
// Cursor CLI 在 `--stream-partial-output` 模式下：
//   - partial 消息带 `timestamp_ms` 字段，content 是 delta 增量
//   - 流结束时再发一条 final 消息（无 `timestamp_ms`），content 是完整文本
// 若 normalize 时不区分这两种，accumulateBlockContent 会把所有 text 累加，
// 导致最终 finalText = (partial 拼接的完整) + (final 完整) ⇒ 同一段重复两次。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Cursor stream-json 三类 assistant 事件 + result 消息的区分
//
// 官方文档：cursor.com/docs/cli/reference/output-format
//   ┌───────────────────┬───────────────┬─────────────────┐
//   │ 种类               │ timestamp_ms  │ model_call_id   │
//   ├───────────────────┼───────────────┼─────────────────┤
//   │ Streaming delta   │ 有             │ 无               │ ← 唯一带新文本
//   │ Buffered flush    │ 有             │ 有               │ ← 重复（工具调用前快照）
//   │ Final flush       │ 无             │ 无               │ ← 重复（回合末快照）
//   └───────────────────┴───────────────┴─────────────────┘
// 文档建议：取最终结果应直接读 result 消息的 result 字段。
// ---------------------------------------------------------------------------

describe("normalizeCursorMessage - 三类 assistant 事件区分", () => {
  it("Streaming delta（has timestamp_ms, no model_call_id）→ text（追加）", () => {
    const result = normalizeCursorMessage({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "你" }] },
      timestamp_ms: 1778411927583,
    });
    expect(result).not.toBeNull();
    expect(result!.blocks).toEqual([{ type: "text", text: "你" }]);
  });

  it("Buffered flush（has timestamp_ms, has model_call_id）→ text_final（覆盖，避免与 delta 重复累加）", () => {
    const result = normalizeCursorMessage({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "完整快照（与 delta 累计相同）" }],
      },
      timestamp_ms: 1778411927999,
      model_call_id: "mc-1",
    } as Parameters<typeof normalizeCursorMessage>[0]);
    expect(result).not.toBeNull();
    expect(result!.blocks).toEqual([
      { type: "text_final", text: "完整快照（与 delta 累计相同）" },
    ]);
  });

  it("Final flush（no timestamp_ms）→ text_final（覆盖）", () => {
    const result = normalizeCursorMessage({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "你上一题问的是 1+2=?" }],
      },
    });
    expect(result).not.toBeNull();
    expect(result!.blocks).toEqual([
      { type: "text_final", text: "你上一题问的是 1+2=?" },
    ]);
  });
});

describe("normalizeCursorMessage - result 消息（官方权威最终文本）", () => {
  it("result 消息提取 result 字段映射为 assistant + text_final", () => {
    const result = normalizeCursorMessage({
      type: "result",
      subtype: "success",
      result: "权威最终文本",
    });
    expect(result).not.toBeNull();
    expect(result!.type).toBe("assistant");
    expect(result!.blocks).toEqual([
      { type: "text_final", text: "权威最终文本" },
    ]);
  });

  it("result 消息没有 result 字段时返回 null（无可用文本）", () => {
    expect(
      normalizeCursorMessage({ type: "result", subtype: "error" }),
    ).toBeNull();
  });

  it("result 消息 result 字段为空字符串时返回 null", () => {
    expect(
      normalizeCursorMessage({ type: "result", subtype: "success", result: "" }),
    ).toBeNull();
  });
});

describe("Cursor stream fixture - 端到端不重复", () => {
  it("partial+final 流结束后最终回复只包含一段完整文本（不重复）", () => {
    const lines = readFixture("cursor_partial_with_final.jsonl");
    const state: AccumulatorState = {
      accumulatedContent: "",
      finalText: "",
      finalCompleteText: "",
      chunkCount: 0,
    };
    for (const raw of lines) {
      const normalized = normalizeCursorMessage(
        raw as Parameters<typeof normalizeCursorMessage>[0],
      );
      if (!normalized) continue;
      for (const block of normalized.blocks) {
        accumulateBlockContent(block, state);
      }
    }

    const expected = "你上一题问的是 **1+2=?**(一加二等于几)。";
    const reply = pickFinalReply(state);
    expect(reply).toBe(expected);
    // 关键断言：长度等于完整文本，不应翻倍
    expect(reply.length).toBe(expected.length);
  });

  it("仅 partial 无 final 时，回复 = partial 累加结果", () => {
    const lines = readFixture("cursor_partial_only.jsonl");
    const state: AccumulatorState = {
      accumulatedContent: "",
      finalText: "",
      finalCompleteText: "",
      chunkCount: 0,
    };
    for (const raw of lines) {
      const normalized = normalizeCursorMessage(
        raw as Parameters<typeof normalizeCursorMessage>[0],
      );
      if (!normalized) continue;
      for (const block of normalized.blocks) {
        accumulateBlockContent(block, state);
      }
    }

    // 注：fixture 末尾有 result 消息，按官方语义其 result 字段是权威最终文本
    expect(pickFinalReply(state)).toBe("hello world");
  });

  it("有工具调用回合（含 buffered flush）最终回复仍取 result.result，无重复", () => {
    const lines = readFixture("cursor_with_tool_call.jsonl");
    const state: AccumulatorState = {
      accumulatedContent: "",
      finalText: "",
      finalCompleteText: "",
      chunkCount: 0,
    };
    for (const raw of lines) {
      const normalized = normalizeCursorMessage(
        raw as Parameters<typeof normalizeCursorMessage>[0],
      );
      if (!normalized) continue;
      for (const block of normalized.blocks) {
        accumulateBlockContent(block, state);
      }
    }

    const expected = "我看下。两个文件。";
    const reply = pickFinalReply(state);
    expect(reply).toBe(expected);
    // 关键断言：buffered flush 不会让回复变长（不重复）
    expect(reply.length).toBe(expected.length);
  });

  it("buffered flush 之后的新增量文本不会被 pickFinalReply 吞掉", () => {
    // 模拟流中间状态：buffered flush 设置了 finalCompleteText，然后新的
    // 增量 text 到达。之前有个 bug 是 pickFinalReply 一直返回旧的
    // finalCompleteText，导致工具调用后的新文本在卡片中不可见。
    const state: AccumulatorState = {
      accumulatedContent: "",
      finalText: "",
      finalCompleteText: "",
      chunkCount: 0,
    };

    // 1) 工具调用前的增量（同 cursor_with_tool_call.jsonl lines 3-5）
    accumulateBlockContent({ type: "text", text: "我" }, state);
    accumulateBlockContent({ type: "text", text: "看下" }, state);
    accumulateBlockContent({ type: "text", text: "。" }, state);
    expect(state.finalText).toBe("我看下。");

    // 2) buffered flush 快照（含 tool_use，line 6）
    accumulateBlockContent({ type: "text_final", text: "我看下。" }, state);
    accumulateBlockContent({ type: "tool_use", name: "ls", input: { path: "." } }, state);
    expect(state.finalCompleteText).toBe("我看下。");
    // 此时 finalText 已经包含了与 flush 相同的文本
    expect(pickFinalReply(state)).toBe("我看下。");

    // 3) tool_result（line 7）
    accumulateBlockContent({ type: "tool_result", tool_use_id: "tool-1", content: "file1\nfile2", is_error: false }, state);

    // 4) 工具调用后的新增量（lines 8-9）：关键断言
    accumulateBlockContent({ type: "text", text: "两" }, state);
    // 新的增量 text 应清空 finalCompleteText，pickFinalReply 回退到 finalText
    expect(state.finalCompleteText).toBe("");
    expect(state.finalText).toBe("我看下。两");
    expect(pickFinalReply(state)).toBe("我看下。两");

    accumulateBlockContent({ type: "text", text: "个文件" }, state);
    expect(pickFinalReply(state)).toBe("我看下。两个文件");
  });

  // -------------------------------------------------------------------------
  // 新格式：独立的 thinking 和 tool_call 消息（Cursor agent 实际发出的格式）
  // -------------------------------------------------------------------------

  it("normalizes independent thinking delta message", () => {
    const result = normalizeCursorMessage({
      type: "thinking",
      subtype: "delta",
      text: " Let me think...",
      session_id: "sid",
      timestamp_ms: 1000,
    } as Parameters<typeof normalizeCursorMessage>[0]);
    expect(result).not.toBeNull();
    expect(result!.blocks).toEqual([
      { type: "thinking", thinking: " Let me think..." },
    ]);
  });

  it("ignores thinking completed message", () => {
    const result = normalizeCursorMessage({
      type: "thinking",
      subtype: "completed",
      session_id: "sid",
    });
    expect(result).toBeNull();
  });

  it("normalizes tool_call started → tool_use block", () => {
    const result = normalizeCursorMessage({
      type: "tool_call",
      subtype: "started",
      call_id: "toolu_abc",
      tool_call: {
        shellToolCall: {
          args: { command: "ls" },
          description: "List files",
        },
      },
      session_id: "sid",
      timestamp_ms: 1000,
    } as Parameters<typeof normalizeCursorMessage>[0]);
    expect(result).not.toBeNull();
    expect(result!.blocks).toEqual([
      { type: "tool_use", name: "Bash", input: { command: "ls" } },
    ]);
  });

  it("normalizes tool_call completed → tool_result block (success)", () => {
    const result = normalizeCursorMessage({
      type: "tool_call",
      subtype: "completed",
      call_id: "toolu_abc",
      tool_call: {
        shellToolCall: {
          args: { command: "ls" },
          result: { success: { stdout: "file1\nfile2" } },
        },
      },
      session_id: "sid",
    } as Parameters<typeof normalizeCursorMessage>[0]);
    expect(result).not.toBeNull();
    expect(result!.blocks[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "toolu_abc",
      content: "file1\nfile2",
      is_error: undefined,
    });
  });

  it("normalizes tool_call completed → tool_result block (error)", () => {
    const result = normalizeCursorMessage({
      type: "tool_call",
      subtype: "completed",
      call_id: "toolu_err",
      tool_call: {
        readToolCall: {
          args: { filePath: "/nonexistent" },
          result: { error: "file not found" },
        },
      },
    } as Parameters<typeof normalizeCursorMessage>[0]);
    expect(result).not.toBeNull();
    expect(result!.blocks[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "toolu_err",
      is_error: true,
    });
  });

  it("mapToolCallKey: maps known keys to readable names", () => {
    const cases: [string, string][] = [
      ["globToolCall", "Glob"],
      ["shellToolCall", "Bash"],
      ["readToolCall", "Read"],
      ["grepToolCall", "Grep"],
      ["unknownCall", "unknownCall"],
    ];
    for (const [raw, expected] of cases) {
      const r = normalizeCursorMessage({
        type: "tool_call",
        subtype: "started",
        call_id: "id",
        tool_call: { [raw]: { args: {} } },
      } as Parameters<typeof normalizeCursorMessage>[0]);
      expect(r!.blocks[0]).toMatchObject({ type: "tool_use", name: expected });
    }
  });
});