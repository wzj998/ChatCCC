import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  normalizeSkillPathForPrompt,
  parseSkillFrontmatter,
  scanSkillsDirs,
  buildDefaultSkillDirs,
  buildSkillsIndexPrompt,
  buildSkillTemplate,
  type SkillDirSpec,
  type SkillSource,
  type SkillScope,
} from "../skills.js";

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "deepccc-skills-"));
});

afterEach(() => {
  try {
    rmSync(tempRoot, { recursive: true, force: true });
  } catch {}
});

function makeSkill(specDir: string, name: string, description: string): string {
  const dir = join(specDir, name);
  mkdirSync(dir, { recursive: true });
  const skillPath = join(dir, "SKILL.md");
  writeFileSync(skillPath, `---\nname: ${name}\ndescription: ${description}\n---\n\nbody\n`, "utf8");
  return skillPath;
}

function spec(
  dir: string,
  source: SkillSource,
  scope: SkillScope = "global",
): SkillDirSpec {
  return { dir, source, scope };
}

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

describe("scanSkillsDirs priority matrix", () => {
  it("codex wins over cursor, cursor wins over claude for same-name skills", async () => {
    const claudeDir = join(tempRoot, "claude");
    const cursorDir = join(tempRoot, "cursor");
    const codexDir = join(tempRoot, "codex");
    makeSkill(claudeDir, "dupe", "claude version");
    makeSkill(cursorDir, "dupe", "cursor version");
    makeSkill(codexDir, "dupe", "codex version");
    makeSkill(codexDir, "only-codex", "codex only");

    const skills = await scanSkillsDirs([
      spec(claudeDir, "claude"),
      spec(cursorDir, "cursor"),
      spec(codexDir, "codex"),
    ]);

    const byName = new Map(skills.map((s) => [s.name, s]));
    expect(byName.get("dupe")?.description).toBe("codex version");
    expect(byName.get("dupe")?.source).toBe("codex");
    expect(byName.get("dupe")?.skillPath).toContain(join("codex", "dupe"));
    expect(byName.get("only-codex")?.source).toBe("codex");
  });

  it("project scope wins over global scope within the same source", async () => {
    const globalCodex = join(tempRoot, "codex-global");
    const projectCodex = join(tempRoot, "codex-project");
    makeSkill(globalCodex, "dup", "global version");
    makeSkill(projectCodex, "dup", "project version");

    const skills = await scanSkillsDirs([
      spec(globalCodex, "codex", "global"),
      spec(projectCodex, "codex", "project"),
    ]);

    const byName = new Map(skills.map((s) => [s.name, s]));
    expect(byName.get("dup")?.description).toBe("project version");
    expect(byName.get("dup")?.scope).toBe("project");
  });

  it("deepccc source has the highest priority over codex", async () => {
    const codexDir = join(tempRoot, "codex");
    const deepcccDir = join(tempRoot, "deepccc");
    makeSkill(codexDir, "dup", "from codex");
    makeSkill(deepcccDir, "dup", "from deepccc");

    const skills = await scanSkillsDirs([
      spec(codexDir, "codex"),
      spec(deepcccDir, "deepccc"),
    ]);

    expect(skills.find((s) => s.name === "dup")?.description).toBe("from deepccc");
    expect(skills.find((s) => s.name === "dup")?.source).toBe("deepccc");
  });

  it("skips hidden dirs, dirs without SKILL.md, and missing dirs", async () => {
    const dir = join(tempRoot, "src");
    mkdirSync(join(dir, ".system"), { recursive: true });
    writeFileSync(join(dir, ".system", "SKILL.md"), "---\nname: system-skill\ndescription: x\n---\n", "utf8");
    mkdirSync(join(dir, "no-skill-dir"));

    makeSkill(dir, "ok", "fine");
    const skills = await scanSkillsDirs([
      spec(join(tempRoot, "missing-dir"), "codex"),
      spec(dir, "codex"),
    ]);

    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("ok");
  });
});

