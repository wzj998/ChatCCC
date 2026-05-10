import { describe, it, expect } from "vitest";
import {
  buildProgressCard,
  buildHelpCard,
  buildCdContent,
  buildSessionsCard,
  buildStatusCard,
  buildButtons,
  truncateContent,
  getToolEmoji,
} from "../cards.ts";

// ---------------------------------------------------------------------------
// truncateContent
// ---------------------------------------------------------------------------

describe("truncateContent", () => {
  it("returns original text when under limits", () => {
    expect(truncateContent("hello")).toBe("hello");
  });

  it("truncates lines when exceeding maxLines (default 20)", () => {
    const lines = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`);
    const text = lines.join("\n");
    const result = truncateContent(text);
    const resultLines = result.split("\n");
    expect(resultLines.length).toBe(21); // 1 first + 1 "..." + 19 last
    expect(resultLines[0]).toBe("line 1");
    expect(resultLines[1]).toBe("...");
    expect(resultLines[2]).toBe("line 7");
    expect(resultLines[20]).toBe("line 25");
  });

  it("truncates chars when exceeding maxChars", () => {
    const long = "x".repeat(9000);
    const result = truncateContent(long, 100, 500);
    expect(result.length).toBeLessThanOrEqual(503); // "..." + 500 chars
    expect(result.startsWith("...")).toBe(true);
  });

  it("returns empty string for empty input", () => {
    expect(truncateContent("")).toBe("");
  });

  it("respects custom maxLines and maxChars", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
    const text = lines.join("\n");
    const result = truncateContent(text, 5, 1000);
    const resultLines = result.split("\n");
    expect(resultLines[0]).toBe("line 1");
    expect(resultLines[1]).toBe("...");
    expect(resultLines[resultLines.length - 1]).toBe("line 10");
    expect(resultLines.length).toBe(6); // 1 first + "..." + 4 last
  });
});

// ---------------------------------------------------------------------------
// getToolEmoji
// ---------------------------------------------------------------------------

describe("getToolEmoji", () => {
  it("returns correct emoji for each known tool name", () => {
    expect(getToolEmoji("Read")).toBe("\u{1F4D6}");          // 📖
    expect(getToolEmoji("Write")).toBe("\u{270D}\u{FE0F}");  // ✍️
    expect(getToolEmoji("Edit")).toBe("\u{270F}\u{FE0F}");   // ✏️
    expect(getToolEmoji("Grep")).toBe("\u{1F50E}");          // 🔎
    expect(getToolEmoji("Glob")).toBe("\u{1F4C2}");          // 📂
    expect(getToolEmoji("Bash")).toBe("\u{1F5A5}\u{FE0F}");  // 🖥️
    expect(getToolEmoji("WebSearch")).toBe("\u{1F310}");     // 🌐
    expect(getToolEmoji("WebFetch")).toBe("\u{1F4E5}");      // 📥
    expect(getToolEmoji("TodoWrite")).toBe("\u{2705}");      // ✅
    expect(getToolEmoji("Agent")).toBe("\u{1F916}");         // 🤖
    expect(getToolEmoji("NotebookEdit")).toBe("\u{1F4D3}");  // 📓
    expect(getToolEmoji("AskUserQuestion")).toBe("\u{2753}");// ❓
  });

  it("returns wrench for unknown tool names", () => {
    expect(getToolEmoji("UnknownTool")).toBe("\u{1F527}");
    expect(getToolEmoji("cat")).toBe("\u{1F527}");
    expect(getToolEmoji("")).toBe("\u{1F527}");
  });
});

// ---------------------------------------------------------------------------
// buildProgressCard
// ---------------------------------------------------------------------------

describe("buildProgressCard", () => {
  it("returns valid JSON with correct schema", () => {
    const card = buildProgressCard("test content");
    const parsed = JSON.parse(card);
    expect(parsed.schema).toBe("2.0");
    expect(parsed.config.update_multi).toBe(true);
    expect(parsed.config.streaming_mode).toBe(false);
  });

  it("uses default header title '生成中...'", () => {
    const card = buildProgressCard("hello");
    const parsed = JSON.parse(card);
    expect(parsed.header.title.content).toBe("生成中...");
    expect(parsed.header.template).toBe("blue");
  });

  it("includes stop button by default", () => {
    const card = buildProgressCard("hello");
    const parsed = JSON.parse(card);
    const buttons = parsed.body.elements.filter((e: any) => e.tag === "button");
    expect(buttons).toHaveLength(2);
    expect(buttons[0].text.content).toBe("查看状态（/status）");
    expect(buttons[1].text.content).toBe("停止生成（/stop）");
  });

  it("hides stop button when showStop is false", () => {
    const card = buildProgressCard("hello", { showStop: false });
    const parsed = JSON.parse(card);
    const buttons = parsed.body.elements.filter((e: any) => e.tag === "button");
    expect(buttons).toHaveLength(0);
  });

  it("uses custom header title and template", () => {
    const card = buildProgressCard("hello", { headerTitle: "已完成", headerTemplate: "green" });
    const parsed = JSON.parse(card);
    expect(parsed.header.title.content).toBe("已完成");
    expect(parsed.header.template).toBe("green");
  });

  it("includes markdown element with truncated content", () => {
    const card = buildProgressCard("markdown text");
    const parsed = JSON.parse(card);
    const md = parsed.body.elements.find((e: any) => e.tag === "markdown");
    expect(md).toBeDefined();
    expect(md.element_id).toBe("main_content");
  });
});

// ---------------------------------------------------------------------------
// buildHelpCard
// ---------------------------------------------------------------------------

describe("buildHelpCard", () => {
  it("returns valid JSON with user text", () => {
    const card = buildHelpCard("你好");
    const parsed = JSON.parse(card);
    expect(parsed.header.title.content).toBe("ChatCCC");
    expect(parsed.elements[0].text.content).toContain("你好");
  });

  it("includes action buttons", () => {
    const card = buildHelpCard("test");
    const parsed = JSON.parse(card);
    const action = parsed.elements[1];
    expect(action.tag).toBe("action");
    expect(action.actions).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// buildCdContent
// ---------------------------------------------------------------------------

describe("buildCdContent", () => {
  const entries = [
    { name: "src", isDir: true },
    { name: "README.md", isDir: false },
    { name: "package.json", isDir: false },
  ];

  it("returns markdown with path and listing", () => {
    const content = buildCdContent("/home/user/project", entries, false);
    expect(content).toContain("/home/user/project");
    expect(content).toContain("📁 src/");
    expect(content).toContain("📄 README.md");
    expect(content).toContain("📄 package.json");
  });

  it("shows 已切换 when isUpdate is true", () => {
    const content = buildCdContent("/home/user/project", entries, true);
    expect(content).toContain("（已切换）");
  });

  it("shows currentCwd when provided", () => {
    const content = buildCdContent("/new/path", entries, false, "/old/path");
    expect(content).toContain("当前会话工作路径");
    expect(content).toContain("/old/path");
  });

  it("omits currentCwd line when not provided", () => {
    const content = buildCdContent("/new/path", entries, false);
    expect(content).not.toContain("当前会话工作路径");
  });

  it("caps listing at maxFiles", () => {
    const many = Array.from({ length: 150 }, (_, i) => ({
      name: `file${i}.txt`,
      isDir: false,
    }));
    const content = buildCdContent("/path", many, false);
    expect(content).toContain("仅显示前 100 个");
  });
});

// ---------------------------------------------------------------------------
// buildSessionsCard
// ---------------------------------------------------------------------------

describe("buildSessionsCard", () => {
  it("returns valid JSON for empty sessions", () => {
    const card = buildSessionsCard([]);
    const parsed = JSON.parse(card);
    expect(parsed.elements[0].text.content).toContain("没有会话记录");
  });

  it("returns valid JSON with session listing", () => {
    const card = buildSessionsCard([
      { sessionId: "abc123", active: true, turnCount: 5, elapsedSeconds: 120, model: "Claude Opus 4.7" },
    ]);
    const parsed = JSON.parse(card);
    expect(parsed.elements[0].text.content).toContain("共 **1** 个会话");
    expect(parsed.elements[0].text.content).toContain("abc123");
    expect(parsed.elements[0].text.content).toContain("🟢 活跃");
  });

  it("shows idle status for inactive sessions", () => {
    const card = buildSessionsCard([
      { sessionId: "xyz", active: false, turnCount: 0, elapsedSeconds: null, model: "Claude Sonnet 4.6" },
    ]);
    const parsed = JSON.parse(card);
    expect(parsed.elements[0].text.content).toContain("⚪ 空闲");
  });

  it("shows elapsed time for active sessions", () => {
    const card = buildSessionsCard([
      { sessionId: "active123", active: true, turnCount: 3, elapsedSeconds: 95, model: "Claude Opus 4.7" },
    ]);
    const parsed = JSON.parse(card);
    expect(parsed.elements[0].text.content).toContain("1分35秒");
  });

  it("includes close button", () => {
    const card = buildSessionsCard([]);
    const parsed = JSON.parse(card);
    const action = parsed.elements[2];
    expect(action.actions[0].text.content).toBe("收起");
  });
});

// ---------------------------------------------------------------------------
// buildStatusCard
// ---------------------------------------------------------------------------

describe("buildStatusCard", () => {
  it("returns valid JSON with status text", () => {
    const card = buildStatusCard("一切正常");
    const parsed = JSON.parse(card);
    expect(parsed.header.title.content).toBe("会话状态");
    expect(parsed.elements[0].text.content).toBe("一切正常");
  });

  it("uses custom template color", () => {
    const card = buildStatusCard("警告", "red");
    const parsed = JSON.parse(card);
    expect(parsed.header.template).toBe("red");
  });

  it("includes close button", () => {
    const card = buildStatusCard("test");
    const parsed = JSON.parse(card);
    const action = parsed.elements[2];
    expect(action.actions[0].text.content).toBe("收起");
  });
});

// ---------------------------------------------------------------------------
// buildButtons
// ---------------------------------------------------------------------------

describe("buildButtons", () => {
  it("returns action with buttons", () => {
    const result = buildButtons([
      { text: "确认", value: "ok", type: "primary" },
    ]);
    const obj = result as any;
    expect(obj.tag).toBe("action");
    expect(obj.actions).toHaveLength(1);
    expect(obj.actions[0].text.content).toBe("确认");
    expect(obj.actions[0].type).toBe("primary");
    expect(obj.actions[0].value).toBe("ok");
  });

  it("defaults button type to primary", () => {
    const result = buildButtons([
      { text: "取消", value: "cancel" },
    ]);
    const obj = result as any;
    expect(obj.actions[0].type).toBe("primary");
  });
});