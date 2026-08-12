import type { Board } from "../domain/board.ts";

export interface BoardSyncCursor {
  provider: string;
  value: string;
}

export interface BoardSyncConflict {
  taskId: string;
  field: string;
  localValue: unknown;
  remoteValue: unknown;
}

export interface BoardPullResult {
  board: Board;
  cursor?: BoardSyncCursor;
  conflicts: BoardSyncConflict[];
}

/**
 * Provider boundary for future Feishu Bitable synchronization.
 * Local JSON remains a BoardRepository; synchronization is an explicit operation
 * and never leaks provider field names into the board domain or HTTP API.
 */
export interface BoardSyncAdapter {
  readonly provider: string;
  pull(local: Board, cursor?: BoardSyncCursor): Promise<BoardPullResult>;
  push(local: Board, cursor?: BoardSyncCursor): Promise<{ cursor?: BoardSyncCursor }>;
}
