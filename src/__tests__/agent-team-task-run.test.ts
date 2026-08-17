import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BoardService } from "../agent-team/application/board-service.ts";
import {
  TaskExecutionService,
  type TaskExecutionRuntime,
} from "../agent-team/application/task-execution-service.ts";
import type { TaskRun, TaskRunRepository } from "../agent-team/domain/task-run.ts";
import type { ExecutionTranscriptEntry } from "../execution-transcript.ts";
import { JsonBoardRepository } from "../agent-team/repositories/json-board-repository.ts";
import type { MainAgentBinding } from "../agent-team/repositories/main-agent-binding-repository.ts";
import { JsonTaskRunRepository } from "../agent-team/repositories/json-task-run-repository.ts";

class MemoryTaskRunRepository implements TaskRunRepository {
  readonly runs = new Map<string, TaskRun>();

  async get(runId: string): Promise<TaskRun | null> {
    return this.runs.get(runId) ?? null;
  }

  async save(run: TaskRun): Promise<void> {
    this.runs.set(run.runId, structuredClone(run));
  }

  async listByProject(projectId: string): Promise<TaskRun[]> {
    return [...this.runs.values()].filter((run) => run.projectId === projectId);
  }

  async listActive(): Promise<TaskRun[]> {
    return [...this.runs.values()].filter((run) => run.state === "queued" || run.state === "running");
  }
}

