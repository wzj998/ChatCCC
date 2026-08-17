import { describe, expect, it } from "vitest";

import {
  appendExecutionTranscriptBlock,
  type ExecutionTranscriptState,
} from "../execution-transcript.ts";

describe("execution transcript", () => {
  it("preserves ordered text, full tool input, and full tool output", () => {
    const state: ExecutionTranscriptState = { transcript: [] };
    const input = { command: "x".repeat(500) };
    const output = "y".repeat(800);

    appendExecutionTranscriptBlock({ type: "text", text: "准备执行。" }, state, "2026-08-17T00:00:00.000Z");
    appendExecutionTranscriptBlock({ type: "tool_use", id: "tool-1", name: "run_command", input }, state, "2026-08-17T00:00:01.000Z");
    appendExecutionTranscriptBlock({ type: "tool_result", tool_use_id: "tool-1", content: output }, state, "2026-08-17T00:00:02.000Z");
    appendExecutionTranscriptBlock({ type: "text", text: "执行完成。" }, state, "2026-08-17T00:00:03.000Z");

    expect(state.transcript.map((entry) => entry.type)).toEqual(["text", "tool_use", "tool_result", "text"]);
    expect(state.transcript[1]).toMatchObject({ name: "run_command", toolUseId: "tool-1" });
    expect(state.transcript[1]?.input).toContain("x".repeat(500));
    expect(state.transcript[2]?.output).toBe(output);
    expect(state.transcript[1]?.input).not.toContain("...");
    expect(state.transcript[2]?.output).not.toContain("...");
  });

  it("coalesces text deltas and clears rejected output on text_reset", () => {
    const state: ExecutionTranscriptState = { transcript: [] };
    appendExecutionTranscriptBlock({ type: "text", text: "旧" }, state, "2026-08-17T00:00:00.000Z");
    appendExecutionTranscriptBlock({ type: "text", text: "回复" }, state, "2026-08-17T00:00:01.000Z");
    expect(state.transcript).toHaveLength(1);
    expect(state.transcript[0]?.text).toBe("旧回复");

    appendExecutionTranscriptBlock({ type: "text_reset" }, state, "2026-08-17T00:00:02.000Z");
    appendExecutionTranscriptBlock({ type: "text_final", text: "重试后的完整回复" }, state, "2026-08-17T00:00:03.000Z");
    expect(state.transcript).toEqual([{
      type: "text",
      at: "2026-08-17T00:00:03.000Z",
      text: "重试后的完整回复",
    }]);
  });
});
