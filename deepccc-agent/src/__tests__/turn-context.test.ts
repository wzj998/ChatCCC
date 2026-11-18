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
  it("keeps a fresh complete result above the historical per-result cap when it fits the turn budget", () => {
    const text = "BEGIN_FRESH_BODY\n" + "clause ".repeat(6_000) + "\nEND_FRESH_BODY";
    const input = toolPair("fresh-full", text);
    const result = compactToolLoopMessages(input);
    const modelPart = (result.messages.at(-1)!.content as any[])[0];
    expect(JSON.stringify(modelPart.output) === JSON.stringify({ type: "text", value: text })).toBe(true);
    expect(result.retainedToolChars).toBeLessThanOrEqual(96_000);
  });

  it("gives fresh results budget priority over old execution failure summaries", () => {
    const oldFailures: ModelMessage[] = Array.from({ length: 30 }, (_, i) => [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: `old${i}`, toolName: "run_process", input: { executable: "test" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: `old${i}`, toolName: "run_process",
        output: { type: "json", value: { exitCode: 1, stderr: "old failure ".repeat(120), stdout: "x".repeat(20_000) } } }] },
    ] as ModelMessage[]).flat();
    const text = "CURRENT_EVIDENCE\n" + "e".repeat(50_000);
    const result = compactToolLoopMessages([...oldFailures, ...toolPair("fresh", text)]);
    expect(JSON.stringify((result.messages.at(-1)!.content as any[])[0].output) === JSON.stringify({ type: "text", value: text })).toBe(true);
    expect(result.retainedToolChars).toBeLessThanOrEqual(96_000);
  });
  it("keeps a fresh instruction read complete within its separate instruction allowance", () => {
    const text="CURRENT_SKILL\n"+"i".repeat(28_000);
    const input=toolPair("skill",text);
    ((input[0].content as any[])[0].input as any).path="/work/.agents/skills/audit/SKILL.md";
    const result=compactToolLoopMessages(input);
    expect(JSON.stringify((result.messages.at(-1)!.content as any[])[0].output)===JSON.stringify({type:"text",value:text})).toBe(true);
    expect(result.retainedToolChars).toBeLessThanOrEqual(96_000);
  });
  it("omits an oversized historical script as a whole value instead of a code-shaped excerpt", () => {
    const input: ModelMessage[] = [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "script", toolName: "run_script",
        input: { language: "python", code: "HEAD_CODE\n" + "x".repeat(100_000) + "\nTAIL_CODE" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "script", toolName: "run_script", output: { type: "text", value: "done" } }] },
    ];
    const result = compactToolLoopMessages(input);
    const replay = JSON.stringify(result.messages);
    expect(replay).not.toContain("HEAD_CODE");
    expect(replay).not.toContain("TAIL_CODE");
    expect(replay).toContain("OMITTED_TOOL_ARGUMENT");
    expect(JSON.stringify(input)).toContain("HEAD_CODE");
  });
  it("counts serialized escaping when enforcing the result budget", () => {
    const result = compactToolLoopMessages(toolPair("escaped", '\\"\n'.repeat(40_000)), {
      maxToolChars: 1_000, maxResultChars: 1_000,
    });
    const actual = result.messages.filter(m => m.role === "tool").reduce((sum, m) =>
      sum + (Array.isArray(m.content) ? m.content.reduce((n, p) =>
        n + (p.type === "tool-result" ? JSON.stringify(p.output).length : 0), 0) : 0), 0);
    expect(actual).toBe(result.retainedToolChars);
    expect(actual).toBeLessThanOrEqual(1_000);
  });

  it("does not resurrect an old skill after the newest read fails", () => {
    const messages: ModelMessage[] = ["old", "new"].flatMap((id, index): ModelMessage[] => [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: "read_file", input: { path: "/work/.agents/skills/audit/SKILL.md" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "read_file", output: index === 0
        ? { type: "text", value: "OBSOLETE_INSTRUCTION" }
        : { type: "error-text", value: "file unavailable" } }] },
    ]);
    const rendered = JSON.stringify(compactToolLoopMessages(messages).messages);
    expect(rendered).not.toContain("OBSOLETE_INSTRUCTION");
    expect(rendered).toContain("file unavailable");
  });

  it("retains a loaded skill when newer ordinary results consume the budget", () => {
    const instruction = "MANDATORY: unread evidence cannot be signed.\n" + "rule ".repeat(600);
    const messages: ModelMessage[] = [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "skill", toolName: "read_file", input: { path: "/work/.agents/skills/audit/SKILL.md" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "skill", toolName: "read_file", output: { type: "text", value: instruction } }] },
      ...toolPair("newer-a", "a".repeat(5_200)),
      ...toolPair("newer-b", "b".repeat(5_200)),
      ...toolPair("status", "continue"),
    ];
    const result = compactToolLoopMessages(messages, { maxToolChars: 12_000, keepRecentResults: 1 });
    expect(JSON.stringify(result.messages)).toContain("unread evidence cannot be signed");
    expect(result.retainedToolChars).toBeLessThanOrEqual(12_000);
  });

  it("does not replay superseded reads of the same skill as current guidance", () => {
    const read = (id: string, value: string): ModelMessage[] => [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: "read_file", input: { path: "C:\\repo\\.agents\\skills\\audit\\SKILL.md" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "read_file", output: { type: "text", value } }] },
    ];
    const result = compactToolLoopMessages([
      ...read("v1", "OBSOLETE_SKILL_RULE"), ...read("v2", "CURRENT_SKILL_RULE"),
    ]);
    const rendered = JSON.stringify(result.messages);
    expect(rendered).toContain("CURRENT_SKILL_RULE");
    expect(rendered).not.toContain("OBSOLETE_SKILL_RULE");
  });

  it("retains an execution failure summary after its large output is omitted", () => {
    const messages: ModelMessage[] = [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "failed", toolName: "run_process", input: { executable: "validator", args: [] } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "failed", toolName: "run_process", output: { type: "json", value: { stdout: "x".repeat(80_000), exitCode: 1, stderr: "mandatory validation failed" } } }] },
      ...toolPair("latest", "current evidence"),
    ];
    const result = compactToolLoopMessages(messages, { maxToolChars: 2_000, keepRecentResults: 1 });
    expect(JSON.stringify(result.messages)).toContain("mandatory validation failed");
    expect(JSON.stringify(result.messages)).toContain('"exitCode":1');
    expect(result.retainedToolChars).toBeLessThanOrEqual(2_000);
  });

  it("bounds old script arguments without changing the persisted input or tool protocol", () => {
    const messages: ModelMessage[] = [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "old-script", toolName: "run_script", input: { language: "python", code: "old_code = 1\n".repeat(30_000) } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "old-script", toolName: "run_script", output: { type: "text", value: "exitCode=0" } }] },
      ...toolPair("a", "a"), ...toolPair("b", "b"), ...toolPair("c", "c"), ...toolPair("d", "d"),
    ];
    const before = JSON.stringify(messages);
    const result = compactToolLoopMessages(messages);
    expect(JSON.stringify(result.messages).length).toBeLessThan(50_000);
    expect(JSON.stringify(messages)).toBe(before);
    expect(result.messages.filter(message => message.role === "tool")).toHaveLength(5);
    expect(JSON.stringify(result.messages)).toContain('"language":"python"');
  });

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
