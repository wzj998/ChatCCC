import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { createEmptyBoard, parseBoard, type Board } from "../domain/board.ts";
import { BoardStoreError, type BoardRepository, type WorkspaceSummary } from "./board-repository.ts";

interface WorkspaceRecord {
  boardId: string;
  workspacePath: string;
  normalizedPath: string;
  lastOpenedAt: string;
}

interface WorkspaceIndex {
  schemaVersion: 1;
  workspaces: WorkspaceRecord[];
}

const EMPTY_INDEX: WorkspaceIndex = { schemaVersion: 1, workspaces: [] };

export interface JsonBoardRepositoryOptions {
  rootDir?: string;
  now?: () => Date;
  idFactory?: () => string;
}

export class JsonBoardRepository implements BoardRepository {
  readonly rootDir: string;
  private readonly boardsDir: string;
  private readonly indexPath: string;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(options: JsonBoardRepositoryOptions = {}) {
    this.rootDir = options.rootDir ?? join(homedir(), ".chatccc", "agent-team");
    this.boardsDir = join(this.rootDir, "boards");
    this.indexPath = join(this.rootDir, "workspaces.json");
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  async findWorkspace(workspacePath: string): Promise<Board | null> {
    const canonical = await this.canonicalWorkspace(workspacePath);
    const normalizedPath = normalizeWorkspaceKey(canonical);
    const index = await this.readIndex();
    const record = index.workspaces.find((item) => item.normalizedPath === normalizedPath);
    return record ? this.readBoard(record.boardId) : null;
  }

  async openWorkspace(workspacePath: string): Promise<Board> {
    return this.exclusive(async () => {
      const canonical = await this.canonicalWorkspace(workspacePath);
      const normalizedPath = normalizeWorkspaceKey(canonical);
      const index = await this.readIndex();
      let record = index.workspaces.find((item) => item.normalizedPath === normalizedPath);
      const now = this.now().toISOString();

      if (!record) {
        const board = createEmptyBoard({ boardId: this.idFactory(), workspacePath: canonical, now });
        record = { boardId: board.boardId, workspacePath: canonical, normalizedPath, lastOpenedAt: now };
        index.workspaces.unshift(record);
        await this.writeBoard(board);
        await this.writeIndex(index);
        return board;
      }

      record.workspacePath = canonical;
      record.lastOpenedAt = now;
      await this.writeIndex(index);
      const board = await this.readBoard(record.boardId);
      if (board.workspacePath !== canonical) {
        const updated = { ...board, workspacePath: canonical, revision: board.revision + 1, updatedAt: now };
        await this.writeBoard(updated);
        return updated;
      }
      return board;
    });
  }

  async getBoard(boardId: string): Promise<Board> {
    return this.readBoard(boardId);
  }

  async saveBoard(board: Board, expectedRevision: number): Promise<void> {
    await this.exclusive(async () => {
      const current = await this.readBoard(board.boardId);
      if (current.revision !== expectedRevision) throw revisionConflict(current.revision, expectedRevision);
      if (board.revision !== expectedRevision + 1) {
        throw new BoardStoreError("invalid_request", "Board revision must increase by exactly one", 400);
      }
      parseBoard(board);
      await this.writeBoard(board);
    });
  }

  async listWorkspaces(): Promise<WorkspaceSummary[]> {
    const index = await this.readIndex();
    const sorted = [...index.workspaces].sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt)).slice(0, 20);
    return Promise.all(sorted.map(async (record) => ({
      boardId: record.boardId,
      workspacePath: record.workspacePath,
      lastOpenedAt: record.lastOpenedAt,
      exists: await directoryExists(record.workspacePath),
    })));
  }

  async relinkWorkspace(boardId: string, workspacePath: string, expectedRevision: number): Promise<Board> {
    return this.exclusive(async () => {
      const canonical = await this.canonicalWorkspace(workspacePath);
      const normalizedPath = normalizeWorkspaceKey(canonical);
      const index = await this.readIndex();
      const collision = index.workspaces.find((item) => item.normalizedPath === normalizedPath && item.boardId !== boardId);
      if (collision) {
        throw new BoardStoreError("workspace_conflict", "The selected directory already has another board", 409);
      }
      const current = await this.readBoard(boardId);
      if (current.revision !== expectedRevision) throw revisionConflict(current.revision, expectedRevision);
      const now = this.now().toISOString();
      const record = index.workspaces.find((item) => item.boardId === boardId);
      if (!record) throw new BoardStoreError("not_found", `Workspace record not found for board ${boardId}`, 404);

      record.workspacePath = canonical;
      record.normalizedPath = normalizedPath;
      record.lastOpenedAt = now;
      const updated: Board = {
        ...current,
        workspacePath: canonical,
        revision: current.revision + 1,
        updatedAt: now,
      };
      await this.writeBoard(updated);
      await this.writeIndex(index);
      return updated;
    });
  }

  private async canonicalWorkspace(input: string): Promise<string> {
    if (typeof input !== "string" || !input.trim()) {
      throw new BoardStoreError("invalid_request", "workspacePath must be a non-empty string", 400);
    }
    const absolute = resolve(input.trim());
    let info;
    try {
      info = await stat(absolute);
    } catch {
      throw new BoardStoreError("invalid_request", `Working directory does not exist: ${absolute}`, 400);
    }
    if (!info.isDirectory()) throw new BoardStoreError("invalid_request", `Not a directory: ${absolute}`, 400);
    return realpath(absolute);
  }

  private boardPath(boardId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(boardId)) {
      throw new BoardStoreError("invalid_request", "Invalid board id", 400);
    }
    return join(this.boardsDir, `${boardId}.json`);
  }

  private async readBoard(boardId: string): Promise<Board> {
    const path = this.boardPath(boardId);
    try {
      return parseBoard(JSON.parse(await readFile(path, "utf8")));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new BoardStoreError("not_found", `Board not found: ${boardId}`, 404);
      }
      if (err instanceof BoardStoreError) throw err;
      throw new BoardStoreError("storage_error", `Failed to read board ${boardId}: ${(err as Error).message}`, 500);
    }
  }

  private async readIndex(): Promise<WorkspaceIndex> {
    if (!existsSync(this.indexPath)) return { ...EMPTY_INDEX, workspaces: [] };
    try {
      const parsed = JSON.parse(await readFile(this.indexPath, "utf8")) as Partial<WorkspaceIndex>;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.workspaces)) throw new Error("Invalid workspace index");
      return { schemaVersion: 1, workspaces: parsed.workspaces };
    } catch (err) {
      throw new BoardStoreError("storage_error", `Failed to read workspace index: ${(err as Error).message}`, 500);
    }
  }

  private async writeBoard(board: Board): Promise<void> {
    await writeJsonAtomic(this.boardPath(board.boardId), board);
  }

  private async writeIndex(index: WorkspaceIndex): Promise<void> {
    const deduped = new Map<string, WorkspaceRecord>();
    for (const record of index.workspaces) deduped.set(record.boardId, record);
    await writeJsonAtomic(this.indexPath, { schemaVersion: 1, workspaces: [...deduped.values()] });
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release!: () => void;
    this.operationQueue = new Promise<void>((resolveQueue) => { release = resolveQueue; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function normalizeWorkspaceKey(path: string): string {
  const normalized = resolve(path).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await rename(tempPath, path);
  } catch (err) {
    await unlink(tempPath).catch(() => {});
    throw err;
  }
}

function revisionConflict(actual: number, expected: number): BoardStoreError {
  return new BoardStoreError(
    "revision_conflict",
    `Board changed in another page (expected revision ${expected}, current ${actual})`,
    409,
  );
}
