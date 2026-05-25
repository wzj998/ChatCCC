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

// 检测 markdown 代码块是否未闭合（``` 出现奇数次）
export function isCodeBlockOpen(text: string): boolean {
  const matches = text.match(/```/g);
  return matches ? matches.length % 2 !== 0 : false;
}

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

  // 截断后如果代码块未闭合，补上闭合标记，避免后续追加内容时误入代码块
  if (isCodeBlockOpen(displayText)) {
    displayText += "\n```";
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

export function buildHelpCard(
  userText: string,
  opts: { greeting?: string; defaultToolLabel?: string } = {},
): string {
  const greeting = opts.greeting ?? `你发送了: ${userText}`;
  const defaultToolLabel = opts.defaultToolLabel ?? "Claude Code";
  const lines = [
    `发送 **/new** 创建新会话（使用 /cd 设置的目录，默认 ${defaultToolLabel}）`,
    "发送 **/new claude** 创建新 Claude 会话",
    "发送 **/new cursor** 创建新 Cursor 会话",
    "发送 **/new codex** 创建新 Codex 会话",
    "发送 **/newh** 重置当前会话（沿用当前工作目录，不切换）",
  ].join("\n");
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { template: "blue", title: { content: "ChatCCC", tag: "plain_text" } },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: greeting } },
      { tag: "div", text: { tag: "lark_md", content: lines } },
      buildButtons([
        { text: `新建默认会话（/new，${defaultToolLabel}）`, value: JSON.stringify({ cmd: "new" }), type: "primary" },
        { text: "新建 Claude 会话（/new claude）", value: JSON.stringify({ cmd: "new claude" }), type: "primary" },
        { text: "新建 Cursor 会话（/new cursor）", value: JSON.stringify({ cmd: "new cursor" }), type: "primary" },
        { text: "新建 Codex 会话（/new codex）", value: JSON.stringify({ cmd: "new codex" }), type: "primary" },
        { text: "重启 ChatCCC（/restart）", value: JSON.stringify({ cmd: "restart" }), type: "danger" },
        { text: "切换工作路径（/cd）", value: JSON.stringify({ cmd: "cd" }), type: "default" },
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
    ? `**本会话默认工作路径（已切换）:** \`${dirPath}\``
    : `**本会话默认工作路径:** \`${dirPath}\``;

  const lines: string[] = [];
  if (currentLine) lines.push(currentLine, "");
  lines.push(
    statusLine,
    ``,
    `此路径仅影响**本会话中新建**的会话工作路径。`,
    ``,
    `---`,
    `**目录内容** (最多 ${maxFiles} 个):`,
    listing,
    overflow,
  );

  return lines.join("\n");
}

// 工作路径卡片（/cd 无参数时使用，含最近使用路径按钮）
//
// 必须使用 v1 卡片格式（无 schema 字段、elements 放顶层）。原因：
// 此卡片通过 `/im/v1/messages?msg_type=interactive` 端点直接发出，content
// 字段就是卡片 JSON。该端点不接受 schema 2.0 的原始 JSON 作为 content
// （schema 2.0 卡片必须先通过 CardKit /cardkit/v1/cards 创建得到 card_id，
// 再以 `{type:"card", data:{card_id}}` 包装发出，参见 sendCardKitMessage）。
// 之前用过 schema 2.0 + body.elements 的结构，飞书会静默拒绝该消息，
// 导致 /cd 无任何回复——故此处与 buildSessionsCard/buildStatusCard 保持
// 同一 v1 结构。
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

  const elements: object[] = [];

  if (sessionCwd) {
    elements.push({
      tag: "div",
      text: { tag: "lark_md", content: `**当前会话工作路径:** \`${sessionCwd}\`` },
    });
  }
  elements.push({
    tag: "div",
    text: { tag: "lark_md", content: `**本会话默认工作路径:** \`${dirPath}\`` },
  });

  if (recentDirs.length > 0) {
    elements.push({ tag: "hr" });
    elements.push({
      tag: "div",
      text: { tag: "lark_md", content: "**最近使用过的路径:**" },
    });
    elements.push({
      tag: "action",
      actions: recentDirs.map(d => {
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
    tag: "div",
    text: {
      tag: "lark_md",
      content: [
        `**目录内容** (最多 ${maxFiles} 个):`,
        listing,
        overflow,
      ].join("\n"),
    },
  });

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "工作路径" },
    },
    elements,
  });
}

