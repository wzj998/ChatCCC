export interface WebToolSummaryRule {
  emoji: string;
  inputFields: string[];
}

export const WEB_TOOL_SUMMARY_RULES: Record<string, WebToolSummaryRule> = {
  read_file: { emoji: "📖", inputFields: ["path"] },
  list_dir: { emoji: "📂", inputFields: ["path"] },
  search_code: { emoji: "🔎", inputFields: ["query", "path"] },
  run_command: { emoji: "🖥️", inputFields: ["command"] },
  edit_file: { emoji: "✏️", inputFields: ["path"] },
  create_file: { emoji: "✍️", inputFields: ["path"] },
  delete_file: { emoji: "🗑️", inputFields: ["path"] },
  move_file: { emoji: "📦", inputFields: ["sourcePath", "destinationPath"] },
  apply_patch: { emoji: "📋", inputFields: [] },
  task: { emoji: "🤖", inputFields: ["description", "cwd"] },
  websearch: { emoji: "🌐", inputFields: ["query"] },
  webfetch: { emoji: "📥", inputFields: ["url"] },
  session_search: { emoji: "🗂️", inputFields: ["query", "session_id"] },
  present_file: { emoji: "🖼️", inputFields: ["path"] },
};

export interface ToolSummaryInput {
  name: string;
  input?: unknown;
  output?: unknown;
  pending?: boolean;
  isError?: boolean;
}

export interface TruncatedToolPayload {
  full: string;
  preview: string;
  omittedLines: number;
  truncated: boolean;
}

export function buildWebToolSummary(call: ToolSummaryInput): string {
  const rule = WEB_TOOL_SUMMARY_RULES[call.name] ?? { emoji: "🔧", inputFields: [] };
  const mark = call.pending ? "…" : call.isError ? "✗" : "✓";
  const input = asRecord(call.input);
  const details = rule.inputFields
    .map((field) => oneLine(input[field]))
    .filter(Boolean);
  const result = call.pending ? "" : resultSummary(call.name, call.output, !!call.isError);
  return [rule.emoji, call.name || "tool", mark, [...details, result].filter(Boolean).join(" · ")]
    .filter(Boolean)
    .join(" ")
    .slice(0, 420);
}

export function truncateToolPayload(
  value: unknown,
  headLines: number,
  tailLines: number,
  maxLineChars = 240,
): TruncatedToolPayload {
  const full = formatToolPayload(value);
  const lines = full.split("\n");
  const keep = Math.max(0, headLines) + Math.max(0, tailLines);
  const omittedLines = Math.max(0, lines.length - keep);
  const selected = omittedLines > 0
    ? [
      ...lines.slice(0, Math.max(0, headLines)),
      `… 已省略 ${omittedLines} 行`,
      ...lines.slice(-Math.max(0, tailLines)),
    ]
    : lines;
  let clipped = false;
  const preview = selected.map((line) => {
    if (line.length <= maxLineChars) return line;
    clipped = true;
    return `${line.slice(0, Math.max(0, maxLineChars - 1))}…`;
  }).join("\n");
  return {
    full,
    preview,
    omittedLines,
    truncated: omittedLines > 0 || clipped,
  };
}

export function formatToolPayload(value: unknown): string {
  if (value === undefined) return "";
  if (value === null) return "null";
  if (typeof value === "string") {
    const parsed = tryJson(value);
    if (parsed !== undefined) return JSON.stringify(parsed, null, 2);
    return value;
  }
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function resultSummary(name: string, raw: unknown, isError: boolean): string {
  const output = asRecord(raw);
  if (isError) return oneLine(output.message ?? raw) || "失败";
  if (typeof output.exitCode === "number") return `exit ${output.exitCode}`;
  if (Array.isArray(output.entries)) return `${output.entries.length} 项`;
  if (Array.isArray(output.matches)) return `${output.matches.length} 条匹配`;
  if (Array.isArray(output.changedFiles)) return `${output.changedFiles.length} 个文件`;
  if (Array.isArray(output.results)) return `${output.results.length} 条结果`;
  if (typeof output.size === "number") return formatBytes(output.size);
  if (name === "task" && typeof output.result === "string") return "已返回结果";
  return "完成";
}

function asRecord(value: unknown): Record<string, unknown> {
  const parsed = typeof value === "string" ? tryJson(value) : value;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function tryJson(value: string): unknown | undefined {
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return undefined;
  try { return JSON.parse(trimmed); } catch { return undefined; }
}

function oneLine(value: unknown): string {
  if (value === undefined || value === null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.replace(/\s+/g, " ").trim().slice(0, 220);
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
