import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import { compactToolLoopMessages } from "../turn-context.js";
import { modelToolViews } from "../model-tool-view.js";

const messages = (text: string): ModelMessage[] => [
  { role: "assistant", content: [{ type: "tool-call", toolCallId: "read-actual", toolName: "read_file", input: { path: "evidence.txt" } }] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: "read-actual", toolName: "read_file", output: { type: "json", value: { content: text, truncated: false } } }] },
];
describe("modelToolViews", () => {
  it("records the exact prepared output separately from the original successful tool result", () => {
    const original = messages("HEAD\r\n" + "body".repeat(30_000) + "\r\nTAIL");
    const unchanged = JSON.stringify(original);
    const prepared = compactToolLoopMessages(original, { maxToolChars: 4_000 }).messages;
    const [view] = modelToolViews(original, prepared);
    expect(view.tool_call_id).toBe("read-actual");
    expect(view.changed).toBe(true);
    expect(view.model_output_sha256).not.toBe(view.original_output_sha256);
    expect(view.model_output_sha256).toBe(createHash("sha256").update(JSON.stringify(view.content)).digest("hex"));
    expect(JSON.stringify(original)).toBe(unchanged);
    expect(JSON.stringify(view.content).length).toBe(view.model_output_chars);
    expect(view.model_output_chars).toBeLessThanOrEqual(4_000);
  });
  it("records complete fresh JSON text with CRLF without treating it as a reading judgment", () => {
    const original = messages("HEAD\r\n" + "b".repeat(42_000) + "\r\nTAIL");
    const [view] = modelToolViews(original, compactToolLoopMessages(original).messages);
    expect(view.changed).toBe(false);
    expect(view.model_output_sha256).toBe(view.original_output_sha256);
    expect(view.content).toEqual((original.at(-1)!.content as any[])[0].output);
    expect(view).not.toHaveProperty("semanticReviewed");
  });
});