// 所有会话列表卡片（Claude Code 优先，然后 Cursor）
export function buildSessionsCard(sessions: Array<{
  sessionId: string;
  chatName: string;
  chatId: string;
  active: boolean;
  turnCount: number;
  elapsedSeconds: number | null;
  model: string;
  tool: string;
}>, opts: { defaultToolLabel?: string } = {}): string {
  const defaultToolLabel = opts.defaultToolLabel ?? "Claude Code";
  // 按 tool 分组排序：Claude Code 在前，Cursor 其次，Codex 最后
  const claudeCodeSessions = sessions.filter(s => s.tool !== "cursor" && s.tool !== "codex");
  const cursorSessions = sessions.filter(s => s.tool === "cursor");
  const codexSessions = sessions.filter(s => s.tool === "codex");
  const hasClaudeCode = claudeCodeSessions.length > 0;
  const hasCursor = cursorSessions.length > 0;
  const hasCodex = codexSessions.length > 0;

  if (sessions.length === 0) {
    return JSON.stringify({
      config: { wide_screen_mode: true },
      header: { template: "blue", title: { content: "所有会话", tag: "plain_text" } },
      elements: [
        { tag: "div", text: { tag: "lark_md", content: `当前没有会话记录。\n\n使用 **/new**（默认 ${defaultToolLabel}）、**/new claude**、**/new cursor** 或 **/new codex** 创建新会话。\n创建后可在任意会话群内发送 **/sessions** 查看列表，用 **/session 数字** 切换会话。` } },
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
    const toolLabel = s.tool === "cursor" ? "Cursor" : s.tool === "codex" ? "Codex" : "Claude Code";
    const namePart = s.chatName ? `**${s.chatName}** ` : "";
    const chatTag = !s.chatId ? " (chat id缺失)" : s.chatId.startsWith("oc_") ? " (群聊)" : "";
    return `**${i + 1}.** ${namePart}${chatTag} \`${shortId}\` ${status} | 工具: ${toolLabel} | 轮数: ${s.turnCount} | ${s.model}${extra}`;
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

  if (hasCodex) {
    if (hasClaudeCode || hasCursor) lines.push("", "**Codex 会话:**", "");
    else lines.push("**Codex 会话:**", "");
    for (const s of codexSessions) {
      lines.push(formatSession(s, idx++));
    }
  }

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { template: "blue", title: { content: "所有会话", tag: "plain_text" } },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: lines.join("\n") } },
      { tag: "hr" },
      { tag: "div", text: { tag: "lark_md", content: "在会话群内发送 **/newh** 可重置当前会话（创建新 Session，保留工作目录和群聊）。\n发送 **/session 数字**（如 `/session 1`）可将当前群聊切换到列表中对应编号的会话。" } },
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

// 队列缓存卡片（消息已进入缓存队列，带取消按钮）
export function buildQueuedCard(text: string): string {
  const preview = text.length > 100 ? text.slice(0, 100) + "…" : text;
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { template: "blue", title: { content: "消息已进入缓存队列", tag: "plain_text" } },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: `当前会话正在生成中，你的消息已进入缓存队列，生成完成后会立即处理。\n\n> ${preview}` } },
      { tag: "hr" },
      {
        tag: "action",
        actions: [{
          tag: "button",
          text: { tag: "plain_text", content: "取消缓存（/cancel）" },
          type: "danger",
          value: { action: "cancel" },
        }],
      },
    ],
  });
}

// 队列满卡片（提示 /stop 或 /cancel）
export function buildQueueFullCard(): string {
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { template: "yellow", title: { content: "消息队列已满", tag: "plain_text" } },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: "当前缓存队列中已有消息等待处理，请等待或发送指令：\n- **/stop** — 停止当前生成\n- **/cancel** — 取消队列中的消息" } },
      { tag: "hr" },
      {
        tag: "action",
        actions: [
          { tag: "button", text: { tag: "plain_text", content: "取消缓存（/cancel）" }, type: "danger", value: { action: "cancel" } },
          { tag: "button", text: { tag: "plain_text", content: "停止生成（/stop）" }, type: "default", value: { action: "stop" } },
        ],
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

/** 模型切换卡片（/model 命令，飞书专用，含切换按钮） */
export function buildModelCard(
  currentModel: string,
  models: string[],
  tool?: string,
): string {
  const toolLabel = tool ? ` (${tool})` : "";
  const currentLine = currentModel
    ? `**当前模型:** \`${currentModel}\``
    : "**当前模型:** 未指定";

  const lines: string[] = [currentLine];
  if (models.length > 0) {
    lines.push("", "**可切换模型:**");
    for (const m of models) {
      lines.push(`- \`${m}\``);
    }
    lines.push("", "点击按钮切换模型，或输入 `/model clear` 恢复默认");
  } else {
    lines.push("", "没有可切换的模型。请在 config.json 中配置模型字段。");
  }

  const buttons: ButtonDef[] = [];
  for (const m of models.slice(0, 20)) {
    const shortName = m.includes("/") ? m.slice(m.lastIndexOf("/") + 1) : m;
    buttons.push({
      text: `/model ${shortName}`,
      value: JSON.stringify({ cmd: `/model ${m}` }),
      type: "primary",
    });
  }

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { template: "blue", title: { content: `模型切换${toolLabel}`, tag: "plain_text" } },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: lines.join("\n") } },
      { tag: "hr" },
      buildButtons(buttons),
    ],
  });
}

