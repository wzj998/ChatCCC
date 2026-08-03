import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildSkillsIndexPrompt,
  parseSkillFrontmatter,
  scanSkillsDirs,
} from "../builtin/skills.ts";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "chatccc-skills-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("parseSkillFrontmatter", () => {
  it("parses name and description from frontmatter", () => {
    const content = [
      "---",
      "name: feishu-doc-download-md",
      "description: 下载飞书文档为 Markdown",
      "---",
      "",
      "# 正文",
    ].join("\n");
    expect(parseSkillFrontmatter(content)).toEqual({
      name: "feishu-doc-download-md",
      description: "下载飞书文档为 Markdown",
    });
  });

  it("returns null when there is no frontmatter", () => {
    expect(parseSkillFrontmatter("# just a heading")).toBeNull();
  });

  it("tolerates missing description", () => {
    expect(parseSkillFrontmatter("---\nname: minimal-skill\n---\n\nbody")).toEqual({
      name: "minimal-skill",
      description: "",
    });
  });

  it("handles CRLF line endings", () => {
    const content = "---\r\nname: crlf-skill\r\ndescription: CRLF 描述\r\n---\r\n\r\nbody";
    expect(parseSkillFrontmatter(content)).toEqual({
      name: "crlf-skill",
      description: "CRLF 描述",
    });
  });
});

describe("scanSkillsDirs", () => {
  it("scans multiple dirs, skips hidden/system dirs, dedupes by name (later dir wins)", async () => {
    const dir = await makeTempDir();
    const userA = join(dir, "codex-skills");
    const userB = join(dir, "agents-skills");
    const project = join(dir, "project-codex");
    await mkdir(join(userA, "feishu-doc"), { recursive: true });
    await mkdir(join(userA, ".system"), { recursive: true });
    await mkdir(join(userA, "no-skill-dir"));
    await mkdir(join(userB, "feishu-doc"), { recursive: true });
    await mkdir(join(userB, "another"), { recursive: true });
    await mkdir(join(project, "feishu-doc"), { recursive: true });

    await writeFile(
      join(userA, "feishu-doc", "SKILL.md"),
      "---\nname: feishu-doc\ndescription: 用户级 A\n---\n",
      "utf8",
    );
    await writeFile(
      join(userA, ".system", "SKILL.md"),
      "---\nname: system-skill\ndescription: 内置\n---\n",
      "utf8",
    );
    await writeFile(
      join(userB, "feishu-doc", "SKILL.md"),
      "---\nname: feishu-doc\ndescription: 用户级 B\n---\n",
      "utf8",
    );
    await writeFile(
      join(userB, "another", "SKILL.md"),
      "---\nname: another\ndescription: 另一个\n---\n",
      "utf8",
    );
    await writeFile(
      join(project, "feishu-doc", "SKILL.md"),
      "---\nname: feishu-doc\ndescription: 项目级覆盖\n---\n",
      "utf8",
    );

    const skills = scanSkillsDirs([userA, userB, project]);

    // 去重：同名保留一个，后面的目录（项目级）覆盖前面的（用户级）
    expect(skills).toHaveLength(2);
    const byName = new Map(skills.map((s) => [s.name, s]));
    expect(byName.get("feishu-doc")?.description).toBe("项目级覆盖");
    expect(byName.get("feishu-doc")?.skillPath).toBe(join(project, "feishu-doc", "SKILL.md"));
    expect(byName.get("another")?.description).toBe("另一个");
    expect(byName.has("system-skill")).toBe(false); // 隐藏目录被排除
  });

  it("skips missing directories and dirs without SKILL.md", async () => {
    const dir = await makeTempDir();
    await mkdir(join(dir, "empty-dir"));

    const skills = scanSkillsDirs([join(dir, "missing-dir"), join(dir, "empty-dir")]);

    expect(skills).toEqual([]);
  });
});

describe("buildSkillsIndexPrompt", () => {
  it("renders a skill index with names, paths and descriptions", () => {
    const prompt = buildSkillsIndexPrompt([
      {
        name: "feishu-doc",
        description: "下载飞书文档",
        skillPath: "C:\\users\\x\\skills\\feishu-doc\\SKILL.md",
      },
    ]);

    expect(prompt).toContain("## Available Skills");
    expect(prompt).toContain("**feishu-doc**");
    expect(prompt).toContain("下载飞书文档");
    expect(prompt).toContain("C:\\users\\x\\skills\\feishu-doc\\SKILL.md");
    expect(prompt).toContain("read_file");
  });

  it("returns empty string for no skills", () => {
    expect(buildSkillsIndexPrompt([])).toBe("");
  });
});
