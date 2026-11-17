import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readProjectInstructionFiles } from "../project-instructions.js";

const directories: string[] = [];
const directory = () => {
  const path = mkdtempSync(join(tmpdir(), "deepccc-instructions-"));
  directories.push(path);
  return path;
};
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("project instruction budgeting", () => {
  it("keeps small instructions and local overrides in their original order", () => {
    const path = directory();
    writeFileSync(join(path, "AGENTS.md"), "BASE_RULE");
    writeFileSync(join(path, "AGENTS.local.md"), "LOCAL_RULE");
    const result = readProjectInstructionFiles(path);
    expect(result).toContain("### AGENTS.md\nBASE_RULE\n\n### AGENTS.local.md\nLOCAL_RULE");
    expect(result).not.toContain("omitted");
  });

  it("bounds UTF-8 bytes, preserves local overrides and leaves the source intact", () => {
    const path = directory();
    const original = "HEAD_RULE\n" + "\u4e2d\u6587\ud83d\ude80".repeat(100_000) + "\nTAIL_RULE";
    writeFileSync(join(path, "AGENTS.md"), original);
    writeFileSync(join(path, "AGENTS.local.md"), "LOCAL_RULE");
    const result = readProjectInstructionFiles(path);
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(32 * 1024);
    expect(result).toContain("HEAD_RULE");
    expect(result).toContain("TAIL_RULE");
    expect(result).toContain("LOCAL_RULE");
    expect(result).toContain("Middle omitted, not loaded or assumed absent");
    expect(result).not.toContain("\ufffd");
    expect(readFileSync(join(path, "AGENTS.md"), "utf8")).toBe(original);
  });

  it("honors the minimum shared budget across all four instruction files", () => {
    const path = directory();
    for (const name of ["AGENTS.md", "AGENTS.local.md", "CLAUDE.md", "CLAUDE.local.md"]) {
      writeFileSync(join(path, name), "x".repeat(100_000));
    }
    expect(Buffer.byteLength(readProjectInstructionFiles(path, 2048))).toBeLessThanOrEqual(2048);
    expect(() => readProjectInstructionFiles(path, 1024)).toThrow("at least 2048");
  });
});
