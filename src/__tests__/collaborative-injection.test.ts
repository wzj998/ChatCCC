import { beforeEach, describe, expect, it } from "vitest";

import {
  clearInjections,
  drainRemainingInjections,
  hasPendingInjection,
  MAX_PENDING_INJECTIONS,
  pendingInjections,
  pushInjection,
  shiftInjection,
  type QueuedMessage,
} from "../session-chat-binding.ts";
import { accumulateBlockContent, type AccumulatorState } from "../session.ts";
import { appendExecutionTranscriptBlock, type ExecutionTranscriptState } from "../execution-transcript.ts";
import { createAgentActivityTracker, updateAgentActivity } from "../agent-activity.ts";

function queued(text: string): QueuedMessage {
  return {
    text,
    chatId: "chat-1",
    openId: "open-1",
    msgTimestamp: 1,
    chatType: "group",
    traceId: "trace-1",
  };
}

function accumulator(): AccumulatorState {
  return {
    accumulatedContent: "",
    finalText: "",
    finalCompleteText: "",
    chunkCount: 0,
  };
}

describe("pendingInjections (ccc collaborative-yield queue)", () => {
  beforeEach(() => {
    pendingInjections.clear();
  });

  it("pushes and shifts in FIFO order", () => {
    expect(pushInjection("s1", queued("a"))).toBe(true);
    expect(pushInjection("s1", queued("b"))).toBe(true);
    expect(shiftInjection("s1")?.text).toBe("a");
    expect(shiftInjection("s1")?.text).toBe("b");
    expect(shiftInjection("s1")).toBeUndefined();
    expect(hasPendingInjection("s1")).toBe(false);
  });

  it("drains remaining and clears", () => {
    pushInjection("s1", queued("a"));
    pushInjection("s1", queued("b"));
    expect(drainRemainingInjections("s1").map((message) => message.text)).toEqual(["a", "b"]);
    expect(hasPendingInjection("s1")).toBe(false);

    clearInjections("s1");
    expect(drainRemainingInjections("s1")).toEqual([]);
  });

  it("enforces the max pending injection depth", () => {
    for (let index = 0; index < MAX_PENDING_INJECTIONS; index += 1) {
      pushInjection("s1", queued(`m${index}`));
    }
    expect(pushInjection("s1", queued("overflow"))).toBe(false);
    expect((pendingInjections.get("s1") ?? []).length).toBe(MAX_PENDING_INJECTIONS);
  });
});

describe("input_injected display handling", () => {
  it("accumulates a lightweight marker without touching finalText", () => {
    const state = accumulator();
    accumulateBlockContent({ type: "input_injected", text: "补充指令" }, state);
    expect(state.accumulatedContent).toContain("补充指令");
    expect(state.finalText).toBe("");
    expect(state.chunkCount).toBe(0);
  });

  it("records a notice in the execution transcript", () => {
    const state: ExecutionTranscriptState = { transcript: [] };
    appendExecutionTranscriptBlock({ type: "input_injected", text: "补充指令" }, state, "2026-01-01T00:00:00.000Z");
    expect(state.transcript).toEqual([
      { type: "notice", at: "2026-01-01T00:00:00.000Z", text: "已注入新消息：补充指令" },
    ]);
  });

  it("does not change agent activity on injection", () => {
    const tracker = createAgentActivityTracker(0);
    const before = tracker.activity;
    expect(updateAgentActivity(tracker, { type: "input_injected", text: "补充指令" }, 1)).toBe(false);
    expect(tracker.activity).toBe(before);
  });
});