describe("Agent Team task execution", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "chatccc-task-run-"));
    tempRoots.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const boardService = new BoardService(
      new JsonBoardRepository({ rootDir: join(root, "boards"), idFactory: () => "project-1" }),
      { idFactory: (() => { let id = 0; return () => `task-${++id}`; })() },
    );
    let board = await boardService.openWorkspace(workspace);
    board = await boardService.createTask(board.boardId, {
      expectedRevision: board.revision,
      title: "Implement task execution",
      description: "Persist the outcome",
      columnId: "todo",
    });
    board = await boardService.createTask(board.boardId, {
      expectedRevision: board.revision,
      title: "Second task",
      columnId: "todo",
    });

    const repository = new MemoryTaskRunRepository();
    type RuntimeResult = { outcome: "done" | "stopped" | "error"; result?: string; error?: string; transcript?: ExecutionTranscriptEntry[] };
    let finish!: (value: RuntimeResult) => void;
    let execution = new Promise<RuntimeResult>((resolve) => {
      finish = resolve;
    });
    const runtime: TaskExecutionRuntime = {
      run: vi.fn(() => execution),
      getTranscript: vi.fn(async (): Promise<ExecutionTranscriptEntry[]> => [
        { type: "tool_use", at: "2026-08-17T00:00:03.000Z", name: "read_file", toolUseId: "live-1", input: "README.md" },
      ]),
      stop: vi.fn(() => true),
      isSessionRunning: vi.fn(() => false),
    };
    const binding: MainAgentBinding = {
      schemaVersion: 1,
      projectId: board.boardId,
      platform: "feishu",
      chatId: "oc_main",
      sessionId: "session-main",
      agentId: "codex",
      namingPolicy: "project-fixed",
      status: "ready",
      ownerOpenId: "ou_owner",
      updatedAt: "2026-08-17T00:00:00.000Z",
    };
    let runId = 0;
    const service = new TaskExecutionService({
      boardService,
      repository,
      runtime,
      getBinding: async () => binding,
      idFactory: () => `run-${++runId}`,
      now: (() => {
        let tick = 0;
        return () => new Date(Date.UTC(2026, 7, 17, 0, 0, tick++));
      })(),
    });

    return {
      board,
      boardService,
      repository,
      runtime,
      service,
      finish,
      resetExecution() {
        execution = new Promise((resolve) => { finish = resolve; });
        return (value: RuntimeResult) => finish(value);
      },
    };
  }

  it("runs one task through the bound main Agent and moves success to Done", async () => {
    const { board, boardService, repository, runtime, service, finish } = await fixture();

    const started = await service.startTask(board.boardId, "task-1", board.revision);
    expect(started.run).toMatchObject({
      runId: "run-1",
      taskId: "task-1",
      attempt: 1,
      state: "running",
      sessionId: "session-main",
      chatId: "oc_main",
      agentId: "codex",
    });
    expect(started.board.tasks.find((task) => task.id === "task-1")?.columnId).toBe("doing");
    expect(runtime.run).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-main",
      chatId: "oc_main",
      agentId: "codex",
      prompt: expect.stringContaining("Implement task execution"),
    }));

    finish({
      outcome: "done",
      result: "Implemented and verified.",
      transcript: [
        { type: "tool_use", at: "2026-08-17T00:00:03.000Z", name: "run_command", toolUseId: "tool-1", input: "npm test" },
        { type: "tool_result", at: "2026-08-17T00:00:04.000Z", name: "run_command", toolUseId: "tool-1", output: "all passed" },
        { type: "text", at: "2026-08-17T00:00:05.000Z", text: "Implemented and verified." },
      ],
    });
    const completed = await service.waitForRun("run-1");
    expect(completed).toMatchObject({ state: "succeeded", result: "Implemented and verified." });
    expect(completed.transcript?.map((entry) => entry.type)).toEqual(["prompt", "tool_use", "tool_result", "text"]);
    expect((await repository.get("run-1"))?.transcript).toEqual(completed.transcript);
    expect((await boardService.getBoard(board.boardId)).tasks.find((task) => task.id === "task-1")?.columnId).toBe("done");
    expect((await repository.get("run-1"))?.state).toBe("succeeded");
  });

  it("is idempotent for the same active task and rejects another task in the project", async () => {
    const { board, runtime, service } = await fixture();
    const first = await service.startTask(board.boardId, "task-1", board.revision);

    const repeated = await service.startTask(board.boardId, "task-1", board.revision);
    expect(repeated.run.runId).toBe(first.run.runId);
    expect(runtime.run).toHaveBeenCalledTimes(1);

    await expect(service.startTask(board.boardId, "task-2", first.board.revision))
      .rejects.toMatchObject({ code: "task_run_busy", status: 409 });
  });

  it("keeps run lists lightweight and returns the live transcript from the detail read", async () => {
    const { board, repository, service } = await fixture();
    const started = await service.startTask(board.boardId, "task-1", board.revision);

    const listed = await service.listRuns(board.boardId);
    expect(listed[0]?.transcript).toBeUndefined();
    const detailed = await service.getRun(board.boardId, started.run.runId);
    expect(detailed.transcript?.map((entry) => entry.type)).toEqual(["prompt", "tool_use"]);
    expect((await repository.get(started.run.runId))?.transcript?.map((entry) => entry.type)).toEqual(["prompt"]);
  });

  it("stops a running task and leaves it On hold", async () => {
    const { board, boardService, runtime, service, finish } = await fixture();
    const started = await service.startTask(board.boardId, "task-1", board.revision);

    const stopping = await service.stopRun(board.boardId, started.run.runId);
    expect(stopping.stopRequestedAt).toBeTruthy();
    expect(runtime.stop).toHaveBeenCalledWith("session-main");
    finish({ outcome: "stopped" });

    const stopped = await service.waitForRun(started.run.runId);
    expect(stopped.state).toBe("canceled");
    expect((await boardService.getBoard(board.boardId)).tasks.find((task) => task.id === "task-1")?.columnId).toBe("on_hold");
  });

  it("records failures, supports a new retry attempt, and never replays interrupted work", async () => {
    const { board, boardService, repository, service, finish, resetExecution, runtime } = await fixture();
    const started = await service.startTask(board.boardId, "task-1", board.revision);
    finish({ outcome: "error", error: "Agent process exited" });
    const failed = await service.waitForRun(started.run.runId);
    expect(failed).toMatchObject({ state: "failed", error: "Agent process exited" });
    let current = await boardService.getBoard(board.boardId);
    expect(current.tasks.find((task) => task.id === "task-1")?.columnId).toBe("on_hold");

    const finishRetry = resetExecution();
    const retry = await service.startTask(board.boardId, "task-1", current.revision);
    expect(retry.run.attempt).toBe(2);
    finishRetry({ outcome: "done", result: "Retry passed" });
    await service.waitForRun(retry.run.runId);

    current = await boardService.getBoard(board.boardId);
    current = await boardService.moveTask(board.boardId, "task-2", {
      expectedRevision: current.revision,
      columnId: "doing",
      index: 0,
    });
    const stale: TaskRun = {
      ...retry.run,
      runId: "run-stale",
      taskId: "task-2",
      taskTitle: "Second task",
      state: "running",
      result: undefined,
      finishedAt: undefined,
      updatedAt: "2026-08-17T00:10:00.000Z",
    };
    await repository.save(stale);
    const recovered = await service.recoverInterruptedRuns();
    expect(recovered).toBe(1);
    expect(await repository.get("run-stale")).toMatchObject({
      state: "interrupted",
      error: "ChatCCC restarted while this task was running",
    });
    expect(runtime.run).toHaveBeenCalledTimes(2);
    expect((await boardService.getBoard(board.boardId)).tasks.find((task) => task.id === "task-2")?.columnId).toBe("on_hold");
  });

  it("persists task runs as project-scoped JSON records", async () => {
    const root = await mkdtemp(join(tmpdir(), "chatccc-task-run-json-"));
    tempRoots.push(root);
    const repository = new JsonTaskRunRepository({ rootDir: root });
    const run: TaskRun = {
      schemaVersion: 1,
      runId: "run-json",
      projectId: "project-json",
      taskId: "task-json",
      taskTitle: "Persistent task",
      taskDescription: "",
      attempt: 1,
      state: "running",
      agentId: "codex",
      chatId: "oc_main",
      sessionId: "session-main",
      createdAt: "2026-08-17T00:00:00.000Z",
      updatedAt: "2026-08-17T00:00:00.000Z",
      transcript: [
        { type: "prompt", at: "2026-08-17T00:00:00.000Z", text: "Run the task" },
        { type: "tool_result", at: "2026-08-17T00:00:01.000Z", toolUseId: "tool-json", output: "complete output" },
      ],
    };

    await repository.save(run);
    expect(await repository.get(run.runId)).toEqual(run);
    expect(await repository.listByProject(run.projectId)).toEqual([run]);
    expect(await repository.listActive()).toEqual([run]);

    await repository.save({ ...run, state: "succeeded", finishedAt: "2026-08-17T00:01:00.000Z" });
    expect(await repository.listActive()).toEqual([]);
  });
});
