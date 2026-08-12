import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BoardService } from "../agent-team/application/board-service.ts";
import { BOARD_COLUMNS } from "../agent-team/domain/board.ts";
import { JsonBoardRepository } from "../agent-team/repositories/json-board-repository.ts";

describe("Agent Team local board", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "chatccc-agent-team-"));
    tempRoots.push(root);
    const workspaceA = join(root, "workspace-a");
    const workspaceB = join(root, "workspace-b");
    await mkdir(workspaceA);
    await mkdir(workspaceB);
    const storage = join(root, "storage");
    const repository = new JsonBoardRepository({ rootDir: storage });
    return { root, workspaceA, workspaceB, storage, repository, service: new BoardService(repository) };
  }

  it("creates one persistent five-column board per working directory", async () => {
    const { workspaceA, workspaceB, storage, repository, service } = await fixture();

    const first = await service.openWorkspace(workspaceA);
    const reopened = await service.openWorkspace(workspaceA);
    const second = await service.openWorkspace(workspaceB);

    expect(first.boardId).toBe(reopened.boardId);
    expect(second.boardId).not.toBe(first.boardId);
    expect(first.columns).toEqual(BOARD_COLUMNS);
    expect(first.revision).toBe(0);
    expect(first.primaryAgentId).toBeUndefined();

    const persisted = JSON.parse(await readFile(join(storage, "boards", `${first.boardId}.json`), "utf8"));
    expect(persisted.workspacePath).toBe(first.workspacePath);
    expect(persisted.schemaVersion).toBe(1);

    const reloadedRepository = new JsonBoardRepository({ rootDir: storage });
    expect((await reloadedRepository.openWorkspace(workspaceA)).boardId).toBe(first.boardId);
  });

  it("checks whether a workspace already has a board without creating one", async () => {
    const { workspaceA, service } = await fixture();

    expect(await service.findWorkspace(workspaceA)).toBeNull();
    expect(await service.listWorkspaces()).toEqual([]);

    const created = await service.openWorkspace(workspaceA);
    expect((await service.findWorkspace(workspaceA))?.boardId).toBe(created.boardId);
    expect(await service.listWorkspaces()).toHaveLength(1);
  });

  it("persists a supported primary Agent with revision checks", async () => {
    const { workspaceA, service } = await fixture();
    const board = await service.openWorkspace(workspaceA);

    const updated = await service.setPrimaryAgent(board.boardId, "codex", board.revision);
    expect(updated.primaryAgentId).toBe("codex");
    expect(updated.revision).toBe(board.revision + 1);

    await expect(service.setPrimaryAgent(board.boardId, "claude", board.revision))
      .rejects.toMatchObject({ code: "revision_conflict" });
  });

  it("creates, edits, moves, orders and soft-deletes tasks with revision checks", async () => {
    const { workspaceA, service } = await fixture();
    let board = await service.openWorkspace(workspaceA);

    board = await service.createTask(board.boardId, {
      expectedRevision: board.revision,
      title: "Explore sync semantics",
      description: "Compare local and Bitable revisions",
      columnId: "brainstorm",
    });
    const firstTaskId = board.tasks[0].id;
    expect(board.revision).toBe(1);

    board = await service.createTask(board.boardId, {
      expectedRevision: board.revision,
      title: "Build board",
      description: "",
      columnId: "todo",
    });
    const secondTaskId = board.tasks.find((task) => task.title === "Build board")!.id;

    board = await service.updateTask(board.boardId, secondTaskId, {
      expectedRevision: board.revision,
      title: "Build local board",
      description: "JSON first",
    });
    board = await service.moveTask(board.boardId, secondTaskId, {
      expectedRevision: board.revision,
      columnId: "doing",
      index: 0,
    });
    expect(board.tasks.find((task) => task.id === secondTaskId)).toMatchObject({
      title: "Build local board",
      description: "JSON first",
      columnId: "doing",
      order: 1000,
    });

    const staleRevision = board.revision - 1;
    await expect(service.deleteTask(board.boardId, firstTaskId, { expectedRevision: staleRevision }))
      .rejects.toMatchObject({ code: "revision_conflict" });

    board = await service.deleteTask(board.boardId, firstTaskId, { expectedRevision: board.revision });
    expect(board.tasks.find((task) => task.id === firstTaskId)?.deletedAt).toEqual(expect.any(String));
    expect(board.tasks.filter((task) => !task.deletedAt)).toHaveLength(1);
  });

  it("lists recent workspaces and can relink a board after a directory moves", async () => {
    const { root, workspaceA, service } = await fixture();
    const board = await service.openWorkspace(workspaceA);
    const moved = join(root, "workspace-moved");
    await mkdir(moved);

    const relinked = await service.relinkWorkspace(board.boardId, moved, board.revision);
    expect(relinked.boardId).toBe(board.boardId);
    expect(relinked.workspacePath).toBe(moved);

    const recent = await service.listWorkspaces();
    expect(recent[0]).toMatchObject({ boardId: board.boardId, workspacePath: moved, exists: true });
  });
});
