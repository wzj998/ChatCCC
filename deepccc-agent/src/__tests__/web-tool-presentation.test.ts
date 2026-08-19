import { describe, expect, it } from "vitest";

import {
  buildWebToolSummary,
  truncateToolPayload,
} from "../web-tool-presentation.js";

describe("DeepCCC Web tool presentation", () => {
  it("builds ChatCCC-style collapsed summaries with emoji, state, and key information", () => {
    expect(buildWebToolSummary({
      name: "read_file",
      input: { path: "README.md" },
      output: { size: 1536 },
    })).toBe("📖 read_file ✓ README.md · 1.5 KB");
    expect(buildWebToolSummary({
      name: "run_command",
      input: { command: "npm test" },
      pending: true,
    })).toBe("🖥️ run_command … npm test");
    expect(buildWebToolSummary({
      name: "search_code",
      input: { query: "EventSource", path: "src" },
      output: { matches: [{}, {}] },
    })).toBe("🔎 search_code ✓ EventSource · src · 2 条匹配");
  });

  it("keeps the head and tail, reports omitted lines, and expands to the exact full payload", () => {
    const lines = Array.from({ length: 30 }, (_, index) => `line-${index + 1}`);
    const result = truncateToolPayload(lines.join("\n"), 8, 4, 240);

    expect(result.omittedLines).toBe(18);
    expect(result.preview.split("\n")).toEqual([
      ...lines.slice(0, 8),
      "… 已省略 18 行",
      ...lines.slice(-4),
    ]);
    expect(result.full).toBe(lines.join("\n"));
    expect(result.truncated).toBe(true);
  });

  it("clips a pathological single line but retains the full value for expansion", () => {
    const value = "x".repeat(500);
    const result = truncateToolPayload(value, 8, 4, 240);
    expect(result.preview.length).toBe(240);
    expect(result.preview.endsWith("…")).toBe(true);
    expect(result.full).toBe(value);
    expect(result.truncated).toBe(true);
  });
});
