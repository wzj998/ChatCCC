import { isAgentTool, type AgentTool } from "../../agent-tool.ts";

export const BOARD_SCHEMA_VERSION = 1 as const;

export const BOARD_COLUMNS = [
  { id: "brainstorm", title: "头脑风暴", order: 0 },
  { id: "todo", title: "Todo", order: 1 },
  { id: "doing", title: "Doing", order: 2 },
  { id: "done", title: "Done", order: 3 },
  { id: "on_hold", title: "搁置", order: 4 },
] as const;

export type BoardColumnId = typeof BOARD_COLUMNS[number]["id"];

export interface BoardColumn {
  id: BoardColumnId;
  title: string;
  order: number;
}

export interface BoardTaskExternalRef {
  recordId: string;
  revision?: string;
  lastSyncedAt?: string;
}

export interface BoardTask {
  id: string;
  title: string;
  description: string;
  columnId: BoardColumnId;
  order: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  /** Provider-neutral mapping reserved for future Bitable and other sync adapters. */
  externalRefs?: Record<string, BoardTaskExternalRef>;
}

export interface Board {
  schemaVersion: typeof BOARD_SCHEMA_VERSION;
  boardId: string;
  workspacePath: string;
  /** Project-level preference. Feishu chat/session bindings are stored separately. */
  primaryAgentId?: AgentTool;
  revision: number;
  columns: BoardColumn[];
  tasks: BoardTask[];
  createdAt: string;
  updatedAt: string;
}

export const BOARD_COLUMN_IDS = new Set<string>(BOARD_COLUMNS.map((column) => column.id));

export function isBoardColumnId(value: unknown): value is BoardColumnId {
  return typeof value === "string" && BOARD_COLUMN_IDS.has(value);
}

export function createEmptyBoard(input: {
  boardId: string;
  workspacePath: string;
  now: string;
}): Board {
  return {
    schemaVersion: BOARD_SCHEMA_VERSION,
    boardId: input.boardId,
    workspacePath: input.workspacePath,
    revision: 0,
    columns: BOARD_COLUMNS.map((column) => ({ ...column })),
    tasks: [],
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function parseBoard(value: unknown): Board {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Board JSON must be an object");
  const board = value as Partial<Board>;
  if (board.schemaVersion !== BOARD_SCHEMA_VERSION) throw new Error(`Unsupported board schema version: ${String(board.schemaVersion)}`);
  if (typeof board.boardId !== "string" || !board.boardId) throw new Error("Board is missing boardId");
  if (typeof board.workspacePath !== "string" || !board.workspacePath) throw new Error("Board is missing workspacePath");
  if (board.primaryAgentId !== undefined && !isAgentTool(board.primaryAgentId)) {
    throw new Error(`Unsupported primary Agent: ${String(board.primaryAgentId)}`);
  }
  if (!Number.isInteger(board.revision) || board.revision! < 0) throw new Error("Board revision is invalid");
  if (!Array.isArray(board.tasks)) throw new Error("Board tasks must be an array");

  for (const task of board.tasks) {
    if (!task || typeof task !== "object") throw new Error("Board task is invalid");
    const candidate = task as Partial<BoardTask>;
    if (typeof candidate.id !== "string" || !candidate.id) throw new Error("Board task is missing id");
    if (typeof candidate.title !== "string") throw new Error("Board task title is invalid");
    if (typeof candidate.description !== "string") throw new Error("Board task description is invalid");
    if (!isBoardColumnId(candidate.columnId)) throw new Error(`Unknown board column: ${String(candidate.columnId)}`);
    if (!Number.isFinite(candidate.order)) throw new Error("Board task order is invalid");
    if (typeof candidate.createdAt !== "string" || typeof candidate.updatedAt !== "string") {
      throw new Error("Board task timestamps are invalid");
    }
    if (candidate.deletedAt !== null && typeof candidate.deletedAt !== "string") {
      throw new Error("Board task deletedAt is invalid");
    }
  }

  return {
    ...board,
    columns: BOARD_COLUMNS.map((column) => ({ ...column })),
    tasks: board.tasks as BoardTask[],
  } as Board;
}
