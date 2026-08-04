import { describe, expect, it } from "vitest";

import {
  createAgentActivityTracker,
  formatAgentActivityTitle,
  updateAgentActivity,
} from "../agent-activity.ts";

describe("agent activity", () => {
  it("starts with an explicit startup status", () => {
    const tracker = createAgentActivityTracker(1_000);

    expect(formatAgentActivityTitle(tracker.activity, 4_000)).toBe("正在启动 Agent · 3秒");
  });

  it("keeps the thinking timer stable across repeated thinking blocks", () => {
    const tracker = createAgentActivityTracker(1_000);

    expect(updateAgentActivity(tracker, { type: "thinking", thinking: "first" }, 2_000)).toBe(true);
    expect(updateAgentActivity(tracker, { type: "thinking", thinking: "second" }, 5_000)).toBe(false);
    expect(formatAgentActivityTitle(tracker.activity, 8_000)).toBe("思考中 · 6秒");
  });

  it("shows the active tool name and elapsed time", () => {
    const tracker = createAgentActivityTracker(1_000);

    updateAgentActivity(tracker, {
      type: "tool_use",
      id: "tool-1",
      name: "Bash",
      input: { command: "npm test" },
    }, 3_000);

    expect(formatAgentActivityTitle(tracker.activity, 38_000)).toBe("正在执行 Bash · 35秒");
  });

  it("tracks parallel tools and keeps the remaining tool after one result", () => {
    const tracker = createAgentActivityTracker(1_000);

    updateAgentActivity(tracker, { type: "tool_use", id: "read", name: "Read", input: {} }, 2_000);
    updateAgentActivity(tracker, { type: "tool_use", id: "grep", name: "Grep", input: {} }, 3_000);
    expect(formatAgentActivityTitle(tracker.activity, 4_000)).toBe("正在执行 Read 等 2 项 · 2秒");

    updateAgentActivity(tracker, {
      type: "tool_result",
      tool_use_id: "read",
      content: "done",
    }, 5_000);
    expect(formatAgentActivityTitle(tracker.activity, 7_000)).toBe("正在执行 Grep · 4秒");

    updateAgentActivity(tracker, {
      type: "tool_result",
      tool_use_id: "grep",
      content: "done",
    }, 8_000);
    expect(formatAgentActivityTitle(tracker.activity, 10_000)).toBe("正在处理工具结果 · 2秒");
  });

  it("switches to response and context-compaction statuses", () => {
    const tracker = createAgentActivityTracker(1_000);

    updateAgentActivity(tracker, { type: "text", text: "answer" }, 2_000);
    expect(formatAgentActivityTitle(tracker.activity, 3_000)).toBe("正在生成回复 · 1秒");

    updateAgentActivity(tracker, {
      type: "compact_boundary",
      trigger: "auto",
      pre_tokens: 100_000,
    }, 4_000);
    expect(formatAgentActivityTitle(tracker.activity, 5_000)).toBe("正在整理上下文 · 1秒");
  });

  it("uses explicit DeepCCC phase events before text is emitted", () => {
    const tracker = createAgentActivityTracker(1_000);

    expect(updateAgentActivity(tracker, { type: "agent_status", status: "compacting" }, 2_000)).toBe(true);
    expect(tracker.activity).toEqual({ kind: "compacting", startedAt: 2_000 });

    expect(updateAgentActivity(tracker, { type: "agent_status", status: "responding" }, 5_000)).toBe(true);
    expect(tracker.activity).toEqual({ kind: "responding", startedAt: 5_000 });
  });

  it("formats longer elapsed time without decorative animation", () => {
    expect(formatAgentActivityTitle({ kind: "thinking", startedAt: 1_000 }, 74_000)).toBe("思考中 · 1分13秒");
  });
});
