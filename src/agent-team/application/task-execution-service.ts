import { randomUUID } from "node:crypto";

import type { AgentTool } from "../../agent-tool.ts";
import type { ExecutionTranscriptEntry } from "../../execution-transcript.ts";
import type { Board, BoardTask } from "../domain/board.ts";
import {
  isActiveTaskRun,
  type TaskRun,
  type TaskRunFailureCode,
  type TaskRunRepository,
} from "../domain/task-run.ts";
import type { MainAgentBinding } from "../repositories/main-agent-binding-repository.ts";
import { BoardStoreError } from "../repositories/board-repository.ts";
import type { BoardService } from "./board-service.ts";
import {
  beginSafeMaintenanceTrackedWork,
  isSafeMaintenanceAdmissionClosed,
} from "../../safe-maintenance.ts";

export interface TaskExecutionResult {
  outcome: "done" | "stopped" | "error" | "auto_ended";
  result?: string;
  error?: string;
  transcript?: ExecutionTranscriptEntry[];
}

export interface TaskExecutionRuntime {
  run(input: {
    sessionId: string;
    chatId: string;
    agentId: AgentTool;
    prompt: string;
    traceId: string;
  }): Promise<TaskExecutionResult>;
  getSnapshot?(sessionId: string): Promise<{
    transcript: ExecutionTranscriptEntry[];
    updatedAt?: string;
    status?: "running" | "done" | "stopped" | "error" | "auto_ended";
  }>;
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
  stopTimeoutMs?: number;
  staleAfterMs?: number;
}

export interface StartTaskResult {
  board: Board;
  run: TaskRun;
}

export class TaskExecutionService {
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly stopTimeoutMs: number;
  private readonly staleAfterMs: number;
  private readonly projectOperations = new Map<string, Promise<void>>();
  private readonly executions = new Map<string, Promise<TaskRun>>();
  private readonly pendingReconciliationProjects = new Set<string>();

  constructor(private readonly options: TaskExecutionServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 30_000;
    this.staleAfterMs = options.staleAfterMs ?? 5 * 60_000;
  }

  async listRuns(projectId: string): Promise<TaskRun[]> {
    const runs = await this.options.repository.listByProject(projectId);
    return runs.map(withoutTranscript);
  }

  async getRun(projectId: string, runId: string): Promise<TaskRun> {
    const run = await this.options.repository.get(runId);
    if (!run || run.projectId !== projectId) {
      throw new BoardStoreError("task_run_not_found", "找不到这次任务执行记录", 404);
    }
    if (!isActiveTaskRun(run) || !this.options.runtime.getSnapshot) return run;
    const snapshot = await this.options.runtime.getSnapshot(run.sessionId).catch(() => null);
    return snapshot?.transcript.length
      ? { ...run, transcript: combineTranscript(run.transcript, snapshot.transcript) }
      : run;
  }

