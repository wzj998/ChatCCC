import { describe, expect, it } from "vitest";

import type { ChatEvent } from "../index.js";
import { reduceProgress, summarizeToolInput, summarizeToolResult } from "../progress/reducer.js";
import { progressView } from "../progress/view.js";

function feed(events: ChatEvent[]) {
  return events.reduce(reduceProgress, progressView({ headerTitle: "生成中..." }));
}

describe("reduceProgress", () => {
  it("renders explicit compaction and generation phases", () => {
    const compacting = reduceProgress(
      progressView({ headerTitle: "Generating..." }),
      { type: "status", phase: "compacting" },
    );
    expect(compacting.headerTitle).toBe("压缩上下文中...");

    const generating = reduceProgress(compacting, { type: "status", phase: "generating" });
    expect(generating.headerTitle).toBe("生成回复中...");
  });

  it("accumulates text via accumulated field", () => {
    const view = feed([
      { type: "text", text: "Hello", accumulated: "Hello" },
      { type: "text", text: " world", accumulated: "Hello world" },
    ]);
    expect(view.text).toBe("Hello world");
    expect(view.status).toBe("generating");
    expect(view.showStop).toBe(true);
  });

  it("uses reasoning heartbeats for status only and clears a rejected attempt before retry", () => {
    const view = feed([
      { type: "text", text: "bad", accumulated: "bad" },
      { type: "progress", phase: "reasoning" },
      { type: "text_reset" },
    ]);

    expect(view.headerTitle).toBe("思考中...");
    expect(view.text).toBe("");
    expect(view.tools).toEqual([]);
  });

  it("appends tool_use as running and resolves status on tool_result", () => {
    const view = feed([
      { type: "tool_use", id: "t1", name: "edit_file", input: { path: "a.ts" } },
      { type: "tool_result", tool_use_id: "t1", name: "edit_file", content: "ok", is_error: false },
    ]);
    expect(view.tools).toHaveLength(1);
    expect(view.tools[0]).toMatchObject({
      id: "t1",
      name: "edit_file",
      status: "ok",
      summary: "ok",
    });
  });

  it("marks tool as error when is_error is true", () => {
    const view = feed([
      { type: "tool_use", id: "t2", name: "run_command", input: { command: "npm test" } },
      { type: "tool_result", tool_use_id: "t2", name: "run_command", content: "boom", is_error: true },
    ]);
    expect(view.tools[0].status).toBe("error");
    expect(view.tools[0].summary).toBe("boom");
  });

  it("falls back to last running tool when tool_use_id mismatches", () => {
    const view = feed([
      { type: "tool_use", id: undefined, name: "list_dir", input: {} },
      { type: "tool_result", tool_use_id: "unknown-id", name: "list_dir", content: "ok", is_error: false },
    ]);
    expect(view.tools[0].status).toBe("ok");
  });

  it("keeps multiple tool calls independently", () => {
    const view = feed([
      { type: "tool_use", id: "a", name: "read_file", input: { path: "a" } },
      { type: "tool_use", id: "b", name: "read_file", input: { path: "b" } },
      { type: "tool_result", tool_use_id: "b", name: "read_file", content: "bb", is_error: false },
    ]);
    expect(view.tools[0].status).toBe("running");
    expect(view.tools[1].status).toBe("ok");
  });

  it("marks done: status done, showStop false, text finalized", () => {
    const view = feed([
      { type: "text", text: "part", accumulated: "part" },
      { type: "done", text: "final answer" },
    ]);
    expect(view.status).toBe("done");
    expect(view.showStop).toBe(false);
    expect(view.text).toBe("final answer");
  });

  it("marks error status and keeps text", () => {
    const view = feed([
      { type: "text", text: "x", accumulated: "x" },
      { type: "error", message: "boom" },
    ]);
    expect(view.status).toBe("error");
    expect(view.showStop).toBe(false);
    expect(view.text).toBe("x");
  });

  it("ignores compact events without changing the view identity", () => {
    const base = progressView({ headerTitle: "生成中..." });
    const result = reduceProgress(base, { type: "compact", compactedMessages: 5 });
    expect(result).toBe(base);
  });

  it("does not mutate the previous view (immutable updates)", () => {
    const base = progressView({ headerTitle: "生成中..." });
    const next = reduceProgress(base, { type: "text", text: "hi", accumulated: "hi" });
    expect(base.text).toBe("");
    expect(next.text).toBe("hi");
    expect(next).not.toBe(base);
  });
});

describe("summarizeToolInput / summarizeToolResult", () => {
  it("flattens multiline input to one line", () => {
    const s = summarizeToolInput({ path: "a\nb", big: "x".repeat(200) });
    expect(s).not.toContain("\n");
    expect(s.length).toBeLessThanOrEqual(121);
    expect(s.endsWith("…")).toBe(true);
  });

  it("takes first line of result content", () => {
    expect(summarizeToolResult("line1\nline2\n")).toBe("line1");
    expect(summarizeToolResult({ ok: true })).toBe('{"ok":true}');
  });
});
