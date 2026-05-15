import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";

import { PROJECT_ROOT } from "./config.ts";

export const DEFAULT_IM_SKILLS_DIR = join(PROJECT_ROOT, "im-skills");

export interface ImSkillVariableMap {
  [key: string]: string | undefined;
}

export interface BuildImSkillsPromptInput {
  skillsDir?: string;
  enabledSkillNames?: readonly string[];
  variables: ImSkillVariableMap;
}

interface ImSkillDoc {
  name: string;
  content: string;
}

function renderTemplate(template: string, variables: ImSkillVariableMap): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    return variables[key] ?? "";
  });
}

async function loadSkillDocs(skillsDir: string): Promise<ImSkillDoc[]> {
  let entries;
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const docs = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(async (entry): Promise<ImSkillDoc | null> => {
        const skillPath = join(skillsDir, entry.name, "skill.md");
        try {
          const content = await readFile(skillPath, "utf-8");
          return { name: entry.name, content };
        } catch {
          return null;
        }
      }),
  );
  return docs.filter((doc): doc is ImSkillDoc => doc !== null);
}

export async function buildImSkillsPrompt(input: BuildImSkillsPromptInput): Promise<string> {
  const skillsDir = input.skillsDir ?? DEFAULT_IM_SKILLS_DIR;
  const enabledSkillNames = input.enabledSkillNames
    ? new Set(input.enabledSkillNames)
    : null;
  const docs = await loadSkillDocs(skillsDir);
  return docs
    .filter((doc) => !enabledSkillNames || enabledSkillNames.has(doc.name))
    .map((doc) => {
      const rendered = renderTemplate(doc.content, input.variables).trim();
      return [
        `[ChatCCC IM skill: ${doc.name}]`,
        rendered,
        `[/ChatCCC IM skill: ${doc.name}]`,
      ].join("\n");
    })
    .join("\n\n");
}

/**
 * 渲染技能目录下的子文档（skill.md 除外）并写入 outputDir。
 * 返回写入的文件路径列表。通常在会话初始化时调用，写入的文档供 Agent 按需读取。
 */
export async function exportSkillSubDocs(
  input: BuildImSkillsPromptInput,
  outputDir: string,
): Promise<string[]> {
  const skillsDir = input.skillsDir ?? DEFAULT_IM_SKILLS_DIR;
  const enabledSkillNames = input.enabledSkillNames
    ? new Set(input.enabledSkillNames)
    : null;
  const files: string[] = [];

  let entries;
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (enabledSkillNames && !enabledSkillNames.has(entry.name)) continue;
    const skillPath = join(skillsDir, entry.name);

    let subFiles;
    try {
      subFiles = await readdir(skillPath);
    } catch {
      continue;
    }

    for (const sf of subFiles) {
      if (sf === "skill.md" || !sf.endsWith(".md")) continue;
      const content = await readFile(join(skillPath, sf), "utf-8");
      const rendered = renderTemplate(content, input.variables);
      const outPath = join(outputDir, entry.name, sf);
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, rendered, "utf-8");
      files.push(outPath);
    }
  }

  return files;
}
