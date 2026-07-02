import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BuiltinContextManager,
  estimateBuiltinContextTokens,
  listBuiltinContextSessions,
  newBuiltinSessionId,
  serializeMessagesForSummary,
} from "../builtin/context.ts";

describe("BuiltinContextManager", () => {
  it("persists and restores summary, messages, and total message count", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chatccc-builtin-context-"));

    const first = new BuiltinContextManager({
      persist: true,
      contextDir: dir,
      sessionId: "persisted",
    });
    first.setSummary("## 用户目标\n- 保留这个摘要");
    first.appendMessage({ role: "user", content: "第一轮" });
    first.appendMessage({ role: "assistant", content: "第一轮回复" });
    first.save();

    const restored = new BuiltinContextManager({
      persist: true,
      contextDir: dir,
      sessionId: "persisted",
    });

    expect(restored.summary).toContain("保留这个摘要");
    expect(restored.messages).toEqual([
      { role: "user", content: "第一轮" },
      { role: "assistant", content: "第一轮回复" },
    ]);
    expect(restored.totalMessages).toBe(2);
  });

  it("selects only older messages for compaction and keeps recent messages raw", () => {
    const context = new BuiltinContextManager({
      compactAtTokens: 1,
      keepRecentMessages: 2,
      persist: false,
    });
    context.appendMessage({ role: "user", content: "旧用户消息" });
    context.appendMessage({ role: "assistant", content: "旧助手回复" });
    context.appendMessage({ role: "user", content: "近期用户消息" });
    context.appendMessage({ role: "assistant", content: "近期助手回复" });

    const plan = context.planCompaction();

    expect(plan).not.toBeNull();
    expect(plan?.oldMessages).toEqual([
      { role: "user", content: "旧用户消息" },
      { role: "assistant", content: "旧助手回复" },
    ]);
    expect(plan?.recentMessages).toEqual([
      { role: "user", content: "近期用户消息" },
      { role: "assistant", content: "近期助手回复" },
    ]);
  });

  it("applies a compacted summary and builds model messages with summary plus recent raw turns", () => {
    const context = new BuiltinContextManager({
      compactAtTokens: 1,
      keepRecentMessages: 1,
      persist: false,
    });
    context.appendMessage({ role: "user", content: "old" });
    context.appendMessage({ role: "assistant", content: "recent" });

    const plan = context.planCompaction();
    expect(plan).not.toBeNull();
    context.applyCompaction("## 当前任务状态\n- 已压缩旧上下文", plan!);

    expect(context.summary).toContain("已压缩旧上下文");
    expect(context.messages).toEqual([{ role: "assistant", content: "recent" }]);
    expect(context.buildModelMessages()).toEqual([
      {
        role: "user",
        content: expect.stringContaining("较早对话摘要"),
      },
      { role: "assistant", content: "recent" },
    ]);
  });

  it("reset clears memory and the persisted context file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chatccc-builtin-context-reset-"));
    const context = new BuiltinContextManager({
      persist: true,
      contextDir: dir,
      sessionId: "reset",
    });
    context.setSummary("summary");
    context.appendMessage({ role: "user", content: "hello" });
    context.save();

    context.reset();

    expect(context.summary).toBe("");
    expect(context.messages).toEqual([]);
    expect(context.totalMessages).toBe(0);

    const raw = await readFile(join(dir, "reset", "context.json"), "utf8");
    const persisted = JSON.parse(raw) as { summary: string; messages: unknown[]; totalMessages: number };
    expect(persisted.summary).toBe("");
    expect(persisted.messages).toEqual([]);
    expect(persisted.totalMessages).toBe(0);
  });

  it("persists cwd metadata and lists saved sessions newest first", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chatccc-builtin-context-list-"));

    const first = new BuiltinContextManager({
      persist: true,
      contextDir: dir,
      sessionId: "older",
      cwd: "C:\\repo-a",
    });
    first.appendMessage({ role: "user", content: "old" });

    const second = new BuiltinContextManager({
      persist: true,
      contextDir: dir,
      sessionId: "newer",
      cwd: "C:\\repo-b",
    });
    second.appendMessage({ role: "user", content: "new" });

    const sessions = listBuiltinContextSessions(dir);

    expect(sessions.map((s) => s.sessionId)).toEqual(["newer", "older"]);
    expect(sessions[0]).toEqual(expect.objectContaining({
      cwd: "C:\\repo-b",
      totalMessages: 1,
      hasSummary: false,
    }));
  });
});

describe("builtin context helpers", () => {
  it("creates readable timestamp-based session ids", () => {
    const id = newBuiltinSessionId(new Date(2026, 6, 2, 12, 15, 30), "a1b2c3");

    expect(id).toBe("session-20260702-121530-a1b2c3");
  });

  it("estimates tokens from summary and messages", () => {
    expect(estimateBuiltinContextTokens("abc", [{ role: "user", content: "abcdef" }]))
      .toBeGreaterThanOrEqual(3);
  });

  it("serializes messages for summarization with stable role labels", () => {
    expect(serializeMessagesForSummary([
      { role: "user", content: "你好" },
      { role: "assistant", content: "收到" },
    ])).toContain("user");
  });
});
