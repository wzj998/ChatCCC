import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyPatchForTool,
  createFileForTool,
  deleteFileForTool,
  editFileForTool,
  listDirForTool,
  moveFileForTool,
  readFileForTool,
  runCommandForTool,
  searchCodeForTool,
} from "../builtin/file-tools.ts";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "chatccc-builtin-tools-"));
  tempDirs.push(dir);
  return dir;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("builtin file tools", () => {
  it("reads a text file with line ranges", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, ".secret.txt"), "one\ntwo\nthree\n", "utf8");

    const result = await readFileForTool(dir, { path: ".secret.txt", startLine: 2, endLine: 3 });

    expect(result).toEqual(expect.objectContaining({
      sha256: sha256("one\ntwo\nthree\n"),
      isBinary: false,
      content: "two\nthree",
      startLine: 2,
      endLine: 3,
      totalLines: 4,
    }));
    expect(result.path).toContain(".secret.txt");
  });

  it("lists directory entries including hidden files", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, ".env"), "TOKEN=x", "utf8");

    const result = await listDirForTool(dir);

    expect(result.entries).toContainEqual(expect.objectContaining({
      name: ".env",
      type: "file",
    }));
  });

  it("searches with the project-bundled ripgrep even when rg is absent from PATH", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "a.ts"), "const marker = 1;\n", "utf8");
    const originalPath = process.env.PATH;
    process.env.PATH = "";

    try {
      const result = await searchCodeForTool(dir, { query: "marker", glob: "*.ts" });

      expect(result.matches).toEqual([
        expect.objectContaining({
          line: 1,
          column: 7,
          text: "const marker = 1;",
        }),
      ]);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("falls back to Node search when no ripgrep executable can be used", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "a.ts"), "const marker = 1;\n", "utf8");
    await mkdir(join(dir, "nested"));
    await writeFile(join(dir, "nested", "b.md"), "xx marker = 2\n", "utf8");
    await writeFile(join(dir, "ignored.txt"), "marker = 3\n", "utf8");
    const originalPath = process.env.PATH;
    process.env.PATH = "";

    try {
      const result = await searchCodeForTool(
        dir,
        { query: "marker\\s*=\\s*\\d", glob: "**/*.{ts,md}", maxResults: 10 },
        undefined,
        { ripgrepCommands: [join(dir, "missing-rg")] },
      );

      expect(result.matches).toEqual([
        expect.objectContaining({ path: join(dir, "a.ts"), line: 1, column: 7 }),
        expect.objectContaining({ path: join(dir, "nested", "b.md"), line: 1, column: 4 }),
      ]);
      expect(result.truncated).toBe(false);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("runs non-interactive shell commands in the requested cwd", async () => {
    const dir = await makeTempDir();

    const result = await runCommandForTool(dir, {
      command: "node -e \"process.stdout.write(process.cwd())\"",
      timeoutMs: 5_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout.toLowerCase()).toBe(dir.toLowerCase());
    expect(result.stderr).toBe("");
  });

  it("returns non-zero command exits without throwing", async () => {
    const dir = await makeTempDir();

    const result = await runCommandForTool(dir, {
      command: "node -e \"process.stderr.write('failed'); process.exit(7)\"",
      timeoutMs: 5_000,
    });

    expect(result.exitCode).toBe(7);
    expect(result.stderr).toBe("failed");
    expect(result.timedOut).toBe(false);
  });

  it("edits a file with exact replacements and a SHA-256 precondition", async () => {
    const dir = await makeTempDir();
    const file = join(dir, "edit.txt");
    await writeFile(file, "alpha\nbeta\ngamma\n", "utf8");

    const result = await editFileForTool(dir, {
      path: "edit.txt",
      expectedSha256: sha256("alpha\nbeta\ngamma\n"),
      edits: [{ oldText: "beta", newText: "BETA" }],
    });

    expect(result).toEqual(expect.objectContaining({
      changed: true,
      editsApplied: 1,
      beforeSha256: sha256("alpha\nbeta\ngamma\n"),
      afterSha256: sha256("alpha\nBETA\ngamma\n"),
    }));
    await expect(readFile(file, "utf8")).resolves.toBe("alpha\nBETA\ngamma\n");
  });

  it("rejects edits when the SHA-256 precondition does not match", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "edit.txt"), "current\n", "utf8");

    await expect(editFileForTool(dir, {
      path: "edit.txt",
      expectedSha256: sha256("stale\n"),
      edits: [{ oldText: "current", newText: "next" }],
    })).rejects.toThrow("SHA-256 mismatch");
  });

  it("creates and deletes files", async () => {
    const dir = await makeTempDir();

    const created = await createFileForTool(dir, {
      path: "created.txt",
      content: "created\n",
    });
    expect(created).toEqual(expect.objectContaining({
      changed: true,
      afterSha256: sha256("created\n"),
    }));
    await expect(readFile(join(dir, "created.txt"), "utf8")).resolves.toBe("created\n");

    const deleted = await deleteFileForTool(dir, {
      path: "created.txt",
      expectedSha256: sha256("created\n"),
    });
    expect(deleted).toEqual(expect.objectContaining({
      deleted: true,
      beforeSha256: sha256("created\n"),
    }));
    await expect(stat(join(dir, "created.txt"))).rejects.toThrow();
  });

  it("moves files and creates the destination directory", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "old.txt"), "move me\n", "utf8");

    const result = await moveFileForTool(dir, {
      sourcePath: "old.txt",
      destinationPath: "nested/new.txt",
      expectedSourceSha256: sha256("move me\n"),
    });

    expect(result).toEqual(expect.objectContaining({
      moved: true,
      sourceSha256: sha256("move me\n"),
    }));
    await expect(stat(join(dir, "old.txt"))).rejects.toThrow();
    await expect(readFile(join(dir, "nested", "new.txt"), "utf8")).resolves.toBe("move me\n");
  });

  it("applies a unified diff patch", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "patch.txt"), "one\ntwo\nthree\n", "utf8");

    const result = await applyPatchForTool(dir, {
      patch: [
        "--- a/patch.txt",
        "+++ b/patch.txt",
        "@@ -1,4 +1,4 @@",
        " one",
        "-two",
        "+TWO",
        " three",
        " ",
        "",
      ].join("\n"),
      expectedSha256ByPath: {
        "patch.txt": sha256("one\ntwo\nthree\n"),
      },
    });

    expect(result.changedFiles).toEqual([
      expect.objectContaining({
        action: "edit",
        beforeSha256: sha256("one\ntwo\nthree\n"),
        afterSha256: sha256("one\nTWO\nthree\n"),
      }),
    ]);
    await expect(readFile(join(dir, "patch.txt"), "utf8")).resolves.toBe("one\nTWO\nthree\n");
  });
});
