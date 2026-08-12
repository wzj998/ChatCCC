import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BoardService } from "../agent-team/application/board-service.ts";
import {
  createAgentTeamRequestHandler,
  type MainAgentRequestService,
} from "../agent-team/http/board-routes.ts";
import { JsonBoardRepository } from "../agent-team/repositories/json-board-repository.ts";

describe("Agent Team board HTTP API", () => {
  const tempRoots: string[] = [];
  const servers: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function fixture(mainAgentFactory?: (service: BoardService) => MainAgentRequestService) {
    const root = await mkdtemp(join(tmpdir(), "chatccc-agent-team-api-"));
    tempRoots.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const service = new BoardService(new JsonBoardRepository({ rootDir: join(root, "storage") }));
    const handler = createAgentTeamRequestHandler({
      service,
      mainAgentService: mainAgentFactory?.(service),
      defaultWorkspace: workspace,
    });
    const server = createServer((req, res) => {
      handler(req, res).then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end();
        }
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, workspace, service };
  }

  it("opens a workspace and performs task CRUD through revisioned JSON endpoints", async () => {
    const { base, workspace } = await fixture();
    const openResponse = await fetch(`${base}/api/agent-team/open`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ workspacePath: workspace }),
    });
    expect(openResponse.status).toBe(200);
    let board = (await openResponse.json()).board;

    const createResponse = await fetch(`${base}/api/agent-team/boards/${board.boardId}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ expectedRevision: board.revision, title: "First task", description: "Details", columnId: "todo" }),
    });
    expect(createResponse.status).toBe(200);
    board = (await createResponse.json()).board;
    const taskId = board.tasks[0].id;

    const moveResponse = await fetch(`${base}/api/agent-team/boards/${board.boardId}/tasks/${taskId}/move`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ expectedRevision: board.revision, columnId: "doing", index: 0 }),
    });
    expect(moveResponse.status).toBe(200);
    board = (await moveResponse.json()).board;
    expect(board.tasks[0].columnId).toBe("doing");

    const staleDelete = await fetch(`${base}/api/agent-team/boards/${board.boardId}/tasks/${taskId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ expectedRevision: 0 }),
    });
    expect(staleDelete.status).toBe(409);
    expect((await staleDelete.json()).code).toBe("revision_conflict");
  });

  it("returns recent workspaces and exposes the Node-backed directory browser", async () => {
    const { base, workspace } = await fixture();
    const list = await fetch(`${base}/api/agent-team/workspaces`).then((response) => response.json());
    expect(list.defaultWorkspace).toBe(workspace);

    const locations = await fetch(`${base}/api/agent-team/filesystem/locations`).then((response) => response.json());
    expect(locations.locations).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: workspace, label: "当前工作目录" }),
    ]));

    const listing = await fetch(`${base}/api/agent-team/filesystem/directories`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ path: workspace, showHidden: false }),
    }).then((response) => response.json());
    expect(listing.directory.path).toBe(workspace);

    const validated = await fetch(`${base}/api/agent-team/filesystem/validate-directory`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ path: workspace }),
    }).then((response) => response.json());
    expect(validated).toEqual({ ok: true, path: workspace });
  });

  it("looks up a workspace without creating its board", async () => {
    const { base, workspace } = await fixture();
    const lookup = await fetch(`${base}/api/agent-team/lookup`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ workspacePath: workspace }),
    }).then((response) => response.json());

    expect(lookup).toEqual({ ok: true, exists: false });
    expect((await fetch(`${base}/api/agent-team/workspaces`).then((response) => response.json())).workspaces).toEqual([]);

    const opened = await fetch(`${base}/api/agent-team/open`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ workspacePath: workspace }),
    }).then((response) => response.json());
    const existing = await fetch(`${base}/api/agent-team/lookup`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ workspacePath: workspace }),
    }).then((response) => response.json());

    expect(existing).toEqual({ ok: true, exists: true, boardId: opened.board.boardId });
  });

  it("exposes the Feishu contact and provisions a main Agent through the project endpoint", async () => {
    let binding: Record<string, unknown> | null = null;
    const { base, workspace } = await fixture((service) => ({
      getContact: async () => ({ openId: "ou_owner", chatId: "oc_private", receivedAt: "2026-08-09T10:00:00.000Z" }),
      getBinding: async () => binding as never,
      setPrimaryAgent: async (boardId, agentId, expectedRevision) => {
        const board = await service.setPrimaryAgent(boardId, agentId, expectedRevision);
        binding = { projectId: boardId, chatId: "oc_main", sessionId: "session-main", agentId, status: "ready" };
        return { board, binding: binding as never };
      },
      relinkWorkspace: async () => { throw new Error("not used"); },
    }));

    const contact = await fetch(`${base}/api/agent-team/feishu-contact`).then((response) => response.json());
    expect(contact.contact.openId).toBe("ou_owner");

    const opened = await fetch(`${base}/api/agent-team/open`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ workspacePath: workspace }),
    }).then((response) => response.json());
    const response = await fetch(`${base}/api/agent-team/boards/${opened.board.boardId}/main-agent`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ expectedRevision: opened.board.revision, agentId: "codex" }),
    });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.board.primaryAgentId).toBe("codex");
    expect(result.binding).toMatchObject({ chatId: "oc_main", status: "ready" });
  });
});
