import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const privacyState = vi.hoisted(() => ({ dir: "" }));

const aiMocks = vi.hoisted(() => ({
  streamText: vi.fn(),
  generateText: vi.fn(),
}));

vi.mock("../config.js", async () => {
  const actual = await vi.importActual<typeof import("../config.js")>("../config.js");
  const [{ mkdtempSync }, { tmpdir }, { join }] = await Promise.all([
    import("node:fs"),
    import("node:os"),
    import("node:path"),
  ]);
  const dir = mkdtempSync(join(tmpdir(), "deepccc-privacy-test-"));
  privacyState.dir = dir;
  return {
    ...actual,
    DEEPCCC_HOME: dir,
  };
});

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: vi.fn(() => (modelId: string) => ({ modelId })),
}));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: vi.fn(() => (modelId: string) => ({ modelId })),
}));

vi.mock("ai", () => ({
  streamText: aiMocks.streamText,
  generateText: aiMocks.generateText,
  isLoopFinished: vi.fn(() => ({ loopFinished: true })),
  stepCountIs: vi.fn((count: number) => ({ count })),
  jsonSchema: vi.fn((schema: unknown) => schema),
  tool: vi.fn((definition: unknown) => definition),
}));

vi.mock("../raw-stream-log.js", () => ({
  createRawStreamLog: vi.fn().mockResolvedValue(null),
}));

import { config } from "../config.js";
import {
  applyPrivacy,
  applyPrivacyToJson,
  getPrivacyConfig,
  getPrivacyRules,
  reloadPrivacyRules,
} from "../privacy.js";
import { ChatSession } from "../index.js";

const streamTextMock = aiMocks.streamText;
const generateTextMock = aiMocks.generateText;

const originalRawStreamLogs = structuredClone(config.rawStreamLogs);
const originalStreaming = config.streaming;
const PRIVACY_FILE = join(privacyState.dir, "privacy.json");

function writePrivacy(content: string): void {
  writeFileSync(PRIVACY_FILE, content, "utf-8");
}

async function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

async function* fullStream(...parts: unknown[]): AsyncIterable<unknown> {
  for (const part of parts) yield part;
}

beforeEach(() => {
  try {
    rmSync(PRIVACY_FILE, { force: true });
  } catch {}
  reloadPrivacyRules();
  streamTextMock.mockReset();
  generateTextMock.mockReset();
  config.rawStreamLogs = structuredClone(originalRawStreamLogs);
  config.streaming = true;
});

afterEach(() => {
  try {
    rmSync(PRIVACY_FILE, { force: true });
  } catch {}
  reloadPrivacyRules();
  config.streaming = originalStreaming;
});

afterAll(() => {
  try {
    rmSync(privacyState.dir, { recursive: true, force: true });
  } catch {}
});

describe("applyPrivacy", () => {
  it("returns original text when privacy.json is missing", () => {
    expect(applyPrivacy("hello weizhangjian")).toBe("hello weizhangjian");
  });

  it("supports legacy flat privacy rules", () => {
    writePrivacy(JSON.stringify({ weizhangjian: "wzj", secret: "***" }));
    reloadPrivacyRules();

    expect(applyPrivacy("hello weizhangjian")).toBe("hello wzj");
    expect(applyPrivacy("my secret is safe")).toBe("my *** is safe");
    expect(applyPrivacy("weizhangjian and secret")).toBe("wzj and ***");
  });

  it("supports privacy.json schema with enabled=false", () => {
    writePrivacy(JSON.stringify({ enabled: false, rules: { weizhangjian: "wzj" } }));
    reloadPrivacyRules();

    expect(getPrivacyConfig()).toEqual({ enabled: false, rules: { weizhangjian: "wzj" } });
    expect(getPrivacyRules()).toEqual({ weizhangjian: "wzj" });
    expect(applyPrivacy("hello weizhangjian")).toBe("hello weizhangjian");
  });

  it("supports privacy.json schema with enabled=true", () => {
    writePrivacy(JSON.stringify({ enabled: true, rules: { weizhangjian: "wzj" } }));
    reloadPrivacyRules();

    expect(applyPrivacy("hello weizhangjian")).toBe("hello wzj");
  });

  it("accepts UTF-8 BOM in privacy.json", () => {
    writePrivacy(`\uFEFF${JSON.stringify({ enabled: false, rules: { weizhangjian: "wzj" } })}`);
    reloadPrivacyRules();

    expect(getPrivacyConfig()).toEqual({ enabled: false, rules: { weizhangjian: "wzj" } });
    expect(applyPrivacy("hello weizhangjian")).toBe("hello weizhangjian");
  });

  it("auto reloads privacy.json changes without explicit reload", () => {
    writePrivacy(JSON.stringify({ weizhangjian: "wzj" }));
    reloadPrivacyRules();

    expect(applyPrivacy("hello weizhangjian")).toBe("hello wzj");

    writePrivacy(JSON.stringify({ enabled: false, rules: { weizhangjian: "wzj-disabled" } }));

    expect(applyPrivacy("hello weizhangjian")).toBe("hello weizhangjian");
    expect(getPrivacyConfig()).toEqual({ enabled: false, rules: { weizhangjian: "wzj-disabled" } });
  });

  it("replaces multiple rules and repeated occurrences", () => {
    writePrivacy(JSON.stringify({ a: "A", b: "B" }));
    reloadPrivacyRules();

    expect(applyPrivacy("a b a b")).toBe("A B A B");
  });

  it("returns empty text directly", () => {
    writePrivacy(JSON.stringify({ x: "y" }));
    reloadPrivacyRules();

    expect(applyPrivacy("")).toBe("");
  });

  it("treats special characters in rule keys literally", () => {
    writePrivacy(JSON.stringify({ "a.b": "X", "(test)": "Y", "*star": "Z" }));
    reloadPrivacyRules();

    expect(applyPrivacy("hello a.b world")).toBe("hello X world");
    expect(applyPrivacy("text (test) here")).toBe("text Y here");
    expect(applyPrivacy("a *star shines")).toBe("a Z shines");
  });

  it("reloadPrivacyRules forces a reload", () => {
    writePrivacy(JSON.stringify({ old: "OLD" }));
    reloadPrivacyRules();

    expect(applyPrivacy("old")).toBe("OLD");
    expect(getPrivacyRules()).toEqual({ old: "OLD" });

    writePrivacy(JSON.stringify({ new: "NEW" }));
    reloadPrivacyRules();

    expect(applyPrivacy("new")).toBe("NEW");
    expect(getPrivacyRules()).toEqual({ new: "NEW" });
  });

  it("returns original text for malformed JSON", () => {
    writePrivacy("not json");
    reloadPrivacyRules();

    expect(applyPrivacy("hello")).toBe("hello");
  });

  it("returns original text for array JSON", () => {
    writePrivacy(JSON.stringify(["a", "b"]));
    reloadPrivacyRules();

    expect(applyPrivacy("hello")).toBe("hello");
  });
});

