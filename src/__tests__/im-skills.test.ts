import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

  it("renders separate WeChat image, file, and video capability docs", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "chatccc-im-skills-cache-"));
    const prompt = await buildImSkillsPrompt({
      variables: {
        cwd: "C:/work",
        im_skills_cache_dir: tempRoot,
        wechat_send_image_script: "C:/work/im-skills/wechat-image-skill/send-image.mjs",
        wechat_send_file_script: "C:/work/im-skills/wechat-file-skill/send-file.mjs",
        wechat_send_video_script: "C:/work/im-skills/wechat-video-skill/send-video.mjs",
      },
    });

    const exported = await exportSkillSubDocs(
      {
        variables: {
          cwd: "C:/work",
          im_skills_cache_dir: tempRoot,
          wechat_send_image_script: "C:/work/im-skills/wechat-image-skill/send-image.mjs",
          wechat_send_file_script: "C:/work/im-skills/wechat-file-skill/send-file.mjs",
          wechat_send_video_script: "C:/work/im-skills/wechat-video-skill/send-video.mjs",
        },
      },
      tempRoot,
    );

    expect(prompt).toContain("[ChatCCC IM skill: wechat-image-skill]");
    expect(prompt).toContain("[ChatCCC IM skill: wechat-file-skill]");
    expect(prompt).toContain("[ChatCCC IM skill: wechat-video-skill]");
    expect(prompt).not.toContain("[ChatCCC IM skill: wechat-skill]");
    expect(prompt).toContain("Receive images");
    expect(prompt).toContain("Send images");
    expect(prompt).toContain("Receive files");
    expect(prompt).toContain("Send files");
    expect(prompt).toContain("Receive videos");
    expect(prompt).toContain("Send videos");
    expect(prompt).toContain("receive-send-image.md");
    expect(prompt).toContain("receive-send-file.md");
    expect(prompt).toContain("receive-send-video.md");
    expect(prompt).not.toContain("{{wechat_send_image_script}}");
    expect(prompt).not.toContain("{{wechat_send_file_script}}");
    expect(prompt).not.toContain("{{wechat_send_video_script}}");
    expect(exported.some((file) => file.endsWith(join("wechat-image-skill", "receive-send-image.md")))).toBe(true);
    expect(exported.some((file) => file.endsWith(join("wechat-file-skill", "receive-send-file.md")))).toBe(true);
    expect(exported.some((file) => file.endsWith(join("wechat-video-skill", "receive-send-video.md")))).toBe(true);
    await expect(readFile(join(tempRoot, "wechat-image-skill", "receive-send-image.md"), "utf8")).resolves.toContain(
      "send-image.mjs",
    );
    await expect(readFile(join(tempRoot, "wechat-file-skill", "receive-send-file.md"), "utf8")).resolves.toContain(
      "send-file.mjs",
    );
    await expect(readFile(join(tempRoot, "wechat-video-skill", "receive-send-video.md"), "utf8")).resolves.toContain(
      "send-video.mjs",
    );
  });
});
