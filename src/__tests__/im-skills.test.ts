import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { buildImSkillsPrompt } from "../im-skills.ts";

let tempRoot: string | null = null;

describe("IM skills prompt rendering", () => {
  afterEach(async () => {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  });

  it("loads skill.md files and renders runtime variables", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "chatccc-im-skills-"));
    const skillDir = join(tempRoot, "feishu-skill");
    await mkdir(skillDir);
    await writeFile(
      join(skillDir, "skill.md"),
      [
        "---",
        "name: feishu-skill",
        "---",
        "GET {{session_grants_url}}?sid={{session_id}}",
        "cwd={{cwd}}",
      ].join("\n"),
      "utf-8",
    );

    const prompt = await buildImSkillsPrompt({
      skillsDir: tempRoot,
      variables: {
        cwd: "C:/work",
        session_grants_url: "http://127.0.0.1:18080/api/agent/session-grants",
        session_id: "sid_test",
      },
    });

    expect(prompt).toContain("[ChatCCC IM skill: feishu-skill]");
    expect(prompt).toContain("GET http://127.0.0.1:18080/api/agent/session-grants?sid=sid_test");
    expect(prompt).toContain("cwd=C:/work");
    expect(prompt).not.toContain("{{");
  });
});
