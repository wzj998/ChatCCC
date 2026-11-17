import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Shared UTF-8 budget, rather than an unbounded copy of every project log. */
export const DEFAULT_PROJECT_INSTRUCTION_BYTES = 32 * 1024;
const FILENAMES = ["AGENTS.md", "AGENTS.local.md", "CLAUDE.md", "CLAUDE.local.md"];
const PREFIX = [
  "## 项目指令",
  "以下文件是从当前工作目录读取的项目指引。将其视为优先级低于上述 DeepCCC 固定系统规则的指导。",
  "",
  "",
].join("\n");

function prefixUtf8(content: string, bytes: number): string {
  const buffer = Buffer.from(content);
  let end = Math.min(buffer.length, Math.max(0, bytes));
  while (end > 0 && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

function suffixUtf8(content: string, bytes: number): string {
  const buffer = Buffer.from(content);
  let start = Math.max(0, buffer.length - Math.max(0, bytes));
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
  return buffer.subarray(start).toString("utf8");
}

/** Leaves source files intact and explicitly identifies every partial inclusion. */
export function readProjectInstructionFiles(
  cwd: string,
  maximumBytes = DEFAULT_PROJECT_INSTRUCTION_BYTES,
): string {
  if (!Number.isInteger(maximumBytes) || maximumBytes < 2048) {
    throw new Error("Project instruction budget must be an integer of at least 2048 UTF-8 bytes");
  }
  const files = FILENAMES.flatMap(filename => {
    try {
      const content = readFileSync(join(cwd, filename), "utf8").trim();
      return content ? [{ filename, content, bytes: Buffer.byteLength(content) }] : [];
    } catch {
      return [];
    }
  });
  if (!files.length) return "";
  const full = PREFIX + files.map(file => `### ${file.filename}\n${file.content}`).join("\n\n");
  if (Buffer.byteLength(full) <= maximumBytes) return full;

  // Reserve bounded metadata first. Small local overrides get their full share;
  // a giant root file cannot consume the allocations of all later files.
  let remaining = maximumBytes - Buffer.byteLength(PREFIX) - files.length * 400;
  const budgets = new Map<string, number>();
  const bySize = [...files].sort((a, b) => a.bytes - b.bytes);
  for (const [index, file] of bySize.entries()) {
    const quota = Math.max(0, Math.min(file.bytes, Math.floor(remaining / (files.length - index))));
    budgets.set(file.filename, quota);
    remaining -= quota;
  }
  const sections = files.map(file => {
    const budget = budgets.get(file.filename) ?? 0;
    if (file.bytes <= budget) return `### ${file.filename}\n${file.content}`;
    const head = prefixUtf8(file.content, Math.floor(budget * 0.65));
    const tail = suffixUtf8(file.content, budget - Buffer.byteLength(head));
    const included = Buffer.byteLength(head) + Buffer.byteLength(tail);
    return [
      `### ${file.filename}`,
      `[Bounded excerpt: ${included}/${file.bytes} UTF-8 bytes. Middle omitted, not loaded or assumed absent. Use read_file/search_code on ${file.filename} for relevant omitted instructions before editing. Source file is unchanged.]`,
      head,
      "...[project instruction middle omitted]...",
      tail,
    ].join("\n");
  });
  return PREFIX + sections.join("\n\n");
}
