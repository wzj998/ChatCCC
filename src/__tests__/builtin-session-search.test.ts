import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { searchBuiltinSessions } from "../builtin/session-search.ts";

interface TestMessage {
  role: "user" | "assistant";
  content: string;
  toolCalls?: Array<{ name: string; input?: string; output?: string; is_error?: boolean }>;
}

async function writeContextSession(
  contextDir: string,
  sessionId: string,
  state: { summary?: string; messages?: TestMessage[] },
): Promise<void> {
  const dir = join(contextDir, sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "context.json"),
    JSON.stringify({
      version: 1,
      createdAt: 1,
      updatedAt: 2,
      sessionId,
      summary: state.summary ?? "",
      messages: state.messages ?? [],
      totalMessages: (state.messages ?? []).length,
      compactedMessages: 0,
    }),
    "utf8",
  );
}

describe("searchBuiltinSessions (context.json)", () => {
  it("finds matching messages and summary across sessions", async () => {
    const contextDir = await mkdtemp(join(tmpdir(), "deepccc-search-basic-"));
    await writeContextSession(contextDir, "session-a", {
      summary: "## 当前任务\n- 修复飞书卡片渲染",
      messages: [{ role: "user", content: "你好" }],
    });
    await writeContextSession(contextDir, "session-b", {
      messages: [
        { role: "assistant", content: "我修改了飞书卡片组件并运行了测试" },
      ],
    });

    const output = await searchBuiltinSessions("飞书", { contextDir });

    expect(output.terms).toEqual(["飞书"]);
    expect(output.scannedSessions).toBe(2);
    expect(output.matches).toHaveLength(2);
    const sources = output.matches.map((m) => [m.sessionId, m.source]);
    expect(sources).toContainEqual(["session-a", "summary"]);
    expect(sources).toContainEqual(["session-b", "context"]);
    expect(output.matches[1]).toMatchObject({
      sessionId: "session-b",
      source: "context",
      role: "assistant",
      messageIndex: 0,
    });
  });

  it("matches all terms with AND semantics, case-insensitively", async () => {
    const contextDir = await mkdtemp(join(tmpdir(), "deepccc-search-and-"));
    await writeContextSession(contextDir, "both", {
      messages: [{ role: "assistant", content: "DeepCCC deploy 到生产环境成功" }],
    });
    await writeContextSession(contextDir, "one-term", {
      messages: [{ role: "assistant", content: "只提到 deploy" }],
    });

    const output = await searchBuiltinSessions("deepccc deploy", { contextDir });

    expect(output.matches.map((m) => m.sessionId)).toEqual(["both"]);
  });

  it("searches structured tool calls and reports tool indexes", async () => {
    const contextDir = await mkdtemp(join(tmpdir(), "deepccc-search-tools-"));
    await writeContextSession(contextDir, "tool-session", {
      messages: [
        {
          role: "assistant",
          content: "回复正文",
          toolCalls: [
            { name: "run_command", input: "{\"command\":\"npm test\"}", output: "{\"exitCode\":0}" },
            { name: "read_file", input: "{\"path\":\"secret-key.txt\"}" },
          ],
        },
      ],
    });

    const output = await searchBuiltinSessions("secret-key", { contextDir });

    expect(output.matches).toHaveLength(1);
    expect(output.matches[0]).toMatchObject({
      sessionId: "tool-session",
      source: "context",
      messageIndex: 0,
      toolCallIndex: 1,
      toolCallName: "read_file",
    });
    expect(output.matches[0].snippet).toContain("secret-key");
  });

  it("restricts search to an explicit session id", async () => {
    const contextDir = await mkdtemp(join(tmpdir(), "deepccc-search-restrict-"));
    await writeContextSession(contextDir, "keep-me", {
      messages: [{ role: "user", content: "目标关键词 token-xyz" }],
    });
    await writeContextSession(contextDir, "skip-me", {
      messages: [{ role: "user", content: "目标关键词 token-xyz" }],
    });

    const output = await searchBuiltinSessions("token-xyz", {
      contextDir,
      sessionId: "keep-me",
    });

    expect(output.matches.map((m) => m.sessionId)).toEqual(["keep-me"]);
    expect(output.scannedSessions).toBe(1);
  });

  it("caps results and reports truncation", async () => {
    const contextDir = await mkdtemp(join(tmpdir(), "deepccc-search-cap-"));
    for (let index = 0; index < 5; index += 1) {
      await writeContextSession(contextDir, `session-${index}`, {
        messages: [{ role: "user", content: "共同关键词 shared-term" }],
      });
    }

    const output = await searchBuiltinSessions("shared-term", { contextDir, maxResults: 3 });

    expect(output.matches).toHaveLength(3);
    expect(output.truncated).toBe(true);
  });

  it("returns an empty result for empty query or missing directory", async () => {
    const contextDir = await mkdtemp(join(tmpdir(), "deepccc-search-empty-"));
    await writeContextSession(contextDir, "some", {
      messages: [{ role: "user", content: "内容" }],
    });

    const empty = await searchBuiltinSessions("   ", { contextDir });
    expect(empty.matches).toEqual([]);
    expect(empty.truncated).toBe(false);

    const missing = await searchBuiltinSessions("内容", {
      contextDir: join(contextDir, "does-not-exist"),
    });
    expect(missing.matches).toEqual([]);
    expect(missing.scannedSessions).toBe(0);
  });

  it("skips corrupted context files without failing", async () => {
    const contextDir = await mkdtemp(join(tmpdir(), "deepccc-search-corrupt-"));
    await writeContextSession(contextDir, "good", {
      messages: [{ role: "user", content: "可搜索内容 needle-42" }],
    });
    const corruptDir = join(contextDir, "corrupt");
    await mkdir(corruptDir);
    await writeFile(join(corruptDir, "context.json"), "not json{{{", "utf8");

    const output = await searchBuiltinSessions("needle-42", { contextDir });

    expect(output.matches.map((m) => m.sessionId)).toEqual(["good"]);
    expect(output.scannedSessions).toBe(1);
  });
});

