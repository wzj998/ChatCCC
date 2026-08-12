import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildPersistedAssistantMessage,
  buildSummaryPrompt,
  BuiltinContextManager,
  estimateBuiltinContextTokens,
  listBuiltinContextSessions,
  newBuiltinSessionId,
  serializeMessagesForSummary,
} from "../context.js";

describe("BuiltinContextManager", () => {
  it("defaults the compaction threshold to 1M x 80% (838,860 tokens) for the default 1M model window", () => {
    const context = new BuiltinContextManager();

    expect(context.compactAtTokens).toBe(838_860);
  });

  it("derives the compaction threshold from the configured context window at 80%", () => {
    const context = new BuiltinContextManager({ contextWindow: 100_000 });
    const explicit = new BuiltinContextManager({ contextWindow: 100_000, compactAtTokens: 42_000 });

    expect(context.compactAtTokens).toBe(80_000);
    // 显式 compactAtTokens 优先于 contextWindow × 0.8 派生值。
    expect(explicit.compactAtTokens).toBe(42_000);
  });

  it("caps existing summaries at 8K chars when rebuilding the compaction prompt", () => {
    const context = new BuiltinContextManager({
      compactAtTokens: 100,
      keepRecentMessages: 1,
      persist: false,
    });
    context.setSummary("previous ".repeat(30_000));
    context.appendMessage({ role: "user", content: "earlier request" });
    context.appendMessage({ role: "user", content: "latest request" });

    const prompt = buildSummaryPrompt(context.planCompaction()!);

    expect(prompt).toContain("已有摘要为压缩而截断");
    expect(prompt.length).toBeLessThan(40_000);
  });

  it("keeps recent messages within the token budget instead of a fixed count", () => {
    const context = new BuiltinContextManager({
      compactAtTokens: 300,
      keepRecentMessages: 16,
      persist: false,
    });
    for (let index = 0; index < 8; index += 1) {
      context.appendMessage({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `${index}:` + "x".repeat(400),
      });
    }

    const plan = context.planCompaction();

    expect(plan).not.toBeNull();
    expect(plan!.recentMessages.length).toBeLessThan(8);
    expect(plan!.recentMessages.at(-1)?.content).toContain("7:");
    expect(estimateBuiltinContextTokens("", plan!.recentMessages)).toBeLessThanOrEqual(300);
  });

  it("bounds oversized source material sent to the compaction model", () => {
    const context = new BuiltinContextManager({
      compactAtTokens: 100,
      keepRecentMessages: 1,
      persist: false,
    });
    context.setSummary("previous ".repeat(30_000));
    context.appendMessage({ role: "assistant", content: "a".repeat(200_000) });
    context.appendMessage({ role: "user", content: "latest request" });

    const prompt = buildSummaryPrompt(context.planCompaction()!);

    expect(prompt.length).toBeLessThan(90_000);
    expect(prompt).toContain("为压缩而截断");
  });

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
      compactAtTokens: 100,
      keepRecentMessages: 2,
      persist: false,
    });
    context.setSummary("x".repeat(500));
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
        content: expect.stringContaining("以下是更早的对话摘要"),
      },
      { role: "assistant", content: "recent" },
    ]);
  });

  it("persists structured tool calls and restores them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chatccc-builtin-context-tools-"));

    const first = new BuiltinContextManager({
      persist: true,
      contextDir: dir,
      sessionId: "tool-persisted",
    });
    first.appendMessage({
      role: "assistant",
      content: "回复\n\n[工具记录]\ntool_call run_command: {}\ntool_result run_command: {}",
      toolCalls: [
        { name: "run_command", input: "{\"command\":\"npm test\"}", output: "{\"exitCode\":0}" },
        { name: "read_file", input: "{\"path\":\"a.ts\"}", output: "...", is_error: true },
      ],
    });
    first.save();

    const restored = new BuiltinContextManager({
      persist: true,
      contextDir: dir,
      sessionId: "tool-persisted",
    });

    expect(restored.messages[0].toolCalls).toEqual([
      { name: "run_command", input: "{\"command\":\"npm test\"}", output: "{\"exitCode\":0}" },
      { name: "read_file", input: "{\"path\":\"a.ts\"}", output: "...", is_error: true },
    ]);
  });

  it("loads legacy context files without toolCalls and filters malformed entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chatccc-builtin-context-legacy-"));
    const state = {
      version: 1,
      createdAt: 1,
      updatedAt: 2,
      sessionId: "legacy",
      summary: "",
      totalMessages: 2,
      compactedMessages: 0,
      messages: [
        { role: "assistant", content: "老消息" },
        {
          role: "assistant",
          content: "带 toolCalls",
          toolCalls: [
            { name: "ok", input: "{\"a\":1}" },
            { name: "" }, // 非法：空 name 应被过滤
            { input: "no-name" }, // 非法：缺 name 应被过滤
            { name: "bad-type", input: 42 }, // 非法：input 非 string 应被忽略字段
          ],
        },
      ],
    };
    await mkdir(join(dir, "legacy"));
    await writeFile(join(dir, "legacy", "context.json"), JSON.stringify(state), "utf8");

    const restored = new BuiltinContextManager({
      persist: true,
      contextDir: dir,
      sessionId: "legacy",
    });

    expect(restored.messages[0].toolCalls).toBeUndefined();
    expect(restored.messages[1].toolCalls).toEqual([
      { name: "ok", input: "{\"a\":1}" },
      { name: "bad-type" },
    ]);
    expect(restored.totalMessages).toBe(2);
  });

  it("builds a persisted assistant message with transcript text plus structured tool calls", () => {
    const message = buildPersistedAssistantMessage({
      fullText: "回复正文",
      transcriptLines: [
        "tool_call run_command: {\"command\":\"npm test\"}",
        "tool_result run_command: {\"exitCode\":0}",
      ],
      toolCalls: [
        { name: "run_command", input: "{\"command\":\"npm test\"}", output: "{\"exitCode\":0}" },
      ],
    });

    expect(message.role).toBe("assistant");
    expect(message.content).toContain("回复正文");
    expect(message.content).toContain("[工具记录]");
    expect(message.content).toContain("tool_call run_command");
    expect(message.toolCalls).toEqual([
      { name: "run_command", input: "{\"command\":\"npm test\"}", output: "{\"exitCode\":0}" },
    ]);
  });

  it("builds a plain assistant message without tool transcript when no tools ran", () => {
    const message = buildPersistedAssistantMessage({
      fullText: "纯文本回复",
      transcriptLines: [],
    });

    expect(message.content).toBe("纯文本回复");
    expect(message.content).not.toContain("[工具记录]");
    expect(message.toolCalls).toBeUndefined();
  });

  it("caps both assistant text and tool transcript in persisted messages", () => {
    const message = buildPersistedAssistantMessage({
      fullText: "a".repeat(10_000),
      transcriptLines: Array.from({ length: 12 }, () => "x".repeat(8_000)),
      maxAssistantChars: 2_000,
      maxTranscriptChars: 4_000,
    });

    expect(message.content.length).toBeLessThan(7_000);
    expect(message.content).toContain("助手回复已在上下文中截断");
    expect(message.content).toContain("工具记录已截断");
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
