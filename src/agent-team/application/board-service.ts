import { randomUUID } from "node:crypto";

import { isAgentTool, type AgentTool } from "../../agent-tool.ts";
import { isBoardColumnId, type Board, type BoardColumnId, type BoardTask } from "../domain/board.ts";
import { BoardStoreError, type BoardRepository, type WorkspaceSummary } from "../repositories/board-repository.ts";

interface RevisionInput {
  expectedRevision: number;
}

export interface CreateTaskInput extends RevisionInput {
  title: string;
  description?: string;
  columnId: BoardColumnId;
}

export interface UpdateTaskInput extends RevisionInput {
  title: string;
  description?: string;
}

export interface MoveTaskInput extends RevisionInput {
  columnId: BoardColumnId;
  index: number;
}

export interface DeleteTaskInput extends RevisionInput {}

export interface BoardServiceOptions {
  now?: () => Date;
  idFactory?: () => string;
}

export class BoardService {
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(
    private readonly repository: BoardRepository,
    options: BoardServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  openWorkspace(workspacePath: string): Promise<Board> {
    return this.repository.openWorkspace(workspacePath);
  }

  findWorkspace(workspacePath: string): Promise<Board | null> {
    return this.repository.findWorkspace(workspacePath);
  }

  getBoard(boardId: string): Promise<Board> {
    return this.repository.getBoard(boardId);
  }

  listWorkspaces(): Promise<WorkspaceSummary[]> {
    return this.repository.listWorkspaces();
  }

  relinkWorkspace(boardId: string, workspacePath: string, expectedRevision: number): Promise<Board> {
    assertRevision(expectedRevision);
    return this.repository.relinkWorkspace(boardId, workspacePath, expectedRevision);
  }

  setPrimaryAgent(boardId: string, agentId: AgentTool, expectedRevision: number): Promise<Board> {
    if (!isAgentTool(agentId)) {
      throw new BoardStoreError("invalid_request", `Unsupported primary Agent: ${String(agentId)}`, 400);
    }
    return this.mutate(boardId, expectedRevision, (board) => ({ ...board, primaryAgentId: agentId }));
  }

  createTask(boardId: string, input: CreateTaskInput): Promise<Board> {
    const title = cleanTitle(input.title);
    const description = cleanDescription(input.description ?? "");
    const columnId = cleanColumn(input.columnId);
    return this.mutate(boardId, input.expectedRevision, (board, now) => {
      const siblings = activeTasks(board, columnId);
      const task: BoardTask = {
        id: this.idFactory(),
        title,
        description,
        columnId,
        order: (siblings.at(-1)?.order ?? 0) + 1000,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      return { ...board, tasks: [...board.tasks, task] };
    });
  }

  updateTask(boardId: string, taskId: string, input: UpdateTaskInput): Promise<Board> {
    const title = cleanTitle(input.title);
    const description = cleanDescription(input.description ?? "");
    return this.mutate(boardId, input.expectedRevision, (board, now) => ({
      ...board,
      tasks: board.tasks.map((task) => task.id === taskId && !task.deletedAt
        ? { ...task, title, description, updatedAt: now }
        : task),
    }), taskId);
  }

  moveTask(boardId: string, taskId: string, input: MoveTaskInput): Promise<Board> {
    const targetColumn = cleanColumn(input.columnId);
    if (!Number.isInteger(input.index) || input.index < 0) {
      throw new BoardStoreError("invalid_request", "Task index must be a non-negative integer", 400);
    }
    return this.mutate(boardId, input.expectedRevision, (board, now) => {
      const moving = board.tasks.find((task) => task.id === taskId && !task.deletedAt)!;
      const sourceColumn = moving.columnId;
      const targetTasks = activeTasks(board, targetColumn).filter((task) => task.id !== taskId);
      targetTasks.splice(Math.min(input.index, targetTasks.length), 0, { ...moving, columnId: targetColumn, updatedAt: now });

      const targetTaskIds = new Set(targetTasks.map((task) => task.id));
      let tasks = board.tasks.filter((task) => task.id !== taskId && !targetTaskIds.has(task.id));
      tasks.push(...targetTasks.map((task, index) => ({ ...task, columnId: targetColumn, order: (index + 1) * 1000 })));
      if (sourceColumn !== targetColumn) {
        const sourceTasks = activeTasks({ ...board, tasks }, sourceColumn);
        const sourceIds = new Set(sourceTasks.map((task) => task.id));
        tasks = tasks.map((task) => sourceIds.has(task.id)
          ? { ...task, order: (sourceTasks.findIndex((source) => source.id === task.id) + 1) * 1000 }
          : task);
      }
      return { ...board, tasks };
    }, taskId);
  }

  deleteTask(boardId: string, taskId: string, input: DeleteTaskInput): Promise<Board> {
    return this.mutate(boardId, input.expectedRevision, (board, now) => ({
      ...board,
      tasks: board.tasks.map((task) => task.id === taskId && !task.deletedAt
        ? { ...task, deletedAt: now, updatedAt: now }
        : task),
    }), taskId);
  }

  private async mutate(
    boardId: string,
    expectedRevision: number,
    transform: (board: Board, now: string) => Board,
    requiredTaskId?: string,
  ): Promise<Board> {
    assertRevision(expectedRevision);
    const board = await this.repository.getBoard(boardId);
    if (board.revision !== expectedRevision) {
      throw new BoardStoreError(
        "revision_conflict",
        `Board changed in another page (expected revision ${expectedRevision}, current ${board.revision})`,
        409,
      );
    }
    if (requiredTaskId && !board.tasks.some((task) => task.id === requiredTaskId && !task.deletedAt)) {
      throw new BoardStoreError("not_found", `Task not found: ${requiredTaskId}`, 404);
    }
    const now = this.now().toISOString();
    const next = transform(board, now);
    const updated: Board = { ...next, revision: board.revision + 1, updatedAt: now };
    await this.repository.saveBoard(updated, board.revision);
    return updated;
  }
}

function assertRevision(value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new BoardStoreError("invalid_request", "expectedRevision must be a non-negative integer", 400);
  }
}

function cleanTitle(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new BoardStoreError("invalid_request", "Task title must be a non-empty string", 400);
  }
  const title = value.trim();
  if (title.length > 200) throw new BoardStoreError("invalid_request", "Task title cannot exceed 200 characters", 400);
  return title;
}

function cleanDescription(value: unknown): string {
  if (typeof value !== "string") throw new BoardStoreError("invalid_request", "Task description must be a string", 400);
  if (value.length > 20_000) throw new BoardStoreError("invalid_request", "Task description cannot exceed 20000 characters", 400);
  return value;
}

function cleanColumn(value: unknown): BoardColumnId {
  if (!isBoardColumnId(value)) throw new BoardStoreError("invalid_request", `Unknown board column: ${String(value)}`, 400);
  return value;
}

function activeTasks(board: Board, columnId: BoardColumnId): BoardTask[] {
  return board.tasks
    .filter((task) => !task.deletedAt && task.columnId === columnId)
    .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt));
}
