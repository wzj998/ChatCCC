// ---------------------------------------------------------------------------
// Button helpers
// ---------------------------------------------------------------------------

export interface ButtonDef {
  text: string;
  value: string;
  type?: "primary" | "default" | "danger";
}

export function buildButtons(buttons: ButtonDef[]): object {
  return {
    tag: "action",
    actions: buttons.map((b) => ({
      tag: "button",
      text: { tag: "plain_text", content: b.text },
      type: b.type ?? "primary",
      value: b.value,
    })),
  };
}

// ---------------------------------------------------------------------------
// Content helpers
// ---------------------------------------------------------------------------

export function truncateContent(text: string, maxLines = 20, maxChars = 8000): string {
  const lines = text.split("\n");
  let displayText: string;
  if (lines.length > maxLines) {
    const firstLine = lines[0];
    const lastLines = lines.slice(-(maxLines - 1)).join("\n");
    displayText = firstLine + "\n...\n" + lastLines;
  } else {
    displayText = text;
  }

  if (displayText.length > maxChars) {
    displayText = "..." + displayText.slice(-maxChars);
  }

  return displayText;
}

const TOOL_EMOJI_MAP: Record<string, string> = {
  Read: "\u{1F4D6}",          // 📖
  Write: "\u{270D}\u{FE0F}",  // ✍️
  Edit: "\u{270F}\u{FE0F}",   // ✏️
  Grep: "\u{1F50E}",          // 🔎
  Glob: "\u{1F4C2}",          // 📂
  Bash: "\u{1F5A5}\u{FE0F}",  // 🖥️
  WebSearch: "\u{1F310}",     // 🌐
  WebFetch: "\u{1F4E5}",      // 📥
  TodoWrite: "\u{2705}",      // ✅
  Agent: "\u{1F916}",         // 🤖
  NotebookEdit: "\u{1F4D3}",  // 📓
  AskUserQuestion: "\u{2753}",// ❓
};

export function getToolEmoji(name: string): string {
  return TOOL_EMOJI_MAP[name] ?? "\u{1F527}"; // 🔧
}

// ---------------------------------------------------------------------------
// Card builders
// ---------------------------------------------------------------------------

// CardKit schema 2.0 进度卡片（带停止按钮，支持流式更新）
export function buildProgressCard(
  text: string,
  opts: { showStop?: boolean; headerTitle?: string; headerTemplate?: string } = {}
): string {
  const { showStop = true, headerTitle = "生成中...", headerTemplate = "blue" } = opts;
  const elements: object[] = [
    { tag: "markdown", content: truncateContent(text), element_id: "main_content" },
  ];
  if (showStop) {
    elements.push({ tag: "hr" });
    elements.push({
      tag: "button",
      text: { tag: "plain_text", content: "查看状态（/status）" },
      type: "default",
      value: { action: "status" },
      element_id: "action_status",
    });
    elements.push({
      tag: "button",
      text: { tag: "plain_text", content: "停止生成（/stop）" },
      type: "danger",
      value: { action: "stop" },
      element_id: "action_stop",
    });
  }
  return JSON.stringify({
    schema: "2.0",
    config: {
      update_multi: true,
      streaming_mode: false,
    },
    header: {
      template: headerTemplate,
      title: { tag: "plain_text", content: headerTitle },
    },
    body: {
      direction: "vertical",
      elements,
    },
  });
}

export function buildHelpCard(userText: string): string {
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { template: "blue", title: { content: "ChatCCC", tag: "plain_text" } },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: `你发送了: ${userText}` } },
      { tag: "div", text: { tag: "lark_md", content: "使用 **/new**（默认 Claude Code）或 **/new claude** / **/new cursor** 创建新会话" } },
      buildButtons([
        { text: "新建 Claude Code 会话（/new claude）", value: JSON.stringify({ cmd: "new" }), type: "primary" },
        { text: "新建 Cursor 会话（/new cursor）", value: JSON.stringify({ cmd: "new cursor" }), type: "primary" },
        { text: "重启 ChatCCC（/restart）", value: JSON.stringify({ cmd: "restart" }), type: "danger" },
        { text: "查看/切换工作路径及最近使用（/cd）", value: JSON.stringify({ cmd: "cd" }), type: "default" },
      ]),
    ],
  });
}

// 工作路径内容（/cd 命令统一使用，返回 markdown 内容字符串）
export function buildCdContent(
  dirPath: string,
  entries: { name: string; isDir: boolean }[],
  isUpdate: boolean,
  currentCwd?: string,
  maxFiles = 100
): string {
  const display = entries.slice(0, maxFiles);
  const overflow = entries.length > maxFiles ? `\n...（共 ${entries.length} 个条目，仅显示前 ${maxFiles} 个）` : "";
  const listing = display.map(e => e.isDir ? `📁 ${e.name}/` : `📄 ${e.name}`).join("\n");

  const currentLine = currentCwd
    ? `**当前会话工作路径:** \`${currentCwd}\``
    : "";

  const statusLine = isUpdate
    ? `**新会话默认工作路径（已切换）:** \`${dirPath}\``
    : `**新会话默认工作路径:** \`${dirPath}\``;

  const lines: string[] = [];
  if (currentLine) lines.push(currentLine, "");
  lines.push(
    statusLine,
    ``,
    `此路径持久化在配置文件中，仅影响**新建会话**的工作路径。`,
    ``,
    `---`,
    `**目录内容** (最多 ${maxFiles} 个):`,
    listing,
    overflow,
  );

  return lines.join("\n");
}

