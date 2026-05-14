import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_DATA_DIR = await mkdtemp(join(tmpdir(), "chatccc-simplify-test-"));
vi.mock("../config.ts", async () => {
  const actual = await vi.importActual<typeof import("../config.ts")>("../config.ts");
  return {
    ...actual,
    PROJECT_ROOT: TEST_DATA_DIR,
    ts: () => "test-ts",
  };
});

let simplifyToolUse: (name: string, input: unknown) => string | null;
let simplifyToolResult: (name: string, toolUseId: string, isError: boolean, toolCallInput?: unknown) => string | null;
let reloadSimplifyConfig: () => void;

beforeEach(async () => {
  vi.resetModules();
  try {
    await rm(join(TEST_DATA_DIR, "simplify.json"), { force: true });
  } catch {}
  const mod = await import("../simplify.ts");
  simplifyToolUse = mod.simplifyToolUse;
  simplifyToolResult = mod.simplifyToolResult;
  reloadSimplifyConfig = mod.reloadSimplifyConfig;
});

afterAll(async () => {
  try {
    await rm(TEST_DATA_DIR, { recursive: true, force: true });
  } catch {}
});

describe("simplifyToolUse", () => {
  it("无 simplify.json 时返回 null（回退默认格式化）", () => {
    reloadSimplifyConfig();
    expect(simplifyToolUse("Read", { file_path: "/tmp/x.ts" })).toBeNull();
  });

  it("有规则时按模板格式化 tool_use", async () => {
    await writeFile(
      join(TEST_DATA_DIR, "simplify.json"),
      JSON.stringify({
        tool_use: {
          Read: { template: "📖 **Read** {file_path}", maxLength: 300 },
        },
      }),
      "utf-8",
    );
    reloadSimplifyConfig();

    expect(simplifyToolUse("Read", { file_path: "/home/user/project/src/index.ts" }))
      .toBe("📖 **Read** /home/user/project/src/index.ts");
  });

  it("无对应工具规则时返回 null", async () => {
    await writeFile(
      join(TEST_DATA_DIR, "simplify.json"),
      JSON.stringify({
        tool_use: {
          Read: { template: "📖 **Read** {file_path}", maxLength: 300 },
        },
      }),
      "utf-8",
    );
    reloadSimplifyConfig();

    expect(simplifyToolUse("Write", { file_path: "/tmp/x.ts" })).toBeNull();
  });

  it("模板中未匹配的占位符保留原文", async () => {
    await writeFile(
      join(TEST_DATA_DIR, "simplify.json"),
      JSON.stringify({
        tool_use: {
          Read: { template: "📖 **Read** {file_path} {unknown_field}", maxLength: 300 },
        },
      }),
      "utf-8",
    );
    reloadSimplifyConfig();

    expect(simplifyToolUse("Read", { file_path: "/tmp/x.ts" }))
      .toBe("📖 **Read** /tmp/x.ts {unknown_field}");
  });

  it("超过 maxLength 时截断", async () => {
    await writeFile(
      join(TEST_DATA_DIR, "simplify.json"),
      JSON.stringify({
        tool_use: {
          Bash: { template: "🖥️ **Bash** {command}", maxLength: 20 },
        },
      }),
      "utf-8",
    );
    reloadSimplifyConfig();

    const result = simplifyToolUse("Bash", { command: "echo hello world this is a long command" });
    expect(result).toBeTruthy();
    // 被截断了：长度不超过 maxLength + 3（"..." 后缀）
    expect(result!.length).toBeLessThanOrEqual(23);
    expect(result!.endsWith("...")).toBe(true);
  });

  it("多字段模板", async () => {
    await writeFile(
      join(TEST_DATA_DIR, "simplify.json"),
      JSON.stringify({
        tool_use: {
          Grep: { template: "🔎 **Grep** {pattern} in {path}", maxLength: 300 },
        },
      }),
      "utf-8",
    );
    reloadSimplifyConfig();

    expect(simplifyToolUse("Grep", { pattern: "TODO", path: "src/" }))
      .toBe("🔎 **Grep** TODO in src/");
  });

  it("input 为 null 时不抛异常", async () => {
    await writeFile(
      join(TEST_DATA_DIR, "simplify.json"),
      JSON.stringify({
        tool_use: {
          TodoWrite: { template: "✅ **TodoWrite**", maxLength: 200 },
        },
      }),
      "utf-8",
    );
    reloadSimplifyConfig();

    expect(simplifyToolUse("TodoWrite", null)).toBe("✅ **TodoWrite**");
  });
});

