import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyPatchForTool,
  commandKillForTool,
  commandOutputForTool,
  createBuiltinFileTools,
  createFileForTool,
  deleteFileForTool,
  editFileForTool,
  expandHomePath,
  killAllBackgroundCommands,
  listDirForTool,
  moveFileForTool,
  readFileForTool,
  runCommandForTool,
  searchCodeForTool,
  withGitCoAuthor,
} from "../file-tools.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "deepccc-tools-"));
  tempDirs.push(dir);
  return dir;
}

describe("expandHomePath", () => {
  it("expands ~ and ~/ (both separators) to the user home directory", () => {
    const home = homedir();
    expect(expandHomePath("~")).toBe(home);
    expect(expandHomePath("~/x/y.txt")).toBe(join(home, "x", "y.txt"));
    expect(expandHomePath("~\\x\\y.txt")).toBe(join(home, "x", "y.txt"));
  });

  it("leaves absolute paths and other inputs unchanged", () => {
    expect(expandHomePath("C:/a/b")).toBe("C:/a/b");
    expect(expandHomePath("~other/x")).toBe("~other/x");
    expect(expandHomePath("")).toBe("");
  });
});

async function hasRg(): Promise<boolean> {
  try {
    await execFileAsync("rg", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("DeepCCC file tools", () => {
  it("presents a supported local image as a structured artifact", async () => {
    const dir = await makeTempDir();
    const imagePath = join(dir, "result.png");
    await writeFile(imagePath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]));
    const tools = createBuiltinFileTools(dir) as unknown as Record<
      string,
      { execute: (input: unknown, options?: { abortSignal?: AbortSignal }) => Promise<unknown> }
    >;

    await expect(tools.present_file.execute({ path: "result.png", caption: "运行结果" })).resolves.toEqual(
      expect.objectContaining({
        path: imagePath,
        name: "result.png",
        mimeType: "image/png",
        caption: "运行结果",
      }),
    );
  });

  it("adds the DeepCCC trailer to git commits and chained git commits", () => {
    const identity = { enabled: true, name: "DeepCCC", email: "20184052+wzj998@users.noreply.github.com" };
    expect(withGitCoAuthor('git commit -m "feat: x"', identity)).toContain(
      'git commit --trailer "Co-authored-by: DeepCCC <20184052+wzj998@users.noreply.github.com>"',
    );
    expect(withGitCoAuthor('git add -A && git commit -m "feat: x"', identity)).toContain(
      '&& git commit --trailer "Co-authored-by: DeepCCC <20184052+wzj998@users.noreply.github.com>"',
    );
  });

  it("does not add a disabled or duplicate DeepCCC trailer", () => {
    const enabled = { enabled: true, name: "DeepCCC", email: "20184052+wzj998@users.noreply.github.com" };
    expect(withGitCoAuthor("git commit -m x", { ...enabled, enabled: false })).toBe("git commit -m x");
    const existing = 'git commit -m "x\\n\\nCo-authored-by: DeepCCC <20184052+wzj998@users.noreply.github.com>"';
    expect(withGitCoAuthor(existing, enabled)).toBe(existing);
  });
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

  it("searches code with rg without using a shell", async () => {
    if (!await hasRg()) return;

    const dir = await makeTempDir();
    await writeFile(join(dir, "a.ts"), "const marker = 1;\n", "utf8");

    const result = await searchCodeForTool(dir, { query: "marker", glob: "*.ts" });

    expect(result.matches).toEqual([
      expect.objectContaining({
        line: 1,
        text: "const marker = 1;",
      }),
    ]);
  });

  it("task tool delegates to the runTask executor with cwd resolution context", async () => {
    const dir = await makeTempDir();
    const runTask = vi.fn(async () => "子代理结果");
    const tools = createBuiltinFileTools(dir, { runTask }) as unknown as Record<
      string,
      { execute: (input: unknown, options: unknown) => Promise<unknown> }
    >;

    const result = await tools.task.execute({ description: "扫描仓库", cwd: "src" }, { abortSignal: undefined });

    expect(runTask).toHaveBeenCalledWith({ description: "扫描仓库", cwd: "src" }, undefined);
    expect(result).toEqual({ result: "子代理结果" });
  });

  it("task tool rejects with a clear error when no runTask executor is available", async () => {
    const dir = await makeTempDir();
    const tools = createBuiltinFileTools(dir) as unknown as Record<
      string,
      { execute: (input: unknown) => Promise<unknown> }
    >;

    await expect(tools.task.execute({ description: "x" })).rejects.toThrow(/task 工具不可用/);
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

describe("run_command 让位注入（yield-to-injection）", () => {
  // 3s 后才写出 DONE：轮询间隔为 1s，留足余量确保让位先于命令结束发生，
  // 若工具提前返回则命令必然还在跑（避免时序抖动导致用例 flaky）。
  const SLOW_WRITE = `node -e "setTimeout(()=>process.stdout.write('DONE'),3000)"`;
  const HANG = `node -e "setTimeout(()=>{},30000)"`;

  async function waitForDone(taskId: string, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    let last = await commandOutputForTool(taskId);
    while (last.running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      last = await commandOutputForTool(taskId);
    }
    return last;
  }

  afterEach(() => {
    killAllBackgroundCommands();
  });

  it("让位时立即返回后台句柄，命令继续在后台运行", async () => {
    const dir = await makeTempDir();

    const result = await runCommandForTool(
      dir,
      { command: SLOW_WRITE, timeoutMs: 30_000 },
      undefined,
      undefined,
      () => true,
    );

    expect(result.backgrounded).toBe(true);
    expect(typeof result.taskId).toBe("string");
    // 命令 3s 后才写 DONE；此刻已返回说明没有等它跑完
    expect(result.exitCode).toBeNull();
    expect(result.stdout).not.toContain("DONE");

    const done = await waitForDone(result.taskId!);
    expect(done.running).toBe(false);
    expect(done.exitCode).toBe(0);
    expect(done.stdout).toContain("DONE");
  });

  it("未提供 shouldYield 时行为不变（回归护栏）", async () => {
    const dir = await makeTempDir();

    const result = await runCommandForTool(dir, {
      command: `node -e "process.stdout.write('OK')"`,
      timeoutMs: 10_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("OK");
    expect(result.backgrounded).toBeUndefined();
    expect(result.taskId).toBeUndefined();
  });

  it("shouldYield 恒为 false 时阻塞到完成且不标记 backgrounded", async () => {
    const dir = await makeTempDir();

    const result = await runCommandForTool(
      dir,
      { command: `node -e "process.stdout.write('OK')"`, timeoutMs: 10_000 },
      undefined,
      undefined,
      () => false,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("OK");
    expect(result.backgrounded).toBeUndefined();
  });

  it("后台任务仍响应 abort（/stop）", async () => {
    const dir = await makeTempDir();
    const controller = new AbortController();

    const result = await runCommandForTool(
      dir,
      { command: HANG, timeoutMs: 60_000 },
      controller.signal,
      undefined,
      () => true,
    );
    expect(result.backgrounded).toBe(true);

    controller.abort();

    const done = await waitForDone(result.taskId!, 15_000);
    expect(done.running).toBe(false);
  });

  it("后台任务仍受 timeoutMs 约束", async () => {
    const dir = await makeTempDir();

    const result = await runCommandForTool(
      dir,
      // timeoutMs 必须大于轮询间隔：否则超时会先于让位触发，命令以
      // 前台语义结束，就测不到“后台任务仍受 timeoutMs 约束”。
      { command: HANG, timeoutMs: 2000 },
      undefined,
      undefined,
      () => true,
    );
    expect(result.backgrounded).toBe(true);

    const done = await waitForDone(result.taskId!, 15_000);
    expect(done.running).toBe(false);
    expect(done.timedOut).toBe(true);
  });

  it("command_kill 终止后台任务", async () => {
    const dir = await makeTempDir();

    const result = await runCommandForTool(
      dir,
      { command: HANG, timeoutMs: 60_000 },
      undefined,
      undefined,
      () => true,
    );
    const taskId = result.taskId!;
    expect((await commandOutputForTool(taskId)).running).toBe(true);

    expect(await commandKillForTool(taskId)).toEqual({ taskId, killed: true });

    const done = await waitForDone(taskId, 15_000);
    expect(done.running).toBe(false);
  });

  it("command_output 对未知 taskId 抛错", async () => {
    await expect(commandOutputForTool("cmd-does-not-exist")).rejects.toThrow(/未知的后台任务/);
  });

  it("run_command 工具通过 shouldYieldToInjection 让位", async () => {
    const dir = await makeTempDir();
    const tools = createBuiltinFileTools(dir, {
      shouldYieldToInjection: () => true,
    }) as unknown as Record<
      string,
      { execute: (input: unknown, options: unknown) => Promise<Record<string, any>> }
    >;

    const result = await tools.run_command.execute(
      { command: SLOW_WRITE, timeoutMs: 30_000 },
      { abortSignal: undefined },
    );

    expect(result.backgrounded).toBe(true);
    expect(result.taskId).toBeTruthy();

    const done = await waitForDone(result.taskId as string);
    expect(done.exitCode).toBe(0);
  });
});
