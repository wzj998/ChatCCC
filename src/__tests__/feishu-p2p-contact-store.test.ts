import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FeishuP2pContactStore } from "../agent-team/repositories/feishu-p2p-contact-store.ts";

describe("Feishu P2P contact store", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("persists the most recent private-message sender across store instances", async () => {
    const root = await mkdtemp(join(tmpdir(), "chatccc-p2p-contact-"));
    tempRoots.push(root);
    const filePath = join(root, "contact.json");
    const store = new FeishuP2pContactStore({ filePath });

    await store.record({ openId: "ou_first", chatId: "oc_first", receivedAt: "2026-08-09T10:00:00.000Z" });
    await store.record({ openId: "ou_latest", chatId: "oc_latest", receivedAt: "2026-08-09T10:01:00.000Z" });

    await expect(new FeishuP2pContactStore({ filePath }).get()).resolves.toEqual({
      openId: "ou_latest",
      chatId: "oc_latest",
      receivedAt: "2026-08-09T10:01:00.000Z",
    });
  });

  it("ignores legacy simulator contacts that are not valid Feishu open_ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "chatccc-p2p-contact-invalid-"));
    tempRoots.push(root);
    const filePath = join(root, "contact.json");
    await writeFile(filePath, JSON.stringify({
      openId: "ou-user",
      chatId: "feishu-p2p-sim",
      receivedAt: "2026-08-17T08:45:11.501Z",
    }), "utf8");

    const store = new FeishuP2pContactStore({ filePath });
    await expect(store.get()).resolves.toBeNull();
    await expect(store.record({
      openId: "ou-user",
      chatId: "feishu-p2p-sim",
      receivedAt: "2026-08-17T08:45:11.501Z",
    })).rejects.toThrow("Invalid Feishu openId");
  });
});