  async startTask(projectId: string, taskId: string, expectedRevision: number): Promise<StartTaskResult> {
    if (isSafeMaintenanceAdmissionClosed()) {
      throw new BoardStoreError("safe_maintenance_draining", "ChatCCC 正在等待安全维护，暂不接受新的 Agent Team 任务。", 409);
    }
    const release = beginSafeMaintenanceTrackedWork("agent-team-task-run");
    let releaseOwnedByExecution = false;
    try {
      const result = await this.exclusive(projectId, async () => {
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
      const runId = this.idFactory();
      let run: TaskRun = {
        schemaVersion: 1,
        runId,
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
        traceId: `agent-team-${runId}`,
        lastProgressAt: timestamp,
      };
      run = {
        ...run,
        transcript: [{ type: "prompt", at: timestamp, text: taskPrompt(run) }],
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
      logTaskRunEvent("started", run);
      const execution = this.execute(run).finally(() => {
        this.executions.delete(run.runId);
        release();
      });
      releaseOwnedByExecution = true;
      this.executions.set(run.runId, execution);
      void execution.catch((err) => {
        console.error(`[Agent Team] Task run ${run.runId} failed to persist its terminal state: ${(err as Error).message}`);
      });
      return { board, run };
      });
      return result;
    } finally {
      if (!releaseOwnedByExecution) release();
    }
  }

  async stopRun(projectId: string, runId: string): Promise<TaskRun> {
    return this.exclusive(projectId, async () => {
      const run = await this.options.repository.get(runId);
      if (!run || run.projectId !== projectId) throw new BoardStoreError("task_run_not_found", "找不到这次任务执行记录", 404);
      if (!isActiveTaskRun(run)) return run;
      const now = this.now().toISOString();
      const updated = {
        ...run,
        stopRequestedAt: run.stopRequestedAt ?? now,
        stopDeadlineAt: run.stopDeadlineAt ?? new Date(Date.parse(now) + this.stopTimeoutMs).toISOString(),
        updatedAt: now,
      };
      await this.options.repository.save(updated);
      const stopped = this.options.runtime.stop(run.sessionId);
      if (!stopped && !this.options.runtime.isSessionRunning(run.sessionId)) {
        return this.finishRun(updated, "interrupted", {
          error: "Task process was no longer running",
          failureCode: "process_missing",
        });
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
    await Promise.all(active.map(async (run) => {
      const snapshot = await this.readSnapshot(run);
      await this.finishRun(run, "interrupted", {
        error: "ChatCCC restarted while this task was running",
        failureCode: "chatccc_restart",
        transcript: snapshot?.transcript,
      });
    }));
    const workspaces = await this.options.boardService.listWorkspaces().catch(() => []);
    await Promise.all(workspaces.map((workspace) => this.reconcileProject(workspace.boardId)));
    return active.length;
  }

  /** Persist live execution state and enforce stop deadlines. Safe to call repeatedly from a timer. */
  async checkpointActiveRuns(): Promise<number> {
    const active = await this.options.repository.listActive();
    await Promise.all(active.map((run) => this.exclusive(run.projectId, () => this.checkpointRun(run.runId))));
    const pending = [...this.pendingReconciliationProjects];
    await Promise.all(pending.map((projectId) => this.reconcileProject(projectId)));
    return active.length;
  }

  async reconcileProject(projectId: string): Promise<number> {
    return this.exclusive(projectId, async () => {
      const runs = await this.options.repository.listByProject(projectId);
      const latestByTask = new Map<string, TaskRun>();
      for (const run of runs) {
        if (!latestByTask.has(run.taskId)) latestByTask.set(run.taskId, run);
      }
      let reconciled = 0;
      let failed = false;
      for (const run of latestByTask.values()) {
        // Only repair a transition that this service previously recorded as partial.
        // A user may intentionally move an already-synced card after completion.
        if (isActiveTaskRun(run) || run.boardSyncPending !== true) continue;
        try {
          await this.moveFinishedTask(run);
          const now = this.now().toISOString();
          await this.options.repository.save({
            ...run,
            boardSyncPending: false,
            reconciledAt: now,
            updatedAt: now,
            syncError: undefined,
          });
          reconciled++;
        } catch (err) {
          await this.options.repository.save({
            ...run,
            boardSyncPending: true,
            syncError: (err as Error).message,
          });
          this.pendingReconciliationProjects.add(projectId);
          logTaskRunEvent("board_sync_failed", run, { error: (err as Error).message });
          failed = true;
          continue;
        }
      }
      if (!failed) this.pendingReconciliationProjects.delete(projectId);
      return reconciled;
    });
  }

  private async execute(run: TaskRun): Promise<TaskRun> {
    try {
      const result = await this.options.runtime.run({
        sessionId: run.sessionId,
        chatId: run.chatId,
        agentId: run.agentId,
        traceId: run.traceId ?? `agent-team-${run.runId}`,
        prompt: taskPrompt(run),
      });
      if (result.outcome === "done") {
        return this.finishRun(run, "succeeded", { result: result.result, transcript: result.transcript, moveTask: true });
      }
      if (result.outcome === "stopped") {
        return this.finishRun(run, "canceled", {
          error: result.error,
          failureCode: "user_stopped",
          transcript: result.transcript,
          moveTask: true,
        });
      }
      return this.finishRun(run, "failed", {
        error: result.error || (result.outcome === "auto_ended" ? "Agent response timed out" : "Agent execution failed"),
        failureCode: result.outcome === "auto_ended" ? "agent_timeout" : "agent_error",
        result: result.result,
        transcript: result.transcript,
        moveTask: true,
      });
    } catch (err) {
      return this.finishRun(run, "failed", {
        error: (err as Error).message,
        failureCode: "agent_error",
        moveTask: true,
      });
    }
  }

  private async finishRun(
    run: TaskRun,
    state: Extract<TaskRun["state"], "succeeded" | "failed" | "canceled" | "interrupted">,
    details: {
      result?: string;
      error?: string;
      failureCode?: TaskRunFailureCode;
      transcript?: ExecutionTranscriptEntry[];
      moveTask?: boolean;
    } = {},
  ): Promise<TaskRun> {
    const now = this.now().toISOString();
    const latest = await this.options.repository.get(run.runId) ?? run;
    if (!isActiveTaskRun(latest)) return latest;
    const updated: TaskRun = {
      ...latest,
      state,
      updatedAt: now,
      finishedAt: now,
      stalledAt: undefined,
      lastProgressAt: latestTranscriptAt(details.transcript) ?? latest.lastProgressAt ?? now,
      ...(details.transcript?.length ? { transcript: combineTranscript(latest.transcript, details.transcript) } : {}),
      ...(details.result ? { result: details.result } : {}),
      ...(details.error ? { error: details.error } : {}),
      ...(details.failureCode ? { failureCode: details.failureCode } : {}),
      ...(details.moveTask !== false ? { boardSyncPending: true } : {}),
    };
    await this.options.repository.save(updated);
    logTaskRunEvent("finished", updated);
    if (details.moveTask !== false) {
      try {
        await this.moveFinishedTask(updated);
        const reconciledAt = this.now().toISOString();
        await this.options.repository.save({
          ...updated,
          boardSyncPending: false,
          reconciledAt,
          updatedAt: reconciledAt,
          syncError: undefined,
        });
      } catch (err) {
        await this.options.repository.save({
          ...updated,
          boardSyncPending: true,
          syncError: (err as Error).message,
        });
        this.pendingReconciliationProjects.add(run.projectId);
        logTaskRunEvent("board_sync_failed", updated, { error: (err as Error).message });
      }
    }
    return await this.options.repository.get(run.runId) ?? updated;
  }

  private async moveFinishedTask(run: TaskRun): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const board = await this.options.boardService.getBoard(run.projectId);
      const task = board.tasks.find((candidate) => candidate.id === run.taskId && !candidate.deletedAt);
      if (!task) return;
      const target = run.state === "succeeded" ? "done" : "on_hold";
      if (task.columnId === target) return;
      const targetCount = board.tasks.filter((candidate) => !candidate.deletedAt && candidate.columnId === target).length;
      try {
        await this.options.boardService.moveTask(run.projectId, run.taskId, {
          expectedRevision: board.revision,
          columnId: target,
          index: targetCount,
        });
        return;
      } catch (err) {
        if (!(err instanceof BoardStoreError) || err.code !== "revision_conflict" || attempt === 2) throw err;
      }
    }
  }

  private async checkpointRun(runId: string): Promise<void> {
    const run = await this.options.repository.get(runId);
    if (!run || !isActiveTaskRun(run)) return;
    const now = this.now();
    const snapshot = await this.readSnapshot(run);
    const transcript = snapshot?.transcript.length
      ? combineTranscript(run.transcript, snapshot.transcript)
      : run.transcript;
    const snapshotProgressAt = latestIso(
      validIso(snapshot?.updatedAt),
      run.lastProgressAt ?? run.startedAt ?? run.createdAt,
    );
    const madeProgress = snapshotProgressAt > (run.lastProgressAt ?? "");
    const stalled = now.getTime() - Date.parse(snapshotProgressAt) >= this.staleAfterMs;
    const updated: TaskRun = {
      ...run,
      transcript,
      lastProgressAt: snapshotProgressAt,
      updatedAt: madeProgress ? now.toISOString() : run.updatedAt,
      stalledAt: stalled ? (run.stalledAt ?? now.toISOString()) : undefined,
    };
    if (JSON.stringify(updated) !== JSON.stringify(run)) await this.options.repository.save(updated);

    if (updated.stopDeadlineAt && Date.parse(updated.stopDeadlineAt) <= now.getTime()) {
      this.options.runtime.stop(updated.sessionId);
      await this.finishRun(updated, "canceled", {
        error: "Agent did not stop before the requested deadline",
        failureCode: "stop_timeout",
        transcript: snapshot?.transcript,
        moveTask: true,
      });
      return;
    }

    const board = await this.options.boardService.getBoard(updated.projectId);
    const taskExists = board.tasks.some((task) => task.id === updated.taskId && !task.deletedAt);
    if (!taskExists) {
      this.options.runtime.stop(updated.sessionId);
      await this.finishRun(updated, "canceled", {
        error: "Task was deleted while the Agent was running",
        failureCode: "task_deleted",
        transcript: snapshot?.transcript,
        moveTask: false,
      });
    }
  }

  private async readSnapshot(run: TaskRun) {
    return this.options.runtime.getSnapshot?.(run.sessionId).catch(() => null) ?? null;
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

function combineTranscript(
  existing: ExecutionTranscriptEntry[] | undefined,
  live: ExecutionTranscriptEntry[],
): ExecutionTranscriptEntry[] {
  const prompts = (existing ?? []).filter((entry) => entry.type === "prompt");
  return compactTranscript([...prompts, ...live]);
}

const MAX_TRANSCRIPT_ENTRIES = 2_000;
const MAX_TRANSCRIPT_CHARS = 2_000_000;
const MAX_TRANSCRIPT_FIELD_CHARS = 100_000;

function compactTranscript(entries: ExecutionTranscriptEntry[]): ExecutionTranscriptEntry[] {
  const prompt = entries.find((entry) => entry.type === "prompt");
  const tail = entries.filter((entry) => entry !== prompt).slice(-(MAX_TRANSCRIPT_ENTRIES - (prompt ? 1 : 0)));
  const kept = [...(prompt ? [prompt] : []), ...tail].map((entry) => {
    const compacted = { ...entry };
    for (const field of ["text", "input", "output"] as const) {
      const value = compacted[field];
      if (value && value.length > MAX_TRANSCRIPT_FIELD_CHARS) {
        compacted[field] = `${value.slice(0, MAX_TRANSCRIPT_FIELD_CHARS)}\n…（内容已截断）`;
      }
    }
    return compacted;
  });
  let remaining = MAX_TRANSCRIPT_CHARS;
  const result: ExecutionTranscriptEntry[] = [];
  for (let index = kept.length - 1; index >= 0; index--) {
    const entry = kept[index]!;
    const size = JSON.stringify(entry).length;
    if (size > remaining && result.length) break;
    result.unshift(entry);
    remaining -= size;
  }
  return result;
}

function validIso(value: string | undefined): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function latestIso(first: string | null, second: string): string {
  if (!first) return second;
  return Date.parse(first) >= Date.parse(second) ? first : second;
}

function latestTranscriptAt(entries: ExecutionTranscriptEntry[] | undefined): string | null {
  if (!entries?.length) return null;
  for (let index = entries.length - 1; index >= 0; index--) {
    const at = validIso(entries[index]?.at);
    if (at) return at;
  }
  return null;
}

function logTaskRunEvent(event: string, run: TaskRun, details: Record<string, unknown> = {}): void {
  console.log(`[Agent Team] ${JSON.stringify({
    event,
    projectId: run.projectId,
    taskId: run.taskId,
    runId: run.runId,
    traceId: run.traceId,
    state: run.state,
    attempt: run.attempt,
    ...details,
  })}`);
}

function withoutTranscript(run: TaskRun): TaskRun {
  const { transcript: _transcript, ...summary } = run;
  return summary;
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
