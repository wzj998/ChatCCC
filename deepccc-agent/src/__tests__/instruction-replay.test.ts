import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { InstructionReplayCache } from "../instruction-replay.js";

const path = "C:/repo/.agents/skills/audit/SKILL.md";
const pair = (id: string, value: string): ModelMessage[] => [
  { role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: "read_file", input: { path } }] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "read_file", output: { type: "text", value } }] },
];

describe("InstructionReplayCache", () => {
  it("retains observed instructions across repeated degraded history captures without mutating history", () => {
    const cache = new InstructionReplayCache();
    cache.capture(pair("one", "FULL_ACTUAL_RULE"));
    const history = pair("one", "omitted history");
    const before = JSON.stringify(history);
    cache.capture(history);
    expect(JSON.stringify(cache.restore(history))).toContain("FULL_ACTUAL_RULE");
    expect(JSON.stringify(history)).toBe(before);
  });

  it("supersedes old reads and does not revive stale rules after a failed newer read", () => {
    const cache = new InstructionReplayCache();
    cache.capture(pair("old", "STALE_RULE"));
    cache.observeCall("new", "read_file", { path });
    cache.observeError("new", "file unavailable");
    cache.capture(pair("old", "STALE_RULE"));
    const history = [...pair("old", "STALE_RULE"), ...pair("new", "missing")];
    const result = JSON.stringify(cache.restore(history));
    expect(result).not.toContain("STALE_RULE");
    expect(result).toContain("file unavailable");
  });

  it("does not resurrect an old read when its newer replacement is outside the history window", () => {
    const cache = new InstructionReplayCache();
    cache.capture([...pair("old", "STALE_RULE"), ...pair("new", "CURRENT_RULE")]);
    const result = JSON.stringify(cache.restore(pair("old", "STALE_RULE")));
    expect(result).not.toContain("STALE_RULE");
    expect(result).not.toContain("CURRENT_RULE");
    expect(result).toContain("reload current skill");
  });

  it("never retains arbitrary document output or serializes an unrelated undefined result", () => {
    const cache = new InstructionReplayCache();
    cache.observeCall("ordinary", "read_file", { path: "C:/repo/report.md" });
    cache.observeFileResult("ordinary", { content: "PRIVATE_REPORT" });
    expect(() => cache.observeFileResult("unrelated", undefined)).not.toThrow();
    const input = [{ role: "tool", content: [{ type: "tool-result", toolCallId: "ordinary", toolName: "read_file",
      output: { type: "text", value: "ordinary history" } }] }] as ModelMessage[];
    expect(cache.restore(input)).toEqual(input);
  });
});
