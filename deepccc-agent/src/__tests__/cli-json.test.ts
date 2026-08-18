import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

// 兼容两种布局：<root>/deepccc-agent/src/__tests__（chatccc 子目录）或 <root>/src/__tests__（deepccc 镜像）
const here = dirname(fileURLToPath(import.meta.url));
const legacyBin = [
  join(here, "..", "..", "..", "bin", "deepccc.mjs"),
  join(here, "..", "..", "bin", "deepccc.mjs"),
].find(existsSync);
const cliBin = [
  join(here, "..", "..", "..", "bin", "deepccc-cli.mjs"),
  join(here, "..", "..", "bin", "deepccc-cli.mjs"),
].find(existsSync);

describe("deepccc cli --stream-json", () => {
  it("documents max output tokens and rejects non-positive values", async () => {
    const help = await execFileAsync(process.execPath, [cliBin!, "--help"], {
      cwd: dirname(cliBin!),
      timeout: 10_000,
      windowsHide: true,
    });
    expect(help.stdout).toContain("--max-output-tokens <n>");

    await expect(execFileAsync(process.execPath, [
      cliBin!,
      "--max-output-tokens",
      "0",
      "--help",
    ], {
      cwd: dirname(cliBin!),
      timeout: 10_000,
      windowsHide: true,
    })).rejects.toMatchObject({ code: 1 });
  });

  it("writes only JSON lines to stdout when startup fails", async () => {
    let caught: unknown;
    try {
      await execFileAsync(process.execPath, [
        legacyBin!,
        "--stream-json",
        "--prompt",
        "hello",
        "--api-key",
        "",
      ], {
        cwd: dirname(cliBin!),
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
