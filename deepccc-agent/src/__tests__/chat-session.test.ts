import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../config.js";
import { estimateBuiltinContextTokens } from "../context.js";

const streamTextMock = vi.fn();
const generateTextMock = vi.fn();
const createRawStreamLogMock = vi.fn();
const rawLogWriteLineMock = vi.fn();
const rawLogCloseMock = vi.fn();
const originalRawStreamLogs = structuredClone(config.rawStreamLogs);
const originalStreaming = config.streaming;
const createOpenAICompatibleMock = vi.fn(() => (modelId: string) => ({ modelId }));

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: createOpenAICompatibleMock,
}));

vi.mock("ai", () => ({
  streamText: streamTextMock,
  generateText: generateTextMock,
  isLoopFinished: vi.fn(() => ({ loopFinished: true })),
  stepCountIs: vi.fn((count: number) => ({ count })),
  jsonSchema: vi.fn((schema: unknown) => schema),
  tool: vi.fn((definition: unknown) => definition),
}));

vi.mock("../raw-stream-log.js", () => ({
  createRawStreamLog: createRawStreamLogMock,
}));

async function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

async function* textStream(...chunks: string[]): AsyncIterable<string> {
  for (const chunk of chunks) yield chunk;
}

async function* fullStream(...parts: unknown[]): AsyncIterable<unknown> {
  for (const part of parts) yield part;
}

beforeEach(() => {
  config.streaming = true;
});

afterEach(() => {
  streamTextMock.mockReset();
  generateTextMock.mockReset();
  createRawStreamLogMock.mockReset();
  rawLogWriteLineMock.mockReset();
  rawLogCloseMock.mockReset();
  config.rawStreamLogs = structuredClone(originalRawStreamLogs);
  config.streaming = originalStreaming;
  createOpenAICompatibleMock.mockClear();
  vi.useRealTimers();
});

describe("ChatSession response transport", () => {
  it("asks the provider to include usage in streaming responses", async () => {
    const { ChatSession } = await import("../index.js");

    new ChatSession({ apiKey: "sk-test" });

    expect(createOpenAICompatibleMock).toHaveBeenLastCalledWith(expect.objectContaining({
      includeUsage: true,
    }));
  });

  it("uses generateText and preserves text/tool events when streaming is disabled", async () => {
    const { ChatSession } = await import("../index.js");
    config.streaming = false;
    generateTextMock.mockResolvedValueOnce({
      text: "done",
      steps: [{
        text: "done",
        toolCalls: [{
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "read_file",
          input: { path: "package.json" },
        }],
        toolResults: [{
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "read_file",
          input: { path: "package.json" },
          output: { content: "{}" },
        }],
      }],
    });
    const session = new ChatSession({ apiKey: "sk-test" });

    const events = await collect(session.chat("read package"));

    expect(streamTextMock).not.toHaveBeenCalled();
    expect(generateTextMock).toHaveBeenCalledOnce();
    expect(events).toContainEqual({
      type: "tool_use",
      id: "call-1",
      name: "read_file",
      input: { path: "package.json" },
    });
    expect(events).toContainEqual({
      type: "tool_result",
      tool_use_id: "call-1",
      name: "read_file",
      content: { content: "{}" },
      is_error: false,
    });
    expect(events).toContainEqual({ type: "text", text: "done", accumulated: "done" });
    expect(events).toContainEqual({ type: "done", text: "done" });
  });
});