// 工作路径卡片（/cd 无参数时使用，含最近使用路径按钮）
export function buildCdCard(
  dirPath: string,
  entries: { name: string; isDir: boolean }[],
  recentDirs: string[],
  sessionCwd?: string,
  maxFiles = 100,
): string {
  const display = entries.slice(0, maxFiles);
  const overflow = entries.length > maxFiles ? `\n...（共 ${entries.length} 个条目，仅显示前 ${maxFiles} 个）` : "";
  const listing = display.map(e => e.isDir ? `📁 ${e.name}/` : `📄 ${e.name}`).join("\n");

  const currentLine = sessionCwd
    ? `**当前会话工作路径:** \`${sessionCwd}\``
    : "";

  const elements: object[] = [];

  if (currentLine) {
    elements.push({ tag: "markdown", content: currentLine });
  }
  elements.push({ tag: "markdown", content: `**新会话默认工作路径:** \`${dirPath}\`` });

  if (recentDirs.length > 0) {
    elements.push({ tag: "hr" });
    elements.push({ tag: "markdown", content: "**最近使用过的路径（点击切换）:**" });
    elements.push({
      tag: "action",
      actions: recentDirs.map(d => {
        const name = d.split(/[\\/]/).filter(Boolean).pop() ?? d;
        const label = d.length > 36 ? `...${d.slice(-33)}` : d;
        return {
          tag: "button",
          text: { tag: "plain_text", content: label },
          type: "default",
          value: { action: "cd", path: d },
        };
      }),
    });
  }

  elements.push({ tag: "hr" });
  elements.push({
    tag: "markdown",
    content: [
      `**目录内容** (最多 ${maxFiles} 个):`,
      listing,
      overflow,
    ].join("\n"),
  });

  return JSON.stringify({
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "工作路径" },
    },
    body: {
      direction: "vertical",
      elements,
    },
  });
}

// 所有会话列表卡片（Claude Code 优先，然后 Cursor）
export function buildSessionsCard(sessions: Array<{
  sessionId: string;
  active: boolean;
  turnCount: number;
  elapsedSeconds: number | null;
  model: string;
  tool: string;
}>): string {
  // 按 tool 分组排序：Claude Code 在前，Cursor 在后
  const claudeCodeSessions = sessions.filter(s => s.tool !== "cursor");
  const cursorSessions = sessions.filter(s => s.tool === "cursor");
  const hasClaudeCode = claudeCodeSessions.length > 0;
  const hasCursor = cursorSessions.length > 0;

  if (sessions.length === 0) {
    return JSON.stringify({
      config: { wide_screen_mode: true },
      header: { template: "blue", title: { content: "所有会话", tag: "plain_text" } },
      elements: [
        { tag: "div", text: { tag: "lark_md", content: "当前没有会话记录。\n\n使用 **/new**（默认 Claude Code）、**/new claude** 或 **/new cursor** 创建新会话。" } },
        { tag: "hr" },
        { tag: "action", actions: [{ tag: "button", text: { tag: "plain_text", content: "收起" }, type: "default", value: { action: "close" } }] },
      ],
    });
  }

  const formatSession = (s: typeof sessions[0], i: number) => {
    const status = s.active ? "🟢 活跃" : "⚪ 空闲";
    const shortId = s.sessionId.length > 16 ? s.sessionId.slice(0, 16) + "..." : s.sessionId;
    let extra = "";
    if (s.active && s.elapsedSeconds !== null) {
      const mins = Math.floor(s.elapsedSeconds / 60);
      const secs = s.elapsedSeconds % 60;
      extra = ` | 本轮: ${mins}分${secs}秒`;
    }
    const toolLabel = s.tool === "cursor" ? "Cursor" : "Claude Code";
    return `**${i + 1}.** \`${shortId}\` ${status} | 工具: ${toolLabel} | 轮数: ${s.turnCount} | ${s.model}${extra}`;
  };

  const lines: string[] = [`共 **${sessions.length}** 个会话:`, ""];
  let idx = 0;

  if (hasClaudeCode) {
    lines.push("**Claude Code 会话:**", "");
    for (const s of claudeCodeSessions) {
      lines.push(formatSession(s, idx++));
    }
  }

  if (hasCursor) {
    if (hasClaudeCode) lines.push("", "**Cursor 会话:**", "");
    else lines.push("**Cursor 会话:**", "");
    for (const s of cursorSessions) {
      lines.push(formatSession(s, idx++));
    }
  }

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { template: "blue", title: { content: "所有会话", tag: "plain_text" } },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: lines.join("\n") } },
      { tag: "hr" },
      {
        tag: "action",
        actions: [{
          tag: "button",
          text: { tag: "plain_text", content: "收起" },
          type: "default",
          value: { action: "close" },
        }],
      },
    ],
  });
}

// 状态卡片（带关闭按钮）
export function buildStatusCard(statusText: string, template = "blue"): string {
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { template, title: { content: "会话状态", tag: "plain_text" } },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: statusText } },
      { tag: "hr" },
      {
        tag: "action",
        actions: [{
          tag: "button",
          text: { tag: "plain_text", content: "收起" },
          type: "default",
          value: { action: "close" },
        }],
      },
    ],
  });
}