import { randomUUID } from "node:crypto";

import type { AgentTool } from "../../agent-tool.ts";
import type { Board, BoardTask } from "../domain/board.ts";
import { isActiveTaskRun, type TaskRun, type TaskRunRepository } from "../domain/task-run.ts";
import type { MainAgentBinding } from "../repositories/main-agent-binding-repository.ts";
import { BoardStoreError } from "../repositories/board-repository.ts";
import type { BoardService } from "./board-service.ts";

export interface TaskExecutionResult {
  outcome: "done" | "stopped" | "error" | "auto_ended";
  result?: string;
  error?: string;
}

export interface TaskExecutionRuntime {
  run(input: {
    sessionId: string;
    chatId: string;
    agentId: AgentTool;
    prompt: string;
    traceId: string;
  }): Promise<TaskExecutionResult>;
  stop(sessionId: string): boolean;
  isSessionRunning(sessionId: string): boolean;
}

export interface TaskExecutionServiceOptions {
  boardService: BoardService;
  repository: TaskRunRepository;
  runtime: TaskExecutionRuntime;
  getBinding(projectId: string): Promise<MainAgentBinding | null>;
  now?: () => Date;
  idFactory?: () => string;
}

export interface StartTaskResult {
  board: Board;
  run: TaskRun;
}

export class TaskExecutionService {
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly projectOperations = new Map<string, Promise<void>>();
  private readonly executions = new Map<string, Promise<TaskRun>>();