describe("ChatSession context management", () => {
  it("keeps the generalized evidence gate in the stable system prompt prefix", async () => {
    const { ChatSession } = await import("../index.js");
    const dir = await mkdtemp(join(tmpdir(), "deepccc-session-evidence-gate-"));
    await writeFile(join(dir, "AGENTS.md"), "PROJECT GUIDANCE MARKER", "utf-8");
    streamTextMock.mockReturnValueOnce({ textStream: textStream("done") });

    const session = new ChatSession(
      { apiKey: "sk-test" },
      {
        cwd: dir,
        sessionId: "evidence-gate",
        systemPrompt: "CUSTOM PROMPT MARKER",
      },
    );
    await collect(session.chat("diagnose a consequential problem"));

    const system = streamTextMock.mock.calls.at(-1)?.[0].system as string;
    expect(system).toContain("## Evidence-Gated Conclusions");
    expect(system).toContain("source of truth");
    expect(system).toContain("direct observations from inferences");
    expect(system).toContain("plausible alternative explanations");
    expect(system).toContain("runtime behavior for runtime claims");
    expect(system).toContain("state uncertainty");
    expect(system).toContain("Do not repeat checks once decisive evidence exists");
    expect(system).not.toContain("CodesForUnity");
    expect(system.indexOf("## Evidence-Gated Conclusions")).toBeLessThan(
      system.indexOf("PROJECT GUIDANCE MARKER"),
    );
    expect(system.indexOf("## Evidence-Gated Conclusions")).toBeLessThan(
      system.indexOf("Current working directory"),
    );
    expect(system.indexOf("## Evidence-Gated Conclusions")).toBeLessThan(
      system.indexOf("CUSTOM PROMPT MARKER"),
    );
  });

  it("keeps execution discipline sections in the stable system prompt prefix", async () => {
    const { ChatSession } = await import("../index.js");
    const dir = await mkdtemp(join(tmpdir(), "deepccc-session-discipline-"));
    await writeFile(join(dir, "AGENTS.md"), "PROJECT GUIDANCE MARKER", "utf-8");
    streamTextMock.mockReturnValueOnce({ textStream: textStream("done") });

    const session = new ChatSession(
      { apiKey: "sk-test" },
      {
        cwd: dir,
        sessionId: "execution-discipline",
        systemPrompt: "CUSTOM PROMPT MARKER",
      },
    );
    await collect(session.chat("build a feature"));

    const system = streamTextMock.mock.calls.at(-1)?.[0].system as string;
    // 先盘点再动手：动手前低开销盘点 + 输出含验证策略的计划
    expect(system).toContain("## Survey Before Acting");
    expect(system).toContain("map the landscape");
    expect(system).toContain("how you will verify the result");
    // 授权自主：用户委托决策后只问真正阻塞项，不抛实现级选择题
    expect(system).toContain("## Delegated Authority");
    expect(system).toContain("irreversible actions");
    expect(system).toContain("Do not bounce implementation-level multiple-choice");
    // 交付自检：声明做了什么/如何验证/未验证项
    expect(system).toContain("## Pre-Delivery Self-Check");
    expect(system).toContain("remains unverified or risky");
    // 稳定前缀全部位于项目指令与 runtime 上下文之前
    for (const section of ["## Survey Before Acting", "## Delegated Authority", "## Pre-Delivery Self-Check"]) {
      expect(system.indexOf(section)).toBeGreaterThan(0);
      expect(system.indexOf(section)).toBeLessThan(system.indexOf("PROJECT GUIDANCE MARKER"));
      expect(system.indexOf(section)).toBeLessThan(system.indexOf("Current working directory"));
      expect(system.indexOf(section)).toBeLessThan(system.indexOf("CUSTOM PROMPT MARKER"));
    }
  });

  it("injects cwd project instruction files before runtime workspace details", async () => {
    const { ChatSession } = await import("../index.js");
    const dir = await mkdtemp(join(tmpdir(), "deepccc-session-instructions-"));
    await writeFile(join(dir, "AGENTS.md"), "agents root guidance", "utf-8");
    await writeFile(join(dir, "AGENTS.local.md"), "agents local guidance", "utf-8");
    await writeFile(join(dir, "CLAUDE.md"), "claude root guidance", "utf-8");
    await writeFile(join(dir, "CLAUDE.local.md"), "claude local guidance", "utf-8");
    streamTextMock.mockReturnValueOnce({ textStream: textStream() });

    const session = new ChatSession(
      { apiKey: "sk-test" },
      {
        cwd: dir,
        sessionId: "project-instructions",
      },
    );
    await collect(session.chat("hi"));

    const system = streamTextMock.mock.calls.at(-1)?.[0].system as string;
    expect(system).toContain("## Project Instructions");
    expect(system).toContain("### AGENTS.md");
    expect(system).toContain("agents root guidance");
    expect(system).toContain("### AGENTS.local.md");
    expect(system).toContain("agents local guidance");
    expect(system).toContain("### CLAUDE.md");
    expect(system).toContain("claude root guidance");
    expect(system).toContain("### CLAUDE.local.md");
    expect(system).toContain("claude local guidance");

    expect(system.indexOf("agents root guidance")).toBeLessThan(system.indexOf("agents local guidance"));
    expect(system.indexOf("agents local guidance")).toBeLessThan(system.indexOf("claude root guidance"));
    expect(system.indexOf("claude root guidance")).toBeLessThan(system.indexOf("claude local guidance"));
    expect(system.indexOf("claude local guidance")).toBeLessThan(system.indexOf(dir));
  });

  it("places the volatile skills index at the very end of system prompt", async () => {
    const { ChatSession } = await import("../index.js");
    const dir = await mkdtemp(join(tmpdir(), "deepccc-session-skill-order-"));
    const skillsDir = join(dir, "skills");
    await mkdir(join(skillsDir, "demo-skill"), { recursive: true });
    await writeFile(
      join(skillsDir, "demo-skill", "SKILL.md"),
      "---\nname: demo-skill\ndescription: demo description\n---\n\nbody\n",
      "utf-8",
    );
    streamTextMock.mockReturnValueOnce({ textStream: textStream("ok") });

    const session = new ChatSession(
      { apiKey: "sk-test" },
      {
        cwd: dir,
        sessionId: "skill-order",
        systemPrompt: "CUSTOM PROMPT MARKER",
        skillsDirs: [skillsDir],
      },
    );
    await collect(session.chat("hi"));

    const system = streamTextMock.mock.calls.at(-1)?.[0].system as string;
    expect(system).toContain("demo-skill");
    expect(system).toContain("CUSTOM PROMPT MARKER");
    expect(system).toContain("Current working directory");
    // 稳定性排序：固定规则 → 项目指令 → runtime → custom → 技能索引（最后）
    expect(system.indexOf("CUSTOM PROMPT MARKER")).toBeGreaterThan(
      system.indexOf("Current working directory"),
    );
    expect(system.indexOf("demo-skill")).toBeGreaterThan(system.indexOf("CUSTOM PROMPT MARKER"));
  });

  it("does not read project instruction files from parent directories", async () => {
    const { ChatSession } = await import("../index.js");
    const parent = await mkdtemp(join(tmpdir(), "deepccc-session-parent-instructions-"));
    const child = join(parent, "child");
    await mkdir(child);
    await writeFile(join(parent, "AGENTS.md"), "parent-only guidance", "utf-8");
    streamTextMock.mockReturnValueOnce({ textStream: textStream() });

    const session = new ChatSession(
      { apiKey: "sk-test" },
      {
        cwd: child,
        sessionId: "no-parent-instructions",
      },
    );
    await collect(session.chat("hi"));

    const system = streamTextMock.mock.calls.at(-1)?.[0].system as string;
    expect(system).not.toContain("parent-only guidance");
  });

  it("uses loop-finished stopping by default", async () => {
    const { ChatSession } = await import("../index.js");
    const dir = await mkdtemp(join(tmpdir(), "deepccc-session-unlimited-"));
    streamTextMock.mockReturnValueOnce({ textStream: textStream("done") });

    const session = new ChatSession(
      { apiKey: "sk-test" },
      {
        cwd: dir,
        sessionId: "unlimited-steps",
      },
    );
    await collect(session.chat("run a multi-stage workflow"));

    expect(streamTextMock).toHaveBeenLastCalledWith(expect.objectContaining({
      stopWhen: { loopFinished: true },
    }));
  });

  it("uses a configured tool step limit when provided", async () => {
    const { ChatSession } = await import("../index.js");
    const dir = await mkdtemp(join(tmpdir(), "deepccc-session-step-budget-"));
    streamTextMock.mockReturnValueOnce({ textStream: textStream("done") });

    const session = new ChatSession(
      { apiKey: "sk-test" },
      {
        cwd: dir,
        sessionId: "step-budget",
        maxSteps: 7,
      },
    );
    await collect(session.chat("run a bounded workflow"));

    expect(streamTextMock).toHaveBeenLastCalledWith(expect.objectContaining({
      stopWhen: { count: 7 },
    }));
  });

  it("loads persisted context, compacts older messages, and persists the new assistant reply", async () => {
    const { ChatSession } = await import("../index.js");
    const dir = await mkdtemp(join(tmpdir(), "deepccc-session-context-"));

    const seed = new ChatSession(
      { apiKey: "sk-test" },
      {
        persist: true,
        contextDir: dir,
        sessionId: "integration",
        compactAtTokens: 10_000,
      },
    );
    streamTextMock.mockReturnValueOnce({ textStream: textStream("old answer") });
    await collect(seed.chat("old question"));

    generateTextMock.mockResolvedValueOnce({ text: "## Current Task\n- old question summarized" });
    streamTextMock.mockReturnValueOnce({ textStream: textStream("new answer") });

    const restored = new ChatSession(
      { apiKey: "sk-test" },
      {
        persist: true,
        contextDir: dir,
        sessionId: "integration",
        compactAtTokens: 1,
        keepRecentMessages: 1,
      },
    );
    const events = await collect(restored.chat("new question"));

    expect(generateTextMock).toHaveBeenCalledOnce();
    expect(generateTextMock).toHaveBeenCalledWith(expect.objectContaining({ temperature: 0 }));
    expect(streamTextMock).toHaveBeenLastCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({ content: expect.stringContaining("old question summarized") }),
        expect.objectContaining({ role: "user", content: "new question" }),
      ]),
    }));
    expect(events.slice(0, 3)).toEqual([
      { type: "status", phase: "compacting" },
      { type: "compact", compactedMessages: 2 },
      { type: "status", phase: "generating" },
    ]);
    expect(restored.history.map((m) => m.content).join("\n")).toContain("new answer");
  });

  it("times out context compaction independently before reply generation", async () => {
    vi.useFakeTimers();
    const { ChatSession } = await import("../index.js");
    const dir = await mkdtemp(join(tmpdir(), "deepccc-session-compaction-timeout-"));
    const seed = new ChatSession(
      { apiKey: "sk-test" },
      { persist: true, contextDir: dir, sessionId: "timeout", compactAtTokens: 10_000 },
    );
    streamTextMock.mockReturnValueOnce({ textStream: textStream("old answer") });
    await collect(seed.chat("old question"));

    generateTextMock.mockImplementationOnce(({ abortSignal }: { abortSignal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        abortSignal.addEventListener("abort", () => reject(abortSignal.reason), { once: true });
      }));
    const restored = new ChatSession(
      { apiKey: "sk-test" },
      {
        persist: true,
        contextDir: dir,
        sessionId: "timeout",
        compactAtTokens: 1,
        keepRecentMessages: 1,
        compactionTimeoutMs: 100,
      },
    );

    const result = collect(restored.chat("new question"));
    const timeoutAssertion = expect(result).rejects.toThrow("Context compaction timed out");
    await vi.waitFor(() => expect(generateTextMock).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(101);
    await timeoutAssertion;
    expect(streamTextMock).toHaveBeenCalledTimes(1);
  });

  it("streams tool calls and tool results from fullStream", async () => {
    const { ChatSession } = await import("../index.js");
    const dir = await mkdtemp(join(tmpdir(), "deepccc-session-tools-"));
    const session = new ChatSession(
      { apiKey: "sk-test" },
      {
        persist: true,
        contextDir: dir,
        sessionId: "tools",
      },
    );

    streamTextMock.mockReturnValueOnce({
      fullStream: fullStream(
        { type: "tool-call", toolCallId: "call-1", toolName: "read_file", input: { path: "package.json" } },
        { type: "tool-result", toolCallId: "call-1", toolName: "read_file", output: { content: "{}" } },
        { type: "text-delta", text: "done" },
      ),
    });

    const events = await collect(session.chat("read package"));

    expect(events).toContainEqual({
      type: "tool_use",
      id: "call-1",
      name: "read_file",
      input: { path: "package.json" },
    });
    expect(events).toContainEqual({
      type: "tool_result",
      tool_use_id: "call-1",
      name: "read_file",
      content: { content: "{}" },
      is_error: false,
    });
    expect(events).toContainEqual({ type: "text", text: "done", accumulated: "done" });
  });

  it("caps the total persisted tool transcript for a turn", async () => {
    const { ChatSession } = await import("../index.js");
    const dir = await mkdtemp(join(tmpdir(), "deepccc-session-tool-cap-"));
    const session = new ChatSession(
      { apiKey: "sk-test" },
      { persist: true, contextDir: dir, sessionId: "tool-cap" },
    );
    const parts = Array.from({ length: 12 }, (_, index) => ({
      type: "tool-result",
      toolCallId: `call-${index}`,
      toolName: "read_file",
      output: { content: "x".repeat(8_000) },
    }));
    streamTextMock.mockReturnValueOnce({
      fullStream: fullStream(...parts, { type: "text-delta", text: "done" }),
    });

    await collect(session.chat("read many files"));

    const persisted = session.history.at(-1)?.content ?? "";
    expect(persisted.length).toBeLessThan(40_000);
    expect(persisted).toContain("tool transcript truncated");
  });

  it("persists structured tool calls alongside the text transcript", async () => {
    const { ChatSession } = await import("../index.js");
    const dir = await mkdtemp(join(tmpdir(), "deepccc-session-structured-tools-"));
    const session = new ChatSession(
      { apiKey: "sk-test" },
      { persist: true, contextDir: dir, sessionId: "structured-tools" },
    );

    streamTextMock.mockReturnValueOnce({
      fullStream: fullStream(
        { type: "tool-call", toolCallId: "call-1", toolName: "read_file", input: { path: "package.json" } },
        { type: "tool-result", toolCallId: "call-1", toolName: "read_file", output: { content: "{}" } },
        { type: "text-delta", text: "done" },
      ),
    });

    await collect(session.chat("read package"));

    const raw = await readFile(join(dir, "structured-tools", "context.json"), "utf8");
    const state = JSON.parse(raw) as { messages: Array<{ content: string; toolCalls?: unknown }> };
    expect(state.messages).toHaveLength(2);
    expect(state.messages[1].toolCalls).toEqual([
      { name: "read_file", input: "{\"path\":\"package.json\"}", output: "{\"content\":\"{}\"}" },
    ]);
    expect(state.messages[1].content).toContain("[Tool transcript]");
  });

  it("records tool errors and preserves tool call order in structured tool calls", async () => {
    const { ChatSession } = await import("../index.js");
    const dir = await mkdtemp(join(tmpdir(), "deepccc-session-structured-tools-order-"));
    const session = new ChatSession(
      { apiKey: "sk-test" },
      { persist: true, contextDir: dir, sessionId: "structured-tools-order" },
    );

    // AI SDK 流中工具调用先全部到达（tool-call），结果后到达（tool-result/tool-error）
    streamTextMock.mockReturnValueOnce({
      fullStream: fullStream(
        { type: "tool-call", toolCallId: "c1", toolName: "run_command", input: { command: "npm test" } },
        { type: "tool-call", toolCallId: "c2", toolName: "read_file", input: { path: "a.ts" } },
        { type: "tool-result", toolCallId: "c1", toolName: "run_command", output: { exitCode: 0 } },
        { type: "tool-error", toolCallId: "c2", toolName: "read_file", error: new Error("boom") },
        { type: "text-delta", text: "failed" },
      ),
    });

    await collect(session.chat("run tests"));

    const raw = await readFile(join(dir, "structured-tools-order", "context.json"), "utf8");
    const state = JSON.parse(raw) as { messages: Array<{ toolCalls?: unknown[] }> };
    expect(state.messages[1].toolCalls).toEqual([
      { name: "run_command", input: "{\"command\":\"npm test\"}", output: "{\"exitCode\":0}" },
      { name: "read_file", input: "{\"path\":\"a.ts\"}", output: "boom", is_error: true },
    ]);
  });

  it("writes raw DeepCCC fullStream parts when raw stream logs are enabled", async () => {
    const { ChatSession } = await import("../index.js");
    config.rawStreamLogs = {
      enabled: true,
      maxBytesPerTurn: 4096,
      retentionDays: 3,
      keepCompleted: true,
    };
    createRawStreamLogMock.mockResolvedValueOnce({
      filePath: "raw.jsonl.gz",
      writeLine: rawLogWriteLineMock,
      close: rawLogCloseMock,
    });
    const session = new ChatSession(
      { apiKey: "sk-test" },
      {
        sessionId: "raw-log-session",
      },
    );
    const textPart = { type: "text-delta", text: "hello" };
    const toolPart = {
      type: "tool-call",
      toolCallId: "call-1",
      toolName: "read_file",
      input: { path: "package.json" },
    };

    streamTextMock.mockReturnValueOnce({
      fullStream: fullStream(textPart, toolPart),
    });

    await collect(session.chat("hi"));

    expect(createRawStreamLogMock).toHaveBeenCalledWith(expect.objectContaining({
      enabled: true,
      tool: "deepccc",
      sessionId: "raw-log-session",
      label: "prompt",
      maxBytesPerTurn: 4096,
      retentionDays: 3,
    }));
    expect(rawLogWriteLineMock).toHaveBeenNthCalledWith(1, JSON.stringify(textPart));
    expect(rawLogWriteLineMock).toHaveBeenNthCalledWith(2, JSON.stringify(toolPart));
    expect(rawLogCloseMock).toHaveBeenCalledWith({ keep: true });
  });
});

