/**
 * progress/cards-helpers.ts — 从 ChatCCC cards.ts 提取的纯函数（DeepCCC 独立版）
 *
 * terminal-renderer 需要 getToolEmoji（工具 emoji 映射）和 truncateContent
 * （正文按行/字符截断）。DeepCCC 没有飞书卡片模块，这两个函数在此独立存放，
 * 与 ChatCCC 保持一致实现，避免引入整张卡片模块。
 */

// 检测 markdown 代码块是否未闭合（``` 出现奇数次）
export function isCodeBlockOpen(text: string): boolean {
  const matches = text.match(/```/g);
  return matches ? matches.length % 2 !== 0 : false;
}

export function truncateContent(text: string, maxLines = 20, maxChars = 8000): string {
  const lines = text.split("\n");
  // 跳过开头空行
  let startIdx = 0;
  while (startIdx < lines.length && lines[startIdx].trim() === "") {
    startIdx++;
  }
  const effectiveLines = lines.slice(startIdx);
  let displayText: string;
  if (effectiveLines.length > maxLines) {
    const firstLine = effectiveLines[0];
    const lastLines = effectiveLines.slice(-(maxLines - 1)).join("\n");
    displayText = firstLine + "\n...\n" + lastLines;
  } else {
    displayText = text;
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
  // CCC 内置 Agent 下划线命名（getToolEmoji 会先把下划线转驼峰再查表，这里保留蛇形条目以便直接命中）
  read_file: "\u{1F4D6}",          // 📖
  list_dir: "\u{1F4C2}",          // 📂
  search_code: "\u{1F50E}",       // 🔎
  run_command: "\u{1F5A5}\u{FE0F}", // 🖥️
  edit_file: "\u{270F}\u{FE0F}",  // ✏️
  create_file: "\u{270D}\u{FE0F}", // ✍️
  delete_file: "\u{1F5D1}\u{FE0F}", // 🗑️
  move_file: "\u{1F4E6}",         // 📦
  apply_patch: "\u{1F4CB}",       // 📋
};

export function getToolEmoji(name: string): string {
  return TOOL_EMOJI_MAP[name] ?? TOOL_EMOJI_MAP[normalizeToolName(name)] ?? "\u{1F527}"; // 🔧
}

/** 把下划线命名转成驼峰（read_file → ReadFile），用于兼容两种命名风格 */
export function normalizeToolName(name: string): string {
  return name
    .split("_")
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}
