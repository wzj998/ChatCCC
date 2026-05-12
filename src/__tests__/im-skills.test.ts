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
        "POST {{send_image_url}}",
        "Authorization: Bearer {{send_image_token}}",
        "Content-Type: application/json; charset=utf-8",
        "cwd={{cwd}}",
      ].join("\n"),
      "utf-8",
    );

    const prompt = await buildImSkillsPrompt({
      skillsDir: tempRoot,
      variables: {
        cwd: "C:/work",
        send_image_url: "http://127.0.0.1:18080/api/agent/send-image",
        send_image_token: "tok_test",
      },
    });

    expect(prompt).toContain("[ChatCCC IM skill: feishu-skill]");
    expect(prompt).toContain("POST http://127.0.0.1:18080/api/agent/send-image");
    expect(prompt).toContain("Authorization: Bearer tok_test");
    expect(prompt).toContain("Content-Type: application/json; charset=utf-8");
    expect(prompt).toContain("cwd=C:/work");
    expect(prompt).not.toContain("{{");
  });
});