describe("platform-specific system prompt injection", () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

  const setPlatform = (value: string) => {
    Object.defineProperty(process, "platform", { value, configurable: true });
  };

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, "platform", originalPlatform);
    }
  });

  it("injects Windows command-line guidance only on win32", async () => {
    const { ChatSession } = await import("../index.js");
    const dir = await mkdtemp(join(tmpdir(), "deepccc-win32-prompt-"));
    setPlatform("win32");
    streamTextMock.mockReturnValueOnce({ textStream: textStream("ok") });

    const session = new ChatSession(
      { apiKey: "sk-test" },
      { cwd: dir, sessionId: "win32-prompt" },
    );
    await collect(session.chat("hi"));

    const system = streamTextMock.mock.calls.at(-1)?.[0].system as string;
    expect(system).toContain("## Windows Command-Line Notes");
    expect(system).toContain("cmd.exe");
    expect(system).toMatch(/double quotes/i);
    expect(system).toMatch(/single quotes/i);
    // 平台指引属于固定规则区，位于 runtime workspace 上下文之前
    expect(system.indexOf("## Windows Command-Line Notes")).toBeGreaterThan(
      system.indexOf("## Fixed Rules"),
    );
    expect(system.indexOf("## Windows Command-Line Notes")).toBeLessThan(
      system.indexOf("Current working directory"),
    );
  });

  it("omits Windows guidance on non-Windows platforms", async () => {
    const { ChatSession } = await import("../index.js");
    const dir = await mkdtemp(join(tmpdir(), "deepccc-posix-prompt-"));
    setPlatform("linux");
    streamTextMock.mockReturnValueOnce({ textStream: textStream("ok") });

    const session = new ChatSession(
      { apiKey: "sk-test" },
      { cwd: dir, sessionId: "posix-prompt" },
    );
    await collect(session.chat("hi"));

    const system = streamTextMock.mock.calls.at(-1)?.[0].system as string;
    expect(system).not.toContain("## Windows Command-Line Notes");
  });
});