describe("applyPrivacyToJson", () => {
  it("recursively replaces string fields in nested objects and arrays", () => {
    writePrivacy(JSON.stringify({ weizhangjian: "wzj" }));
    reloadPrivacyRules();

    expect(applyPrivacyToJson({ path: "C:\\Users\\weizhangjian\\repo", tags: ["a-weizhangjian"] })).toEqual({
      path: "C:\\Users\\wzj\\repo",
      tags: ["a-wzj"],
    });
  });

  it("leaves non-string values unchanged", () => {
    writePrivacy(JSON.stringify({ weizhangjian: "wzj" }));
    reloadPrivacyRules();

    expect(applyPrivacyToJson({ n: 1, ok: true, nil: null, obj: { n: 2 } })).toEqual({
      n: 1,
      ok: true,
      nil: null,
      obj: { n: 2 },
    });
  });

  it("returns value unchanged when privacy is disabled", () => {
    writePrivacy(JSON.stringify({ enabled: false, rules: { weizhangjian: "wzj" } }));
    reloadPrivacyRules();

    expect(applyPrivacyToJson({ path: "C:\\Users\\weizhangjian" })).toEqual({ path: "C:\\Users\\weizhangjian" });
  });
});

describe("ChatSession privacy integration", () => {
  it("replaces privacy tokens in text, done, tool_use and tool_result events", async () => {
    writePrivacy(JSON.stringify({ enabled: true, rules: { weizhangjian: "wzj" } }));
    reloadPrivacyRules();

    const session = new ChatSession(
      { apiKey: "sk-test" },
      { sessionId: "privacy-integration" },
    );

    streamTextMock.mockReturnValueOnce({
      fullStream: fullStream(
        { type: "tool-call", toolCallId: "call-1", toolName: "read_file", input: { path: "C:\\Users\\weizhangjian\\repo\\a.txt" } },
        { type: "tool-result", toolCallId: "call-1", toolName: "read_file", output: { content: "C:\\Users\\weizhangjian\\repo\\a.txt" } },
        { type: "text-delta", text: "see " },
        { type: "text-delta", text: "C:\\Users\\weizhangjian\\repo" },
      ),
    });

    const events = await collect(session.chat("read the file"));

    expect(events).toContainEqual({
      type: "tool_use",
      id: "call-1",
      name: "read_file",
      input: { path: "C:\\Users\\wzj\\repo\\a.txt" },
    });
    expect(events).toContainEqual({
      type: "tool_result",
      tool_use_id: "call-1",
      name: "read_file",
      content: { content: "C:\\Users\\wzj\\repo\\a.txt" },
      is_error: false,
    });
    expect(events).toContainEqual({
      type: "text",
      text: "see ",
      accumulated: "see ",
    });
    expect(events).toContainEqual({
      type: "text",
      text: "C:\\Users\\wzj\\repo",
      accumulated: "see C:\\Users\\wzj\\repo",
    });
    expect(events).toContainEqual({
      type: "done",
      text: "see C:\\Users\\wzj\\repo",
    });
  });

  it("keeps the original text in persisted history (display-only replacement)", async () => {
    writePrivacy(JSON.stringify({ enabled: true, rules: { weizhangjian: "wzj" } }));
    reloadPrivacyRules();

    const session = new ChatSession(
      { apiKey: "sk-test" },
      { persist: true, sessionId: "privacy-history" },
    );
    streamTextMock.mockReturnValueOnce({ textStream: (async function* () { yield "C:\\Users\\weizhangjian\\repo"; })() });

    await collect(session.chat("hi"));

    expect(streamTextMock).toHaveBeenCalledOnce();
    expect(session.history.map((m) => m.content).join("\n")).toContain("C:\\Users\\weizhangjian\\repo");
  });

  it("does not replace text when privacy is disabled", async () => {
    writePrivacy(JSON.stringify({ enabled: false, rules: { weizhangjian: "wzj" } }));
    reloadPrivacyRules();

    const session = new ChatSession(
      { apiKey: "sk-test" },
      { sessionId: "privacy-disabled" },
    );
    streamTextMock.mockReturnValueOnce({ textStream: (async function* () { yield "C:\\Users\\weizhangjian\\repo"; })() });

    const events = await collect(session.chat("hi"));

    expect(events).toContainEqual({ type: "done", text: "C:\\Users\\weizhangjian\\repo" });
  });
});
