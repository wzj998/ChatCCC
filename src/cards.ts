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

export function getToolEmoji(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("read") || n.includes("cat")) return "\u{1F4D6}";        // 📖
  if (n.includes("write")) return "\u{270D}\u{FE0F}";                    // ✍️
  if (n.includes("edit")) return "\u{270F}\u{FE0F}";                     // ✏️
  if (n.includes("grep") || n.includes("search")) return "\u{1F50E}";    // 🔎
  if (n.includes("glob") || n.includes("find") || n.includes("ls")) return "\u{1F4C2}"; // 📂
  if (n.includes("bash") || n.includes("shell") || n.includes("exec")) return "\u{1F5A5}\u{FE0F}"; // 🖥️
  if (n.includes("websearch") || n.includes("web_search")) return "\u{1F310}"; // 🌐
  if (n.includes("webfetch") || n.includes("web_fetch") || n.includes("fetch")) return "\u{1F4E5}"; // 📥
  if (n.includes("todo") || n.includes("task")) return "\u{2705}";       // ✅
  if (n.includes("agent")) return "\u{1F916}";                           // 🤖
  if (n.includes("notebook")) return "\u{1F4D3}";                        // 📓
  if (n.includes("ask") || n.includes("question")) return "\u{2753}";    // ❓
  return "\u{1F527}";                                                     // 🔧
}

// ---------------------------------------------------------------------------
// Card builders
// ---------------------------------------------------------------------------

// CardKit schema 2.0 思考卡片（带停止按钮，支持打字机流式更新）
export function buildThinkingCardV2(
  thinkingText: string,
  opts: { showStop?: boolean; headerTitle?: string; headerTemplate?: string } = {}
): string {
  const { showStop = true, headerTitle = "思考中...", headerTemplate = "blue" } = opts;
  const elements: object[] = [
    { tag: "markdown", content: truncateContent(thinkingText), element_id: "main_content" },
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
      buildButtons([
        { text: "新建会话（/new）", value: JSON.stringify({ cmd: "new" }), type: "primary" },
        { text: "重启Chat CCC（/restart）", value: JSON.stringify({ cmd: "restart" }), type: "danger" },
        { text: "查看/切换工作路径（/cd）", value: JSON.stringify({ cmd: "cd" }), type: "default" },
      ]),
    ],
  });
}

// 工作路径内容（/cd 命令统一使用，返回 markdown 内容字符串）
export function buildCdContent(
  dirPath: string,
  entries: { name: string; isDir: boolean }[],
  isUpdate: boolean,
  maxFiles = 100
): string {
  const display = entries.slice(0, maxFiles);
  const overflow = entries.length > maxFiles ? `\n...（共 ${entries.length} 个条目，仅显示前 ${maxFiles} 个）` : "";
  const listing = display.map(e => e.isDir ? `📁 ${e.name}/` : `📄 ${e.name}`).join("\n");

  const statusLine = isUpdate
    ? `**新会话工作路径已切换至:** \`${dirPath}\``
    : `**新会话默认工作路径:** \`${dirPath}\``;

  return [
    statusLine,
    ``,
    `此路径持久化在配置文件中，仅影响**新建会话**的工作路径。`,
    ``,
    `---`,
    `**目录内容** (最多 ${maxFiles} 个):`,
    listing,
    overflow,
  ].join("\n");
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