describe("estimateBuiltinContextTokens", () => {
  it("weights CJK characters closer to one token per character", () => {
    const messages = [{ role: "user" as const, content: "你好".repeat(100) }];
    const estimate = estimateBuiltinContextTokens("", messages);
    // 200 个汉字 ≈ 200 tokens（旧算法 chars/3 只估到 ~70，明显低估）
    expect(estimate).toBeGreaterThanOrEqual(180);
  });

  it("keeps latin text near chars/3.5", () => {
    const messages = [{ role: "user" as const, content: "a".repeat(1000) }];
    const estimate = estimateBuiltinContextTokens("", messages);
    expect(estimate).toBeGreaterThan(250);
    expect(estimate).toBeLessThan(340);
  });
});

describe("loadPlatformCommandPrompt", () => {
  // 测试文件在 src/__tests__/，上两级即包根 os-prompts/
  const builtinDir = fileURLToPath(new URL("../../os-prompts/", import.meta.url));

  async function loadPrompt(
    platform: string,
    dirs?: { builtinDir?: string; userDir?: string },
  ): Promise<string> {
    const mod = (await import("../index.js")) as {
      loadPlatformCommandPrompt: (
        platform: string,
        dirs?: { builtinDir?: string; userDir?: string },
      ) => string;
    };
    return mod.loadPlatformCommandPrompt(platform, dirs);
  }

  it("loads builtin guidance from os-prompts/<platform>.md", async () => {
    const text = await loadPrompt("win32", { builtinDir });
    expect(text).toContain("## Windows Command-Line Notes");
    expect(text).toContain("cmd.exe");
    expect(text).toMatch(/double quotes/i);
    expect(text).toMatch(/single quotes/i);
  });

  it("prefers the user override at ~/.deepccc/prompts/<platform>.md", async () => {
    const userDir = await mkdtemp(join(tmpdir(), "deepccc-os-prompt-override-"));
    await writeFile(join(userDir, "win32.md"), "CUSTOM OVERRIDE GUIDANCE", "utf-8");
    const text = await loadPrompt("win32", { builtinDir, userDir });
    expect(text).toBe("CUSTOM OVERRIDE GUIDANCE");
  });

  it("returns empty string for unknown platforms or missing files", async () => {
    expect(await loadPrompt("freebsd", { builtinDir })).toBe("");
    expect(await loadPrompt("linux", { builtinDir: join(builtinDir, "missing") })).toBe("");
  });
});
