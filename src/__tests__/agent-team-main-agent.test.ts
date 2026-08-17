import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BoardService } from "../agent-team/application/board-service.ts";
import {
  MainAgentService,
  type MainAgentSessionRuntime,
} from "../agent-team/application/main-agent-service.ts";
import { FeishuP2pContactStore } from "../agent-team/repositories/feishu-p2p-contact-store.ts";
import { JsonMainAgentBindingRepository } from "../agent-team/repositories/main-agent-binding-repository.ts";
import { JsonBoardRepository } from "../agent-team/repositories/json-board-repository.ts";
import type { PlatformAdapter } from "../platform-adapter.ts";

describe("Agent Team main Agent", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "chatccc-main-agent-"));
    tempRoots.push(root);
    const workspace = join(root, "workspace-a");
    const movedWorkspace = join(root, "workspace-b");
    await mkdir(workspace);
    await mkdir(movedWorkspace);

    const boardService = new BoardService(new JsonBoardRepository({ rootDir: join(root, "boards") }));
    const bindingRepository = new JsonMainAgentBindingRepository({ rootDir: join(root, "bindings") });
    const contactStore = new FeishuP2pContactStore({ filePath: join(root, "last-contact.json") });
    const createGroup = vi.fn(async () => "oc_main_agent");
    const sendCard = vi.fn(async () => true);
    const platform = {
      kind: "feishu",
      createGroup,
      sendCard,
    } as unknown as PlatformAdapter;

    let sessionCounter = 0;
    let runningSessionId: string | null = null;
    const bindSession = vi.fn(async () => undefined);
    const runtime: MainAgentSessionRuntime = {
      createSession: vi.fn(async (_agentId, cwd) => ({ sessionId: `session-${++sessionCounter}`, cwd })),
      isSessionRunning: (sessionId) => sessionId === runningSessionId,
      bindSession,
    };
    const service = new MainAgentService({
      boardService,
      bindingRepository,
      contactStore,
      platform,
      runtime,
    });

    return {
      workspace,
      movedWorkspace,
      boardService,
      bindingRepository,
      contactStore,
      createGroup,
      sendCard,
      runtime,
      bindSession,
      service,
      setRunningSession: (sessionId: string | null) => { runningSessionId = sessionId; },
    };
  }

  it("requires a prior Feishu private message before provisioning", async () => {
    const { workspace, boardService, service, createGroup, runtime } = await fixture();
    const board = await boardService.openWorkspace(workspace);

    await expect(service.setPrimaryAgent(board.boardId, "codex", board.revision))
      .rejects.toMatchObject({ code: "feishu_dm_required", status: 409 });
    expect(createGroup).not.toHaveBeenCalled();
    expect(runtime.createSession).not.toHaveBeenCalled();
  });

  it("creates one fixed-name project group and persists the selected Agent", async () => {
    const { workspace, boardService, bindingRepository, contactStore, service, createGroup, bindSession } = await fixture();
    const board = await boardService.openWorkspace(workspace);
    await contactStore.record({ openId: "ou_owner", chatId: "oc_private", receivedAt: "2026-08-09T10:00:00.000Z" });

    const result = await service.setPrimaryAgent(board.boardId, "codex", board.revision);

    expect(result.board.primaryAgentId).toBe("codex");
    expect(result.binding).toMatchObject({
      projectId: board.boardId,
      platform: "feishu",
      chatId: "oc_main_agent",
      sessionId: "session-1",
      agentId: "codex",
      namingPolicy: "project-fixed",
      status: "ready",
      ownerOpenId: "ou_owner",
    });
    expect(createGroup).toHaveBeenCalledWith("主Agent-workspace-a", ["ou_owner"]);
    expect(bindSession).toHaveBeenCalledWith(expect.objectContaining({
      chatId: "oc_main_agent",
      oldSessionId: null,
      newSessionId: "session-1",
      agentId: "codex",
      cwd: result.board.workspacePath,
      chatName: "主Agent-workspace-a",
      namingPolicy: "project-fixed",
    }));
    expect(await bindingRepository.get(board.boardId)).toEqual(result.binding);

    const repeated = await service.setPrimaryAgent(result.board.boardId, "codex", result.board.revision);
    expect(repeated.binding.sessionId).toBe("session-1");
    expect(createGroup).toHaveBeenCalledTimes(1);
    expect(bindSession).toHaveBeenCalledTimes(1);
  });

  it("uses the latest private-message contact when retrying a failed binding", async () => {
    const { workspace, boardService, bindingRepository, contactStore, service, createGroup } = await fixture();
    const board = await boardService.openWorkspace(workspace);
    await bindingRepository.save({
      schemaVersion: 1,
      projectId: board.boardId,
      platform: "feishu",
      agentId: "codex",
      namingPolicy: "project-fixed",
      status: "error",
      ownerOpenId: "ou-user",
      lastError: "Invalid open_id",
      updatedAt: "2026-08-17T08:54:10.000Z",
    });
    await contactStore.record({
      openId: "ou_newowner123",
      chatId: "oc_newprivate",
      receivedAt: "2026-08-17T09:00:57.731Z",
    });

    const result = await service.setPrimaryAgent(board.boardId, "codex", board.revision);

    expect(createGroup).toHaveBeenCalledWith("主Agent-workspace-a", ["ou_newowner123"]);
    expect(result.binding).toMatchObject({ status: "ready", ownerOpenId: "ou_newowner123" });
  });

  it("reuses the group when switching Agent and rejects switching while the old session runs", async () => {
    const { workspace, boardService, contactStore, service, createGroup, bindSession, setRunningSession } = await fixture();
    let board = await boardService.openWorkspace(workspace);
    await contactStore.record({ openId: "ou_owner", chatId: "oc_private", receivedAt: "2026-08-09T10:00:00.000Z" });
    ({ board } = await service.setPrimaryAgent(board.boardId, "codex", board.revision));

    setRunningSession("session-1");
    await expect(service.setPrimaryAgent(board.boardId, "claude", board.revision))
      .rejects.toMatchObject({ code: "main_agent_running", status: 409 });

    setRunningSession(null);
    const switched = await service.setPrimaryAgent(board.boardId, "claude", board.revision);
    expect(switched.board.primaryAgentId).toBe("claude");
    expect(switched.binding).toMatchObject({ chatId: "oc_main_agent", sessionId: "session-2", agentId: "claude" });
    expect(createGroup).toHaveBeenCalledTimes(1);
    expect(bindSession).toHaveBeenLastCalledWith(expect.objectContaining({
      chatId: "oc_main_agent",
      oldSessionId: "session-1",
      newSessionId: "session-2",
      agentId: "claude",
    }));
  });

  it("keeps the project and group when relinking, then creates a session in the new directory", async () => {
    const { workspace, movedWorkspace, boardService, contactStore, service, createGroup, bindSession } = await fixture();
    let board = await boardService.openWorkspace(workspace);
    await contactStore.record({ openId: "ou_owner", chatId: "oc_private", receivedAt: "2026-08-09T10:00:00.000Z" });
    ({ board } = await service.setPrimaryAgent(board.boardId, "cursor", board.revision));

    const relinked = await service.relinkWorkspace(board.boardId, movedWorkspace, board.revision);

    expect(relinked.board.boardId).toBe(board.boardId);
    expect(relinked.board.workspacePath).toBe(movedWorkspace);
    expect(relinked.board.primaryAgentId).toBe("cursor");
    expect(relinked.binding).toMatchObject({ chatId: "oc_main_agent", sessionId: "session-2", agentId: "cursor" });
    expect(createGroup).toHaveBeenCalledTimes(1);
    expect(bindSession).toHaveBeenLastCalledWith(expect.objectContaining({
      oldSessionId: "session-1",
      newSessionId: "session-2",
      cwd: movedWorkspace,
      chatName: "主Agent-workspace-b",
    }));
  });
});