describe("simplifyToolResult", () => {
  it("无 simplify.json 时返回 null", () => {
    reloadSimplifyConfig();
    expect(simplifyToolResult("Read", "abc123def456", false)).toBeNull();
  });

  it("有规则时按模板格式化 tool_result", async () => {
    await writeFile(
      join(TEST_DATA_DIR, "simplify.json"),
      JSON.stringify({
        tool_result: {
          Read: { template: "✅ *{id}*: 已读取", maxLength: 200 },
        },
      }),
      "utf-8",
    );
    reloadSimplifyConfig();

    expect(simplifyToolResult("Read", "abc123def456", false))
      .toBe("✅ *def456*: 已读取");
  });

  it("isError 时结果前加 ❌", async () => {
    await writeFile(
      join(TEST_DATA_DIR, "simplify.json"),
      JSON.stringify({
        tool_result: {
          Read: { template: "✅ *{id}*: 已读取", maxLength: 200 },
        },
      }),
      "utf-8",
    );
    reloadSimplifyConfig();

    expect(simplifyToolResult("Read", "abc123def456", true))
      .toBe("❌ ✅ *def456*: 已读取");
  });

  it("tool_result 模板可使用 tool_use 的输入字段", async () => {
    await writeFile(
      join(TEST_DATA_DIR, "simplify.json"),
      JSON.stringify({
        tool_result: {
          Write: { template: "✅ *{id}*: 已写入 {file_path}", maxLength: 200 },
        },
      }),
      "utf-8",
    );
    reloadSimplifyConfig();

    expect(simplifyToolResult("Write", "abc123def456", false, { file_path: "/tmp/out.txt" }))
      .toBe("✅ *def456*: 已写入 /tmp/out.txt");
  });

  it("无对应工具规则时返回 null", async () => {
    await writeFile(
      join(TEST_DATA_DIR, "simplify.json"),
      JSON.stringify({
        tool_result: {
          Read: { template: "✅ *{id}*: 已读取", maxLength: 200 },
        },
      }),
      "utf-8",
    );
    reloadSimplifyConfig();

    expect(simplifyToolResult("Write", "abc123def456", false)).toBeNull();
  });
});

describe("accumulateBlockContent with simplification", () => {
  it("tool_use 使用简化规则，tool_result 回退默认格式", async () => {
    // 动态 import session 以使用当前 mock 的简单化模块
    const { accumulateBlockContent } = await import("../session.ts");

    await writeFile(
      join(TEST_DATA_DIR, "simplify.json"),
      JSON.stringify({
        tool_use: {
          Read: { template: "📖 **Read** {file_path}", maxLength: 300 },
        },
      }),
      "utf-8",
    );
    reloadSimplifyConfig();

    const state = { accumulatedContent: "", finalText: "", finalCompleteText: "", chunkCount: 0 };
    const toolCallMap = new Map<string, { name: string; input: unknown }>();

    accumulateBlockContent(
      { type: "tool_use", id: "toolu_001", name: "Read", input: { file_path: "/src/app.ts" } },
      state,
      toolCallMap,
    );

    expect(state.accumulatedContent).toBe("\n\n📖 **Read** /src/app.ts\n");
  });

  it("无简化规则时回退默认 tool_use 格式", async () => {
    const { accumulateBlockContent: acb } = await import("../session.ts");

    reloadSimplifyConfig(); // 无 simplify.json

    const state = { accumulatedContent: "", finalText: "", finalCompleteText: "", chunkCount: 0 };
    const toolCallMap = new Map<string, { name: string; input: unknown }>();

    acb(
      { type: "tool_use", id: "toolu_001", name: "Read", input: { file_path: "/src/app.ts" } },
      state,
      toolCallMap,
    );

    expect(state.accumulatedContent).toContain("📖 **Read**");
    expect(state.accumulatedContent).toContain('{"file_path":"/src/app.ts"}');
  });

  it("tool_result 使用简化规则", async () => {
    const { accumulateBlockContent: acb } = await import("../session.ts");

    await writeFile(
      join(TEST_DATA_DIR, "simplify.json"),
      JSON.stringify({
        tool_result: {
          Read: { template: "✅ *{id}*: 已读取 {file_path}", maxLength: 200 },
        },
      }),
      "utf-8",
    );
    reloadSimplifyConfig();

    const state = { accumulatedContent: "", finalText: "", finalCompleteText: "", chunkCount: 0 };
    const toolCallMap = new Map<string, { name: string; input: unknown }>();
    toolCallMap.set("toolu_001", { name: "Read", input: { file_path: "/src/app.ts" } });

    acb(
      { type: "tool_result", tool_use_id: "toolu_001", content: "file content here..." },
      state,
      toolCallMap,
    );

    expect(state.accumulatedContent).toBe("✅ *lu_001*: 已读取 /src/app.ts\n");
  });
});