describe("searchBuiltinSessions (raw stream logs)", () => {
  it("searches gzipped jsonl logs only when enabled", async () => {
    const contextDir = await mkdtemp(join(tmpdir(), "deepccc-search-raw-context-"));
    const rawLogsDir = await mkdtemp(join(tmpdir(), "deepccc-search-raw-logs-"));
    await writeContextSession(contextDir, "raw-session", {
      messages: [{ role: "user", content: "无关键词" }],
    });

    const sessionDir = join(rawLogsDir, "deepccc", "raw-session");
    await mkdir(sessionDir, { recursive: true });
    const lines = [
      JSON.stringify({ type: "text-delta", text: "普通输出" }),
      JSON.stringify({ type: "tool-call", toolCallId: "c1", toolName: "run_command", input: { command: "git push --force origin" } }),
      JSON.stringify({ type: "tool-result", toolCallId: "c1", toolName: "run_command", output: { exitCode: 0, stdout: "done" } }),
    ];
    await writeFile(join(sessionDir, "2026-08-04T00-00-00-000Z-prompt.jsonl.gz"), gzipSync(lines.join("\n")), "utf8");

    const disabled = await searchBuiltinSessions("git push", {
      contextDir,
      rawLogsDir,
      includeRawLogs: false,
    });
    expect(disabled.matches).toHaveLength(0);

    const enabled = await searchBuiltinSessions("git push", {
      contextDir,
      rawLogsDir,
      includeRawLogs: true,
    });
    expect(enabled.matches).toHaveLength(1);
    expect(enabled.matches[0]).toMatchObject({
      sessionId: "raw-session",
      source: "raw-log",
    });
    expect(enabled.matches[0].snippet).toContain("git push");
    expect(enabled.scannedRawLogFiles).toBe(1);
  });

  it("ignores missing raw log roots", async () => {
    const contextDir = await mkdtemp(join(tmpdir(), "deepccc-search-raw-missing-"));
    await writeContextSession(contextDir, "s", {
      messages: [{ role: "user", content: "关键词 kw-77" }],
    });

    const output = await searchBuiltinSessions("kw-77", {
      contextDir,
      rawLogsDir: join(contextDir, "no-raw-logs"),
      includeRawLogs: true,
    });

    expect(output.matches.map((m) => m.source)).toEqual(["context"]);
    expect(output.scannedRawLogFiles).toBe(0);
  });
});
