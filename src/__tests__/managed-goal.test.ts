import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createManagedGoalRunner } from "../managed-goal.ts";

async function withRunner(test: (runner: ReturnType<typeof createManagedGoalRunner>) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "chatccc-goal-test-"));
  try { await test(createManagedGoalRunner(dir)); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

it("continues an explicitly unfinished goal and records completion", () => withRunner(async runner => {
  const turn = vi.fn()
    .mockResolvedValueOnce({ outcome: "done", reply: "First test passed.\n[[GOAL:continue]]" })
    .mockResolvedValueOnce({ outcome: "done", reply: "All tests passed.\n[[GOAL:complete]]" });
  expect((await runner.start("synthetic", "cursor", "Finish tests", turn)).status).toBe("complete");
  expect(turn).toHaveBeenCalledTimes(2);
  expect((await runner.read("synthetic", "cursor"))?.status).toBe("complete");
  expect(await runner.read("synthetic", "dsh")).toBeNull();
}));

it("pauses without dispatching another turn after a pause request", () => withRunner(async runner => {
  const turn = vi.fn(async () => {
    await runner.pause("synthetic", "ccc");
    return { outcome: "done", reply: "Progress\n[[GOAL:continue]]" };
  });
  expect((await runner.start("synthetic", "ccc", "Finish tests", turn)).status).toBe("paused");
  expect(turn).toHaveBeenCalledOnce();
}));

it("stops on an ambiguous result or an execution error", () => withRunner(async runner => {
  for (const result of [{ outcome: "done", reply: "I will continue" }, { outcome: "error", reply: "[[GOAL:continue]]" }]) {
    const turn = vi.fn(async () => result);
    expect((await runner.start("synthetic", "dsh", "Finish tests", turn)).status).toBe("blocked");
    expect(turn).toHaveBeenCalledOnce();
  }
}));

it("bounds automatic turns and can resume the saved objective", () => withRunner(async runner => {
  let index = 0;
  const turn = vi.fn(async () => ({ outcome: "done", reply: `Progress ${++index}\n[[GOAL:continue]]` }));
  expect((await runner.start("synthetic", "dsh", "Finish tests", turn)).status).toBe("paused");
  expect(turn).toHaveBeenCalledTimes(8);
  const finish = vi.fn(async () => ({ outcome: "done", reply: "Passed acceptance.\n[[GOAL:complete]]" }));
  const result = await runner.start("synthetic", "dsh", undefined, finish);
  expect(result).toMatchObject({ objective: "Finish tests", status: "complete", rounds: 9 });
}));

it("does not recreate a cleared goal when an outstanding turn finishes", () => withRunner(async runner => {
  const turn = vi.fn(async () => {
    runner.clear("synthetic", "cursor");
    return { outcome: "done", reply: "Progress\n[[GOAL:continue]]" };
  });
  expect((await runner.start("synthetic", "cursor", "Finish tests", turn)).status).toBe("cleared");
  expect(runner.read("synthetic", "cursor")).toBeNull();
  expect(turn).toHaveBeenCalledOnce();
}));
