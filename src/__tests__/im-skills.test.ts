import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { buildImSkillsPrompt, exportSkillSubDocs } from "../im-skills.ts";

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

  it("filters skills by enabledSkillNames", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "chatccc-im-skills-filter-"));
    const feishuDir = join(tempRoot, "feishu-skill");
    const wechatDir = join(tempRoot, "wechat-skill");
    const outDir = join(tempRoot, "out");
    await mkdir(feishuDir);
    await mkdir(wechatDir);
    await writeFile(join(feishuDir, "skill.md"), "Feishu {{cwd}}", "utf-8");
    await writeFile(join(feishuDir, "receive-send-image.md"), "Feishu doc", "utf-8");
    await writeFile(join(wechatDir, "skill.md"), "WeChat {{cwd}}", "utf-8");
    await writeFile(join(wechatDir, "receive-send-image.md"), "WeChat doc", "utf-8");

    const input = {
      skillsDir: tempRoot,
      enabledSkillNames: ["feishu-skill"],
      variables: { cwd: "C:/work" },
    };
    const prompt = await buildImSkillsPrompt(input);
    const exported = await exportSkillSubDocs(input, outDir);

    expect(prompt).toContain("[ChatCCC IM skill: feishu-skill]");
    expect(prompt).toContain("Feishu C:/work");
    expect(prompt).not.toContain("[ChatCCC IM skill: wechat-skill]");
    expect(prompt).not.toContain("WeChat C:/work");
    expect(exported).toHaveLength(1);
    expect(exported[0]).toContain(join("feishu-skill", "receive-send-image.md"));
    await expect(readFile(join(outDir, "feishu-skill", "receive-send-image.md"), "utf8")).resolves.toContain(
      "Feishu doc",
    );
  });

  it("skips filtering when enabledSkillNames is omitted", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "chatccc-im-skills-all-"));
    const feishuDir = join(tempRoot, "feishu-skill");
    const wechatDir = join(tempRoot, "wechat-skill");
    const outDir = join(tempRoot, "out");
    await mkdir(feishuDir);
    await mkdir(wechatDir);
    await writeFile(join(feishuDir, "skill.md"), "Feishu {{cwd}}", "utf-8");
    await writeFile(join(feishuDir, "receive-send-image.md"), "Feishu doc", "utf-8");
    await writeFile(join(wechatDir, "skill.md"), "WeChat {{cwd}}", "utf-8");
    await writeFile(join(wechatDir, "receive-send-image.md"), "WeChat doc", "utf-8");

    const prompt = await buildImSkillsPrompt({
      skillsDir: tempRoot,
      variables: { cwd: "C:/work" },
    });
    const exported = await exportSkillSubDocs({ skillsDir: tempRoot, variables: { cwd: "C:/work" } }, outDir);

    expect(prompt).toContain("[ChatCCC IM skill: feishu-skill]");
    expect(prompt).toContain("[ChatCCC IM skill: wechat-skill]");
    expect(exported.length).toBeGreaterThanOrEqual(2);
  });
});