  constructor(private readonly options: TaskExecutionServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  listRuns(projectId: string): Promise<TaskRun[]> {
    return this.options.repository.listByProject(projectId);
  }

  async startTask(projectId: string, taskId: string, expectedRevision: number): Promise<StartTaskResult> {
    return this.exclusive(projectId, async () => {
      let board = await this.options.boardService.getBoard(projectId);
      const active = (await this.options.repository.listByProject(projectId)).find(isActiveTaskRun);
      if (active) {
        if (active.taskId === taskId) return { board, run: active };
        throw new BoardStoreError("task_run_busy", "该项目已有任务正在由主 Agent 执行", 409);
      }
      if (board.revision !== expectedRevision) {
        throw new BoardStoreError(
          "revision_conflict",
          `Board changed in another page (expected revision ${expectedRevision}, current ${board.revision})`,
          409,
        );
      }
      const task = board.tasks.find((candidate) => candidate.id === taskId && !candidate.deletedAt);
      if (!task) throw new BoardStoreError("not_found", `Task not found: ${taskId}`, 404);

      const binding = await this.options.getBinding(projectId);
      if (!binding || binding.status !== "ready" || !binding.chatId || !binding.sessionId) {
        throw new BoardStoreError("main_agent_unavailable", "请先为项目设置可用的主 Agent", 409);
      }
      if (this.options.runtime.isSessionRunning(binding.sessionId)) {
        throw new BoardStoreError("task_run_busy", "主 Agent 正在处理其他消息，请稍后再试", 409);
      }

      const priorRuns = await this.options.repository.listByProject(projectId);
      const timestamp = this.now().toISOString();
      let run: TaskRun = {
        schemaVersion: 1,
        runId: this.idFactory(),
        projectId,
        taskId,
        taskTitle: task.title,
        taskDescription: task.description,
        attempt: priorRuns.filter((candidate) => candidate.taskId === taskId).length + 1,
        state: "queued",
        agentId: binding.agentId,
        chatId: binding.chatId,
        sessionId: binding.sessionId,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await this.options.repository.save(run);

      try {
        if (task.columnId !== "doing") {
          const doingCount = board.tasks.filter((candidate) => !candidate.deletedAt && candidate.columnId === "doing").length;
          board = await this.options.boardService.moveTask(projectId, taskId, {
            expectedRevision: board.revision,
            columnId: "doing",
            index: doingCount,
          });
        }
      } catch (err) {
        run = await this.finishRun(run, "failed", { error: (err as Error).message });
        throw err;
      }

      const startedAt = this.now().toISOString();
      run = { ...run, state: "running", startedAt, updatedAt: startedAt };
      await this.options.repository.save(run);
      const execution = this.execute(run).finally(() => {
        this.executions.delete(run.runId);
      });
      this.executions.set(run.runId, execution);
      void execution.catch((err) => {
        console.error(`[Agent Team] Task run ${run.runId} failed to persist its terminal state: ${(err as Error).message}`);
      });
      return { board, run };
    });
  }

  async stopRun(projectId: string, runId: string): Promise<TaskRun> {
    return this.exclusive(projectId, async () => {
      const run = await this.options.repository.get(runId);
      if (!run || run.projectId !== projectId) throw new BoardStoreError("task_run_not_found", "找不到这次任务执行记录", 404);
      if (!isActiveTaskRun(run)) return run;
      const now = this.now().toISOString();
      const updated = { ...run, stopRequestedAt: run.stopRequestedAt ?? now, updatedAt: now };
      await this.options.repository.save(updated);
      const stopped = this.options.runtime.stop(run.sessionId);
      if (!stopped && !this.options.runtime.isSessionRunning(run.sessionId)) {
        return this.finishRun(updated, "interrupted", { error: "Task process was no longer running" });
      }
      return updated;
    });
  }

  async waitForRun(runId: string): Promise<TaskRun> {
    const execution = this.executions.get(runId);
    if (execution) return execution;
    const run = await this.options.repository.get(runId);
    if (!run) throw new BoardStoreError("task_run_not_found", "找不到这次任务执行记录", 404);
    return run;
  }

  async recoverInterruptedRuns(): Promise<number> {
    const active = await this.options.repository.listActive();
    await Promise.all(active.map((run) => this.finishRun(run, "interrupted", {
      error: "ChatCCC restarted while this task was running",
    })));
    return active.length;
  }

  private async execute(run: TaskRun): Promise<TaskRun> {
    try {
      const result = await this.options.runtime.run({
        sessionId: run.sessionId,
        chatId: run.chatId,
        agentId: run.agentId,
        traceId: `agent-team-${run.runId}`,
        prompt: taskPrompt(run),
      });
      if (result.outcome === "done") {
        return this.finishRun(run, "succeeded", { result: result.result, moveTask: true });
      }
      if (result.outcome === "stopped") {
        return this.finishRun(run, "canceled", { error: result.error, moveTask: true });
      }
      return this.finishRun(run, "failed", {
        error: result.error || (result.outcome === "auto_ended" ? "Agent response timed out" : "Agent execution failed"),
        result: result.result,
        moveTask: true,
      });
    } catch (err) {
      return this.finishRun(run, "failed", { error: (err as Error).message, moveTask: true });
    }
  }

  private async finishRun(
    run: TaskRun,
    state: Extract<TaskRun["state"], "succeeded" | "failed" | "canceled" | "interrupted">,
    details: { result?: string; error?: string; moveTask?: boolean } = {},
  ): Promise<TaskRun> {
    const now = this.now().toISOString();
    const latest = await this.options.repository.get(run.runId) ?? run;
    if (!isActiveTaskRun(latest)) return latest;
    const updated: TaskRun = {
      ...latest,
      state,
      updatedAt: now,
      finishedAt: now,
      ...(details.result ? { result: details.result } : {}),
      ...(details.error ? { error: details.error } : {}),
    };
    await this.options.repository.save(updated);
    if (details.moveTask !== false) {
      await this.moveFinishedTask(updated).catch(async (err) => {
        await this.options.repository.save({
          ...updated,
          error: updated.error || `Task completed but board update failed: ${(err as Error).message}`,
        });
      });
    }
    return await this.options.repository.get(run.runId) ?? updated;
  }

  private async moveFinishedTask(run: TaskRun): Promise<void> {
    const board = await this.options.boardService.getBoard(run.projectId);
    const task = board.tasks.find((candidate) => candidate.id === run.taskId && !candidate.deletedAt);
    if (!task) return;
    const target = run.state === "succeeded" ? "done" : "on_hold";
    if (task.columnId === target) return;
    const targetCount = board.tasks.filter((candidate) => !candidate.deletedAt && candidate.columnId === target).length;
    await this.options.boardService.moveTask(run.projectId, run.taskId, {
      expectedRevision: board.revision,
      columnId: target,
      index: targetCount,
    });
  }

  private async exclusive<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.projectOperations.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.projectOperations.set(projectId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.projectOperations.get(projectId) === current) this.projectOperations.delete(projectId);
    }
  }
}

function taskPrompt(run: Pick<TaskRun, "taskId" | "taskTitle" | "taskDescription">): string {
  return [
    "你正在执行 Agent Team 看板中的一个明确任务。请在当前工作目录完成任务，进行必要验证，并用简洁结果说明完成内容。",
    "",
    `任务 ID：${run.taskId}`,
    `任务标题：${run.taskTitle}`,
    run.taskDescription ? `任务说明：\n${run.taskDescription}` : "任务说明：（无）",
  ].join("\n");
}
