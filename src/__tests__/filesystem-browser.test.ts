import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { NodeFilesystemBrowser } from "../agent-team/infrastructure/filesystem-browser.ts";

describe("Node-backed filesystem browser", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "chatccc-filesystem-browser-"));
    tempRoots.push(root);
    await mkdir(join(root, "alpha"));
    await mkdir(join(root, ".hidden"));
    await writeFile(join(root, "plain.txt"), "not a directory", "utf8");
    const browser = new NodeFilesystemBrowser({ defaultDirectory: root, homeDirectory: root });
    return { root, browser };
  }

  it("lists only directories and hides dot-prefixed directories by default", async () => {
    const { root, browser } = await fixture();

    const listing = await browser.listDirectories(root, false);
    expect(listing.entries.map((entry) => entry.name)).toEqual(["alpha"]);
    expect(listing.entries[0]).toMatchObject({ path: join(root, "alpha"), hidden: false });

    const withHidden = await browser.listDirectories(root, true);
    expect(withHidden.entries.map((entry) => entry.name)).toEqual([".hidden", "alpha"]);
  });

  it("includes directory symlinks when the platform permits creating them", async () => {
    const { root, browser } = await fixture();
    try {
      await symlink(join(root, "alpha"), join(root, "alpha-link"), "junction");
    } catch {
      return;
    }

    const listing = await browser.listDirectories(root, false);
    expect(listing.entries.map((entry) => entry.name)).toContain("alpha-link");
  });

  it("returns reusable locations and canonicalizes the final selection", async () => {
    const { root, browser } = await fixture();

    expect(await browser.listLocations()).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "当前工作目录", path: root }),
      expect.objectContaining({ label: "用户目录", path: root }),
    ]));
    expect(await browser.validateDirectory(join(root, "alpha", "..", "alpha"))).toBe(join(root, "alpha"));
    await expect(browser.validateDirectory(join(root, "plain.txt"))).rejects.toMatchObject({ code: "invalid_request" });
  });
});
