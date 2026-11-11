import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { compactToolLoopMessages } from "../turn-context.js";

function toolPair(id: string, value: string): ModelMessage[] {
  return [
    { role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: "read_file", input: { path: `${id}.txt` } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "read_file", output: { type: "text", value } }] },
  ];
}

describe("compactToolLoopMessages", () => {
  it("bounds older tool results while preserving message/tool protocol and recent evidence", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "investigate" },
      ...toolPair("old-1", "a".repeat(30_000)),
      ...toolPair("old-2", "b".repeat(30_000)),
      ...toolPair("recent", "critical-current-evidence"),
    ];
    const result = compactToolLoopMessages(messages, { maxToolChars: 20_000, keepRecentResults: 1, maxResultChars: 12_000 });
    const serialized = JSON.stringify(result.messages);
    expect(result.compactedResults).toBe(2);
    expect(result.originalToolChars).toBeGreaterThan(60_000);
    expect(result.retainedToolChars).toBeLessThanOrEqual(20_000);
    expect(serialized).toContain("critical-current-evidence");
    expect(serialized).toContain("earlier tool result omitted");
    expect(result.messages.filter(message => message.role === "assistant")).toHaveLength(3);
    expect(result.messages.filter(message => message.role === "tool")).toHaveLength(3);
  });

  it("does not mutate input and leaves small results unchanged", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "hi" }, ...toolPair("one", "small")];
    const before = JSON.stringify(messages);
    const result = compactToolLoopMessages(messages);
    expect(JSON.stringify(messages)).toBe(before);
    expect(result.messages).toEqual(messages);
    expect(result.compactedResults).toBe(0);
  });

  it("retains short older results even when the context budget is full", () => {
    const messages: ModelMessage[] = [
      ...toolPair("status", "exitCode=0; wrote result.json"),
      ...toolPair("large", "x".repeat(30_000)),
      ...toolPair("latest", "current evidence"),
    ];
    const result = compactToolLoopMessages(messages, { maxToolChars: 1_000, keepRecentResults: 1 });
    expect(result.messages[1]).toEqual(messages[1]);
    expect(result.retainedToolChars).toBeLessThanOrEqual(1_000);
    expect(result.compactedResults).toBe(1);
  });

  it("preserves short json and error results when no recent results are protected", () => {
    const messages: ModelMessage[] = [
      { role: "tool", content: [
        { type: "tool-result", toolCallId: "json", toolName: "x", output: { type: "json", value: { exitCode: 0 } } },
        { type: "tool-result", toolCallId: "error", toolName: "x", output: { type: "error-text", value: "file exists" } },
      ] },
    ];
    const result = compactToolLoopMessages(messages, { keepRecentResults: 0 });
    expect(result.messages).toEqual(messages);
    expect(result.compactedResults).toBe(0);
  });

  it("handles json and error outputs without discarding the latest result", () => {
    const messages: ModelMessage[] = [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "a", toolName: "x", input: {} }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "a", toolName: "x", output: { type: "json", value: { payload: "x".repeat(30_000) } } }] },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "b", toolName: "x", input: {} }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "b", toolName: "x", output: { type: "error-text", value: "latest error" } }] },
    ];
    const result = compactToolLoopMessages(messages, { maxToolChars: 5_000, keepRecentResults: 1 });
    expect(JSON.stringify(result.messages)).toContain("latest error");
    expect(JSON.stringify(result.messages)).toContain("earlier tool result omitted");
  });
});
