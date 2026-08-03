/**
 * builtin/skills.ts — Codex-style skills 支持
 *
 * 从用户级（~/.codex/skills、~/.agents/skills）和项目级（<cwd>/.codex/skills）
 * 扫描 Codex 目录式 skill（<name>/SKILL.md），解析 frontmatter 中的
 * name + description，生成索引注入 system prompt。模型按需用 read_file
 * 读取 SKILL.md 全文并执行（索引注入省 token，触发靠 description + 指令）。
 */

import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface BuiltinSkill {
  name: string;
  description: string;
  /** SKILL.md 的绝对路径 */
  skillPath: string;
}

/** 解析 SKILL.md frontmatter（兼容 CRLF），返回 name + description；无 frontmatter 返回 null */
export function parseSkillFrontmatter(
  content: string,
): { name: string; description: string } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(content);
  if (!match) return null;
  const fm = match[1];
  const nameMatch = /^name:\s*(.+?)\s*$/m.exec(fm);
  if (!nameMatch) return null;
  const descMatch = /^description:\s*(.+?)\s*$/m.exec(fm);
  return {
    name: nameMatch[1].trim(),
    description: descMatch?.[1].trim() ?? "",
  };
}

/**
 * 扫描多个 skill 目录，返回去重后的 skill 列表。
 * 同名 skill 后面的目录覆盖前面的（调用方应把项目级目录放最后）。
 * 隐藏目录（.system 等）和无 SKILL.md 的目录会被跳过。
 */
export function scanSkillsDirs(dirs: string[]): BuiltinSkill[] {
  const byName = new Map<string, BuiltinSkill>();

  for (const dir of dirs) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // 目录不存在或不可读：跳过
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue; // 排除 .system 等隐藏/内置目录

      const skillPath = join(dir, entry.name, "SKILL.md");
      let content: string;
      try {
        content = readFileSync(skillPath, "utf-8");
      } catch {
        continue; // 没有 SKILL.md 的目录不是 skill
      }

      const parsed = parseSkillFrontmatter(content);
      if (!parsed) continue;

      byName.set(parsed.name, {
        name: parsed.name,
        description: parsed.description,
        skillPath,
      });
    }
  }

  return [...byName.values()];
}

/**
 * 默认 skill 扫描目录：
 * 1. ~/.codex/skills（Codex CLI 旧路径，用户实际在用的地方）
 * 2. ~/.agents/skills（Codex 标准全局目录）
 * 3. <cwd>/.codex/skills（项目级，优先级最高，放最后）
 */
export function buildDefaultSkillDirs(cwd: string): string[] {
  return [
    join(homedir(), ".codex", "skills"),
    join(homedir(), ".agents", "skills"),
    join(cwd, ".codex", "skills"),
  ];
}

/**
 * 生成 skill 索引提示词（注入 system prompt）。
 * 索引只含 name + description + 路径，并指示模型在任务匹配时
 * 先用 read_file 读取 SKILL.md 全文再执行——这是触发率的关键。
 */
export function buildSkillsIndexPrompt(skills: BuiltinSkill[]): string {
  if (skills.length === 0) return "";

  const lines = [
    "## Available Skills (Codex-style)",
    "The following Codex-style skills are available on this machine. When a user request matches a skill's description, first read its full SKILL.md with read_file, then follow the instructions in it exactly.",
    "",
    ...skills.map((s) => `- **${s.name}** (\`${s.skillPath}\`): ${s.description || "(no description)"}`),
  ];
  return lines.join("\n");
}
