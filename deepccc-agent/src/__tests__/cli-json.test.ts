import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const requireFromHere = createRequire(import.meta.url);

// 兼容两种布局：<root>/deepccc-agent/src/__tests__（chatccc 子目录）或 <root>/src/__tests__（deepccc 镜像）
const here = dirname(fileURLToPath(import.meta.url));
const cliSource = join(here, "..", "cli.ts");
const tsxCli = requireFromHere.resolve("tsx/cli");
const cliArgs = (...args: string[]) => [tsxCli, cliSource, ...args];

describe("deepccc cli --stream-json", () => {
  it("documents max output tokens and rejects non-positive values", async () => {
    const help = await execFileAsync(process.execPath, cliArgs("--help"), {
      cwd: dirname(cliSource),
      timeout: 10_000,
      windowsHide: true,
    });
    expect(help.stdout).toContain("--max-output-tokens <n>");
    expect(help.stdout).toContain("--image <path>");

    await expect(execFileAsync(process.execPath, [
      ...cliArgs(),
      "--max-output-tokens",
      "0",
      "--help",
    ], {
      cwd: dirname(cliSource),
      timeout: 10_000,
      windowsHide: true,
    })).rejects.toMatchObject({ code: 1 });
  });

  it("reports an invalid --image path as a JSONL error before contacting the Provider", async () => {
    let caught: unknown;
    try {
      await execFileAsync(process.execPath, [
        ...cliArgs(),
        "--stream-json",
        "--prompt",
        "inspect it",
        "--image",
        "missing-image.png",
      ], {
        cwd: dirname(cliSource),
        timeout: 10_000,
        windowsHide: true,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ code: 1 });
    const lines = ((caught as { stdout?: string }).stdout ?? "").trim().split(/\r?\n/).filter(Boolean);
    expect(JSON.parse(lines.at(-1)!)).toEqual(expect.objectContaining({
      type: "error",
      message: expect.stringMatching(/missing-image\.png/),
    }));
  });

  it("writes only JSON lines to stdout when startup fails", async () => {
    let caught: unknown;
    try {
      await execFileAsync(process.execPath, [
        ...cliArgs(),
        "--stream-json",
        "--prompt",
        "hello",
        "--api-key",
        "",
      ], {
        cwd: dirname(cliSource),
        timeout: 10_000,
        windowsHide: true,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toMatchObject({ code: 1 });
    const stdout = (caught as { stdout?: string }).stdout ?? "";
    const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(JSON.parse(lines.at(-1)!)).toEqual(expect.objectContaining({
      type: "error",
    }));
  });
});
