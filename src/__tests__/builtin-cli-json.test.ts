import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("builtin cli --stream-json", () => {
  it("writes only JSON lines to stdout when startup fails", async () => {
    let caught: unknown;
    try {
      await execFileAsync(process.execPath, [
        "bin/cccagent.mjs",
        "--stream-json",
        "--prompt",
        "hello",
        "--api-key",
        "",
      ], {
        cwd: process.cwd(),
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
