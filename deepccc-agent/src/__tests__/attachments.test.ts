import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AttachmentStore,
  buildAttachmentPrompt,
  parseAttachmentPrompt,
} from "../attachments.js";

const roots: string[] = [];
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<AttachmentStore> {
  const rootDir = await mkdtemp(join(tmpdir(), "deepccc-attachments-"));
  roots.push(rootDir);
  let id = 0;
  return new AttachmentStore({ rootDir, idFactory: () => `image-${++id}` });
}

describe("DeepCCC attachments", () => {
  it("stores supported images, builds a path-based Agent prompt, and parses it for display", async () => {
    const store = await fixture();
    const attachment = await store.save("session-a", {
      originalName: "screen.png",
      bytes: PNG,
    });

    expect(attachment).toMatchObject({
      attachmentId: "image-1",
      originalName: "screen.png",
      mimeType: "image/png",
      size: PNG.length,
    });
    expect(attachment.absolutePath).toContain("session-a");

    const prompt = buildAttachmentPrompt("检查这个界面", [attachment]);
    expect(prompt).toContain(JSON.stringify(attachment.absolutePath));
    expect(prompt).toContain("不要假设模型原生支持图片");
    expect(parseAttachmentPrompt(prompt)).toEqual({
      text: "检查这个界面",
      attachments: [attachment],
    });

    const loaded = await store.read("session-a", attachment.attachmentId);
    expect(loaded?.bytes).toEqual(PNG);
  });

  it("imports CLI image paths, rejects spoofed content, and removes session attachments", async () => {
    const store = await fixture();
    const sourceRoot = await mkdtemp(join(tmpdir(), "deepccc-attachment-source-"));
    roots.push(sourceRoot);
    const source = join(sourceRoot, "input.png");
    await writeFile(source, PNG);

    const imported = await store.importFile("session-b", source);
    expect(imported.mimeType).toBe("image/png");
    await expect(store.save("session-b", {
      originalName: "fake.png",
      bytes: Buffer.from("not an image"),
    })).rejects.toThrow(/PNG, JPEG, or WebP/);

    await store.deleteSession("session-b");
    expect(await store.get("session-b", imported.attachmentId)).toBeNull();
  });
});
