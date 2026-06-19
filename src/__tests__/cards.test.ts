import { describe, it, expect } from "vitest";
import {
  buildProgressCard,
  buildHelpCard,
  buildCdContent,
  buildCdCard,
  buildSessionsCard,
  buildStatusCard,
  buildCodexUsageCard,
  buildCodexResetConfirmCard,
  buildButtons,
  truncateContent,
  getToolEmoji,
} from "../cards.ts";
import { ABD_HELP_LINE } from "../shared-prefix.ts";

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

  it("returns empty string for empty input", () => {
    expect(truncateContent("")).toBe("");
  });

  it("respects custom maxLines", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
    const text = lines.join("\n");
    const result = truncateContent(text, 5);
    const resultLines = result.split("\n");
    expect(resultLines[0]).toBe("line 1");
    expect(resultLines[1]).toBe("...");
    expect(resultLines[resultLines.length - 1]).toBe("line 10");
    expect(resultLines.length).toBe(6); // 1 first + "..." + 4 last
  });

  it("skips leading empty lines, preserves first non-empty line", () => {
    const lines = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`);
    const text = "\n\n\n" + lines.join("\n");
    const result = truncateContent(text);
    const resultLines = result.split("\n");
    expect(resultLines[0]).toBe("line 1");
    expect(resultLines[1]).toBe("...");
    expect(resultLines.length).toBe(21); // 1 first + "..." + 19 last
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
    expect(buttons[0].text.content).toBe("查看状态（/state）");
    expect(buttons[0].value).toEqual({ action: "state" });
    expect(buttons[0].element_id).toBe("action_state");
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
    const action = parsed.elements[2];
    expect(action.tag).toBe("action");
    expect(action.actions).toHaveLength(7);
  });

  it("adds ABD prefix help as the final help line", () => {
    const card = buildHelpCard("test");
    const parsed = JSON.parse(card);
    const lines = parsed.elements[1].text.content.split("\n");

    expect(lines).toContain("发送 **/usage** 查看 Codex 5h/周用量，以及查询/使用主动重置卡");
    expect(lines.at(-1)).toBe(ABD_HELP_LINE);
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
// buildCdCard
// ---------------------------------------------------------------------------

describe("buildCdCard", () => {
  const entries = [
    { name: "src", isDir: true },
    { name: "README.md", isDir: false },
  ];

  // 提取 v1 卡片中 `tag:"div"` 的 markdown content（飞书 v1 富文本写在 text.content）
  const mdContents = (parsed: any): string[] =>
    parsed.elements
      .filter((e: any) => e.tag === "div" && e.text?.tag === "lark_md")
      .map((e: any) => e.text.content);

  it("uses v1 interactive card format (no schema field, elements at top level)", () => {
    // 必须用 v1 格式发送，否则通过 /im/v1/messages?msg_type=interactive 端点
    // 直接发会被飞书静默拒绝（schema 2.0 卡片必须先经 CardKit 创建）
    const card = buildCdCard("/home/project", entries, []);
    const parsed = JSON.parse(card);
    expect(parsed.schema).toBeUndefined();
    expect(parsed.body).toBeUndefined();
    expect(Array.isArray(parsed.elements)).toBe(true);
    expect(parsed.header.title.content).toBe("工作路径");
    expect(parsed.header.template).toBe("blue");
    expect(parsed.config.wide_screen_mode).toBe(true);
  });

  it("shows current working directory in markdown", () => {
    const card = buildCdCard("/home/project", entries, []);
    const parsed = JSON.parse(card);
    const cwdContent = mdContents(parsed).find((c) => c.includes("本会话默认工作路径"));
    expect(cwdContent).toBeDefined();
    expect(cwdContent).toContain("/home/project");
  });

  it("shows sessionCwd when provided", () => {
    const card = buildCdCard("/default", entries, [], "/session/path");
    const parsed = JSON.parse(card);
    const sessionContent = mdContents(parsed).find((c) => c.includes("当前会话工作路径"));
    expect(sessionContent).toBeDefined();
    expect(sessionContent).toContain("/session/path");
  });

  it("does not show sessionCwd when not provided", () => {
    const card = buildCdCard("/default", entries, []);
    const parsed = JSON.parse(card);
    const sessionContent = mdContents(parsed).find((c) => c.includes("当前会话工作路径"));
    expect(sessionContent).toBeUndefined();
  });

  it("shows recent dirs section with buttons", () => {
    const recentDirs = ["/home/user/project1", "/home/user/project2"];
    const card = buildCdCard("/current", entries, recentDirs);
    const parsed = JSON.parse(card);
    const recentMd = mdContents(parsed).find((c) => c.includes("最近使用过的路径"));
    expect(recentMd).toBeDefined();

    const actionElements: any[] = parsed.elements.filter((e: any) => e.tag === "action");
    expect(actionElements.length).toBeGreaterThanOrEqual(1);
    const recentAction = actionElements.find((e: any) =>
      e.actions.some((a: any) => a.value?.action === "cd")
    );
    expect(recentAction).toBeDefined();
    expect(recentAction.actions).toHaveLength(2);
    expect(recentAction.actions[0].value.action).toBe("cd");
    expect(recentAction.actions[0].value.path).toBe("/home/user/project1");
    expect(recentAction.actions[1].value.path).toBe("/home/user/project2");
  });

  it("does not show recent dirs section when empty", () => {
    const card = buildCdCard("/current", entries, []);
    const parsed = JSON.parse(card);
    const recentMd = mdContents(parsed).find((c) => c.includes("最近使用过的路径"));
    expect(recentMd).toBeUndefined();
  });

  it("truncates long paths in button text", () => {
    const longPath = "/home/user/very/long/path/that/exceeds/thirty/six/chars";
    const card = buildCdCard("/current", entries, [longPath]);
    const parsed = JSON.parse(card);
    const action: any = parsed.elements.find((e: any) => e.tag === "action");
    const btnText = action.actions[0].text.content;
    expect(btnText.startsWith("...")).toBe(true);
    expect(btnText.length).toBeLessThanOrEqual(36);
  });

  it("shows directory listing", () => {
    const card = buildCdCard("/current", entries, []);
    const parsed = JSON.parse(card);
    const listingContent = mdContents(parsed).find((c) => c.includes("📁 src/"));
    expect(listingContent).toBeDefined();
    expect(listingContent).toContain("📄 README.md");
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
    expect(parsed.elements[0].text.content).toContain("/new");
  });

  it("returns valid JSON with session listing", () => {
    const card = buildSessionsCard([
      { sessionId: "abc123", chatName: "test-group", chatId: "oc_test123", active: true, turnCount: 5, elapsedSeconds: 120, model: "Claude Opus 4.7", tool: "claude" },
    ]);
    const parsed = JSON.parse(card);
    expect(parsed.elements[0].text.content).toContain("共 **1** 个会话");
    expect(parsed.elements[0].text.content).toContain("abc123");
    expect(parsed.elements[0].text.content).toContain("🟢 活跃");
    expect(parsed.elements[0].text.content).toContain("Claude Code");
  });

  it("shows idle status for inactive sessions", () => {
    const card = buildSessionsCard([
      { sessionId: "xyz", chatName: "", chatId: "oc_xyz", active: false, turnCount: 0, elapsedSeconds: null, model: "Claude Sonnet 4.6", tool: "claude" },
    ]);
    const parsed = JSON.parse(card);
    expect(parsed.elements[0].text.content).toContain("⚪ 空闲");
  });

  it("shows elapsed time for active sessions", () => {
    const card = buildSessionsCard([
      { sessionId: "active123", chatName: "", chatId: "oc_active123", active: true, turnCount: 3, elapsedSeconds: 95, model: "Claude Opus 4.7", tool: "claude" },
    ]);
    const parsed = JSON.parse(card);
    expect(parsed.elements[0].text.content).toContain("1分35秒");
  });

  it("separates Claude Code and Cursor sessions", () => {
    const card = buildSessionsCard([
      { sessionId: "c1", chatName: "", chatId: "oc_c1", active: false, turnCount: 1, elapsedSeconds: null, model: "(留空)", tool: "claude" },
      { sessionId: "c2", chatName: "", chatId: "oc_c2", active: false, turnCount: 2, elapsedSeconds: null, model: "claude-opus-4-7-max", tool: "cursor" },
    ]);
    const parsed = JSON.parse(card);
    const content: string = parsed.elements[0].text.content;
    expect(content).toContain("Claude Code 会话");
    expect(content).toContain("Cursor 会话");
  });

  it("omits Cursor section when no Cursor sessions", () => {
    const card = buildSessionsCard([
      { sessionId: "c1", chatName: "", chatId: "oc_c1", active: false, turnCount: 1, elapsedSeconds: null, model: "(留空)", tool: "claude" },
    ]);
    const parsed = JSON.parse(card);
    const content: string = parsed.elements[0].text.content;
    expect(content).toContain("Claude Code 会话");
    expect(content).not.toContain("Cursor 会话");
  });

  it("displays chatName when provided", () => {
    const card = buildSessionsCard([
      { sessionId: "abc123", chatName: "帮我写代码-src", chatId: "oc_abc123", active: false, turnCount: 2, elapsedSeconds: null, model: "Claude Opus 4.7", tool: "claude" },
    ]);
    const parsed = JSON.parse(card);
    expect(parsed.elements[0].text.content).toContain("帮我写代码-src");
  });

  it("shows (群聊) tag for group chat sessions and not for private chats", () => {
    const card = buildSessionsCard([
      { sessionId: "g1", chatName: "group-chat", chatId: "oc_group1", active: false, turnCount: 1, elapsedSeconds: null, model: "Claude Opus 4.7", tool: "claude" },
      { sessionId: "p1", chatName: "private-chat", chatId: "ou_private1", active: false, turnCount: 1, elapsedSeconds: null, model: "Claude Opus 4.7", tool: "claude" },
    ]);
    const content: string = JSON.parse(card).elements[0].text.content;
    expect(content).toContain("(群聊)");
    // 群聊会话包含 (群聊)
    expect(content).toMatch(/group-chat.*\(群聊\)/);
    // 私聊会话不包含 (群聊)
    expect(content).toMatch(/private-chat/);
    const afterPrivateChat = content.split("private-chat")[1];
    expect(afterPrivateChat).not.toContain("(群聊)");
  });

  it("shows chat id missing for sessions without a chat binding", () => {
    const card = buildSessionsCard([
      { sessionId: "orphan", chatName: "", chatId: "", active: true, turnCount: 0, elapsedSeconds: 3, model: "Claude Opus 4.7", tool: "claude" },
    ]);
    const content: string = JSON.parse(card).elements[0].text.content;
    expect(content).toContain("chat id缺失");
  });

  it("includes /session help text in non-empty card", () => {
    const card = buildSessionsCard([
      { sessionId: "abc123", chatName: "", chatId: "oc_abc123", active: false, turnCount: 2, elapsedSeconds: null, model: "Claude Opus 4.7", tool: "claude" },
    ]);
    const parsed = JSON.parse(card);
    expect(parsed.elements[2].text.content).toContain("/session 数字");
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
// buildCodexUsageCard / buildCodexResetConfirmCard
// ---------------------------------------------------------------------------

describe("Codex usage reset cards", () => {
  it("shows the reset button only when reset credits are available", () => {
    const card = buildCodexUsageCard("Codex 用量", 2);
    const parsed = JSON.parse(card);
    const action = parsed.elements.find((element: any) => element.tag === "action");
    expect(action.actions[0].text.content).toBe("发起重置");
    expect(action.actions[0].value).toEqual({ action: "codex_reset_request", availableCount: 2 });

    const noCreditCard = buildCodexUsageCard("Codex 用量", 0);
    const noCreditParsed = JSON.parse(noCreditCard);
    expect(noCreditParsed.elements.some((element: any) => element.tag === "action")).toBe(false);
  });

  it("builds yes/no confirmation buttons tied to the parent usage card", () => {
    const card = buildCodexResetConfirmCard({
      availableCount: 2,
      parentMessageId: "usage-message",
      requestId: "request-1",
    });
    const parsed = JSON.parse(card);
    const action = parsed.elements.find((element: any) => element.tag === "action");

    expect(action.actions[0].text.content).toBe("是，发起重置");
    expect(action.actions[0].value).toEqual({
      action: "codex_reset_confirm",
      decision: "yes",
      parentMessageId: "usage-message",
      requestId: "request-1",
    });
    expect(action.actions[1].text.content).toBe("否");
    expect(action.actions[1].value).toEqual({
      action: "codex_reset_confirm",
      decision: "no",
      parentMessageId: "usage-message",
      requestId: "request-1",
    });
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
