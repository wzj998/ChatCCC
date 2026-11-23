import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexAdapter, parseCodexGoalCommand } from "../adapters/codex-adapter.ts";
import { CodexAppServerManager, JsonRpcClient } from "../adapters/codex-app-server.ts";

afterEach(() => vi.restoreAllMocks());

describe("Codex goal integration", () => {
  it("distinguishes controls from objectives and matches only the goal command", () => {
    expect(parseCodexGoalCommand("/goalkeeper")).toBeNull();
    expect(parseCodexGoalCommand("/goal")).toEqual({ action: "get" });
    expect(parseCodexGoalCommand("/goal pause")).toEqual({ action: "pause" });
    expect(parseCodexGoalCommand("/goal edit Keep CASE")).toEqual({ action: "set", objective: "Keep CASE" });
  });

  it.each(["complete", "paused", "budgetLimited"])(
    "subscribes before setting the goal, collects both rounds and reports %s",
    async terminalStatus => {
    const threadId = "thread-fixture";
    const emit = (method: string, params: Record<string, unknown>) =>
      client.onNotification?.(method, { threadId, ...params });
    const turn = (id: string) => {
      emit("turn/started", { turn: { id } });
      emit("item/completed", { item: { type: "agentMessage", text: id } });
      emit("turn/completed", { turn: { id, status: "completed" } });
    };
    let reads = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") return { thread: { id: threadId } };
      if (method === "thread/goal/set") {
        turn("first");
        emit("thread/goal/updated", { goal: { status: terminalStatus } });
        turn("second");
        return { goal: { status: "active" } };
      }
      if (method === "thread/goal/get") return { goal: { status: ++reads === 1 ? "active" : "complete" } };
      return {};
    });
    const client = {
      request, notify: vi.fn(), close: vi.fn(),
      onNotification: null as ((method: string, params: Record<string, unknown>) => void) | null,
    };
    vi.spyOn(CodexAppServerManager, "get").mockReturnValue({
      ensureStarted: async () => 12345,
    } as unknown as CodexAppServerManager);
    vi.spyOn(JsonRpcClient, "connect").mockResolvedValue(client as unknown as JsonRpcClient);
    const adapter = createCodexAdapter({ metaStore: { get: async () => undefined, set: async () => {}, setThreadId: async () => {} } });
    const events = [];
    for await (const event of adapter.prompt("synthetic", "", process.cwd(), undefined, {
      codexGoal: { action: "set", objective: "Finish tests" },
    })) {
      events.push(event);
    }
    expect(request).toHaveBeenCalledWith("thread/goal/set", { threadId, objective: "Finish tests", status: "active" }, expect.any(Number));
    expect(request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
    const replies = events.flatMap(event => event.blocks ?? []).filter(block => block.type === "text").map(block => block.text);
    expect(replies).toEqual(expect.arrayContaining(["first", "second"]));
    expect(replies.at(-1)).toContain(terminalStatus);
    expect(events.filter(event => event.isFinalResponse)).toHaveLength(1);
    expect(events.at(-1)?.isFinalResponse).toBe(true);
    },
  );
});
