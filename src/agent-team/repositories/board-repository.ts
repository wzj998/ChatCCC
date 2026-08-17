import type { Board } from "../domain/board.ts";

export interface WorkspaceSummary {
  boardId: string;
  workspacePath: string;
  lastOpenedAt: string;
  exists: boolean;
}

export interface BoardRepository {
  findWorkspace(workspacePath: string): Promise<Board | null>;
  openWorkspace(workspacePath: string): Promise<Board>;
  getBoard(boardId: string): Promise<Board>;
  saveBoard(board: Board, expectedRevision: number): Promise<void>;
  listWorkspaces(): Promise<WorkspaceSummary[]>;
  relinkWorkspace(boardId: string, workspacePath: string, expectedRevision: number): Promise<Board>;
}

export class BoardStoreError extends Error {
  constructor(
    public readonly code:
      | "invalid_request"
      | "not_found"
      | "revision_conflict"
      | "workspace_conflict"
      | "storage_error"
      | "feishu_dm_required"
      | "main_agent_running"
      | "main_agent_unavailable"
      | "task_run_busy"
      | "task_run_not_found",
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "BoardStoreError";
  }
}
