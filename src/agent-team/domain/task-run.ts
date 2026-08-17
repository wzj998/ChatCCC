import { isAgentTool, type AgentTool } from "../../agent-tool.ts";
import { isExecutionTranscriptEntry, type ExecutionTranscriptEntry } from "../../execution-transcript.ts";

export const TASK_RUN_SCHEMA_VERSION = 1 as const;

export type TaskRunState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled"
  | "interrupted";

export interface TaskRun {
  schemaVersion: typeof TASK_RUN_SCHEMA_VERSION;
  runId: string;
  projectId: string;
  taskId: string;
  taskTitle: string;
  taskDescription: string;
  attempt: number;
  state: TaskRunState;
  agentId: AgentTool;
  chatId: string;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  stopRequestedAt?: string;
  finishedAt?: string;
  /** Ordered prompt, reasoning, tool, and response events for this specific attempt. */
  transcript?: ExecutionTranscriptEntry[];
  result?: string;
  error?: string;
}

export interface TaskRunRepository {
  get(runId: string): Promise<TaskRun | null>;
  save(run: TaskRun): Promise<void>;
  listByProject(projectId: string): Promise<TaskRun[]>;
  listActive(): Promise<TaskRun[]>;
}

export function isActiveTaskRun(run: Pick<TaskRun, "state">): boolean {
  return run.state === "queued" || run.state === "running";
}

export function parseTaskRun(value: unknown): TaskRun {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid task run");
  const run = value as Partial<TaskRun>;
  if (run.schemaVersion !== TASK_RUN_SCHEMA_VERSION) throw new Error("Unsupported task run schema");
  for (const field of ["runId", "projectId", "taskId", "taskTitle", "taskDescription", "chatId", "sessionId", "createdAt", "updatedAt"] as const) {
    if (typeof run[field] !== "string" || (field !== "taskDescription" && !run[field])) {
      throw new Error(`Task run is missing ${field}`);
    }
  }
  if (!Number.isInteger(run.attempt) || run.attempt! < 1) throw new Error("Invalid task run attempt");
  if (!(["queued", "running", "succeeded", "failed", "canceled", "interrupted"] as const).includes(run.state as TaskRunState)) {
    throw new Error("Invalid task run state");
  }
  if (!isAgentTool(run.agentId)) throw new Error("Invalid task run Agent");
  for (const field of ["startedAt", "stopRequestedAt", "finishedAt", "result", "error"] as const) {
    if (run[field] !== undefined && typeof run[field] !== "string") throw new Error(`Invalid task run ${field}`);
  }
  if (run.transcript !== undefined && (!Array.isArray(run.transcript) || !run.transcript.every(isExecutionTranscriptEntry))) {
    throw new Error("Invalid task run transcript");
  }
  return run as TaskRun;
}
