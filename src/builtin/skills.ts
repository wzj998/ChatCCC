/**
 * skills.ts — 多来源技能扫描（DeepCCC 统一入口）
 *
 * 并行扫描 Claude / Codex / Cursor / DeepCCC 四套目录式技能
 * （<name>/SKILL.md + YAML frontmatter，三套生态同构）。
 *
 * 同名优先级（高 → 低）：deepccc > codex > cursor > claude；
 * 同来源内：project（项目级）> global（用户级）。
 * 目录列表按低 → 高排列，扫描时后者覆盖前者，天然实现优先级。
 *
 * 热加载：SKILL.md 内容带 mtime 缓存，文件变化时自动重读；
 * 目录枚举每次都做（新技能目录立即被发现）。因此"创建技能 →
 * 下一次对话自动生效"，无需重启，也无需常驻 watcher。
 */

import { readdirSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type SkillSource = "deepccc" | "codex" | "cursor" | "claude";
export type SkillScope = "global" | "project";

export interface BuiltinSkill {
  name: string;
  description: string;
  /** SKILL.md 的绝对路径 */
  skillPath: string;
  /** 来源（优先级 deepccc > codex > cursor > claude） */
  source: SkillSource;
  /** global = 用户级；project = 项目级（同来源内 project > global） */
  scope: SkillScope;
}

export interface SkillDirSpec {
  dir: string;
  source: SkillSource;
  scope: SkillScope;
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

// ---------------------------------------------------------------------------
// mtime 热加载缓存：同一进程内重复扫描命中缓存（stat 校验），文件变化自动重读
// ---------------------------------------------------------------------------

const skillFileCache = new Map<string, { mtimeMs: number; content: string }>();

async function readSkillFile(skillPath: string): Promise<string | null> {
  let st;
  try {
    st = await stat(skillPath);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  const cached = skillFileCache.get(skillPath);
  if (cached && cached.mtimeMs === st.mtimeMs) return cached.content;
  const content = await readFile(skillPath, "utf8");
  skillFileCache.set(skillPath, { mtimeMs: st.mtimeMs, content });
  return content;
}

/**
 * 扫描多个 skill 目录（并行读取），按 name 去重。
 * 同名技能：后面的 spec（高优先级）覆盖前面的（低优先级）。
 * 隐藏目录（.system 等）和无 SKILL.md 的目录会被跳过；缺失目录跳过。
 */
export async function scanSkillsDirs(dirs: SkillDirSpec[]): Promise<BuiltinSkill[]> {
  const byName = new Map<string, BuiltinSkill>();

  for (const spec of dirs) {
    let entries;
    try {
      entries = readdirSync(spec.dir, { withFileTypes: true });
    } catch {
      continue; // 目录不存在或不可读：跳过
    }

    // 目录内所有候选 SKILL.md 并行读取（读文件是扫描的瓶颈）
    const results = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map(async (entry) => {
          const skillPath = join(spec.dir, entry.name, "SKILL.md");
          const content = await readSkillFile(skillPath);
          if (content === null) return null;
          const parsed = parseSkillFrontmatter(content);
          if (!parsed) return null;
          return { ...parsed, skillPath };
        }),
    );

    for (const result of results) {
      if (!result) continue;
      byName.set(result.name, {
        name: result.name,
        description: result.description,
        skillPath: result.skillPath,
        source: spec.source,
        scope: spec.scope,
      });
    }
  }

  return [...byName.values()];
}

/**
 * 默认技能扫描目录（按优先级从低到高排列，扫描时后者覆盖前者）：
 * claude(global→project) < cursor(global→project) < codex(global→project) < deepccc(global→project)
 * 其中 codex 全局包含 ~/.codex/skills（CLI 旧路径）与 ~/.agents/skills（标准全局目录）。
 */
export function buildDefaultSkillDirs(cwd: string): SkillDirSpec[] {
  const h = homedir();
  return [
    { dir: join(h, ".claude", "skills"), source: "claude", scope: "global" },
    { dir: join(cwd, ".claude", "skills"), source: "claude", scope: "project" },
    { dir: join(h, ".cursor", "skills"), source: "cursor", scope: "global" },
    { dir: join(cwd, ".cursor", "skills"), source: "cursor", scope: "project" },
    { dir: join(h, ".codex", "skills"), source: "codex", scope: "global" },
    { dir: join(h, ".agents", "skills"), source: "codex", scope: "global" },
    { dir: join(cwd, ".codex", "skills"), source: "codex", scope: "project" },
    { dir: join(h, ".deepccc", "skills"), source: "deepccc", scope: "global" },
    { dir: join(cwd, ".deepccc", "skills"), source: "deepccc", scope: "project" },
  ];
}

/**
 * 生成 skill 索引提示词（注入 system prompt）。
 * 索引只含 name + description + 来源 + 路径，并指示模型在任务匹配时
 * 先用 read_file 读取 SKILL.md 全文再执行；同时声明"创建技能"约定
 * （模型在对话中应把新技能创建到 ~/.deepccc/skills 或项目 .deepccc/skills）。
 */
export function buildSkillsIndexPrompt(skills: BuiltinSkill[]): string {
  if (skills.length === 0) return "";

  const lines = [
    "## Available Skills",
    "Skills are scanned in parallel from Claude/Codex/Cursor/DeepCCC skill directories.",
    "On name conflicts: DeepCCC > Codex > Cursor > Claude wins; within one source, project scope wins over global.",
    "When a user request matches a skill's description, first read its full SKILL.md with read_file, then follow the instructions in it exactly.",
    "",
    ...skills.map((s) => `- **${s.name}** [${s.source}:${s.scope}] (\`${s.skillPath}\`): ${s.description || "(no description)"}`),
    "",
    "## Creating Skills",
    "When the user asks to create a skill, create it as a Codex-style directory skill at",
    "~/.deepccc/skills/<name>/SKILL.md (global, default) or <cwd>/.deepccc/skills/<name>/SKILL.md (project, only when the user explicitly asks for a project-scoped skill).",
    "SKILL.md format:",
    "```",
    "---",
    "name: <skill-name>",
    "description: <one-line description>",
    "---",
    "",
    "<instructions>",
    "```",
    "New skills are picked up automatically on the next message (hot reload); no restart is needed.",
  ];
  return lines.join("\n");
}

/** 生成 Codex 结构的新技能 SKILL.md 模板（供 CLI skill create / 对话创建约定共用） */
export function buildSkillTemplate(name: string, description: string): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "---",
    "",
    `# ${name}`,
    "",
    "<skill instructions>",
    "",
  ].join("\n");
}