describe("scanSkillsDirs hot reload (mtime cache)", () => {
  it("re-reads a skill after its SKILL.md content changes", async () => {
    const dir = join(tempRoot, "src");
    const skillPath = makeSkill(dir, "live", "v1");

    const first = await scanSkillsDirs([spec(dir, "deepccc")]);
    expect(first.find((s) => s.name === "live")?.description).toBe("v1");

    writeFileSync(skillPath, "---\nname: live\ndescription: v2\n---\n\nbody\n", "utf8");
    utimesSync(skillPath, new Date(Date.now() + 3000), new Date(Date.now() + 3000)); // 强制 mtime 前进

    const second = await scanSkillsDirs([spec(dir, "deepccc")]);
    expect(second.find((s) => s.name === "live")?.description).toBe("v2");
  });

  it("new skill dirs are picked up on the next scan", async () => {
    const dir = join(tempRoot, "src");
    makeSkill(dir, "a", "A");

    const first = await scanSkillsDirs([spec(dir, "deepccc")]);
    expect(first).toHaveLength(1);

    makeSkill(dir, "b", "B"); // 新技能，无需改 mtime（目录枚举每次都做）
    const second = await scanSkillsDirs([spec(dir, "deepccc")]);
    expect(second.map((s) => s.name).sort()).toEqual(["a", "b"]);
  });

  it("unchanged skills return identical results across scans", async () => {
    const dir = join(tempRoot, "src");
    makeSkill(dir, "a", "A");

    const first = await scanSkillsDirs([spec(dir, "deepccc")]);
    const second = await scanSkillsDirs([spec(dir, "deepccc")]);
    expect(second).toEqual(first);
  });
});

describe("buildDefaultSkillDirs", () => {
  it("orders dirs low->high priority: claude < cursor < codex < deepccc, project after global", () => {
    const dirs = buildDefaultSkillDirs("C:/proj");
    expect(dirs.map((d) => `${d.source}:${d.scope}`)).toEqual([
      "claude:global",
      "claude:project",
      "cursor:global",
      "cursor:project",
      "codex:global",
      "codex:global",
      "codex:project",
      "deepccc:global",
      "deepccc:project",
    ]);
  });

  it("points codex global dirs at ~/.codex/skills and ~/.agents/skills", () => {
    const dirs = buildDefaultSkillDirs("C:/proj").filter((d) => d.source === "codex" && d.scope === "global");
    expect(dirs.map((d) => d.dir)).toEqual([
      join(require("node:os").homedir(), ".codex", "skills"),
      join(require("node:os").homedir(), ".agents", "skills"),
    ]);
  });
});

describe("normalizeSkillPathForPrompt", () => {
  it("abbreviates home-directory paths with ~ and normalizes separators", () => {
    const home = homedir();
    const abs = join(home, ".codex", "skills", "x", "SKILL.md");
    expect(normalizeSkillPathForPrompt(abs)).toBe("~/.codex/skills/x/SKILL.md");
    expect(normalizeSkillPathForPrompt(home)).toBe("~");
  });

  it("keeps paths outside the home directory unchanged (separators normalized)", () => {
    expect(normalizeSkillPathForPrompt("C:\\proj\\.claude\\skills\\x\\SKILL.md")).toBe(
      "C:/proj/.claude/skills/x/SKILL.md",
    );
  });
});

describe("buildSkillsIndexPrompt", () => {
  it("renders index with source markers and the skill creation convention", () => {
    const prompt = buildSkillsIndexPrompt([
      {
        name: "feishu-doc",
        description: "下载飞书文档",
        skillPath: "C:/x/feishu-doc/SKILL.md",
        source: "codex",
        scope: "global",
      },
    ]);

    expect(prompt).toContain("## 可用技能");
    expect(prompt).toContain("**feishu-doc**");
    expect(prompt).toContain("[codex:global]");
    expect(prompt).toContain("## 创建技能");
    expect(prompt).toContain(".deepccc/skills");
    expect(prompt).toContain("read_file");
  });

  it("renders home-abbreviated skill paths so the prompt stays stable across machines", () => {
    const home = homedir();
    const prompt = buildSkillsIndexPrompt([
      {
        name: "demo",
        description: "d",
        skillPath: join(home, ".codex", "skills", "demo", "SKILL.md"),
        source: "codex",
        scope: "global",
      },
    ]);

    expect(prompt).toContain("~/.codex/skills/demo/SKILL.md");
    expect(prompt).not.toContain(home);
  });

  it("returns empty string for no skills", () => {
    expect(buildSkillsIndexPrompt([])).toBe("");
  });
});

describe("buildSkillTemplate", () => {
  it("renders a Codex-style SKILL.md with frontmatter", () => {
    const tpl = buildSkillTemplate("my-skill", "does something");
    expect(tpl.startsWith("---")).toBe(true);
    expect(tpl).toContain("name: my-skill");
    expect(tpl).toContain("description: does something");
    expect(tpl).toContain("# my-skill");
  });

  it("defaults description to empty when omitted", () => {
    const tpl = buildSkillTemplate("bare-skill", "");
    expect(tpl).toContain("description: ");
  });
});
