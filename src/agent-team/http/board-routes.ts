import type { IncomingMessage, ServerResponse } from "node:http";

import { AGENT_TOOL_OPTIONS, isAgentTool } from "../../agent-tool.ts";
import { readUtf8JsonBody } from "../../agent-rpc-body.ts";
import { BoardService } from "../application/board-service.ts";
import type { MainAgentService } from "../application/main-agent-service.ts";
import type { TaskExecutionService } from "../application/task-execution-service.ts";
import { NodeFilesystemBrowser, type FilesystemBrowser } from "../infrastructure/filesystem-browser.ts";
import { JsonBoardRepository } from "../repositories/json-board-repository.ts";
import { BoardStoreError } from "../repositories/board-repository.ts";

const API_PREFIX = "/api/agent-team";
const MAX_REQUEST_BYTES = 256 * 1024;

export interface AgentTeamRequestHandlerOptions {
  service: BoardService;
  mainAgentService?: MainAgentRequestService | (() => MainAgentRequestService | null);
  taskExecutionService?: TaskExecutionRequestService | (() => TaskExecutionRequestService | null);
  defaultWorkspace?: string;
  filesystemBrowser?: FilesystemBrowser;
}

export type MainAgentRequestService = Pick<
  MainAgentService,
  "getContact" | "getBinding" | "setPrimaryAgent" | "relinkWorkspace"
>;

export type TaskExecutionRequestService = Pick<
  TaskExecutionService,
  "listRuns" | "startTask" | "stopRun"
>;

export function createAgentTeamRequestHandler(options: AgentTeamRequestHandlerOptions) {
  const defaultWorkspace = options.defaultWorkspace ?? process.cwd();
  const filesystemBrowser = options.filesystemBrowser ?? new NodeFilesystemBrowser({ defaultDirectory: defaultWorkspace });
  const mainAgentService = (): MainAgentRequestService | null => {
    if (typeof options.mainAgentService === "function") return options.mainAgentService();
    return options.mainAgentService ?? null;
  };
  const taskExecutionService = (): TaskExecutionRequestService | null => {
    if (typeof options.taskExecutionService === "function") return options.taskExecutionService();
    return options.taskExecutionService ?? null;
  };

  return async function handleAgentTeamRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;
    const method = req.method ?? "GET";
    if (pathname !== API_PREFIX && !pathname.startsWith(`${API_PREFIX}/`)) return false;

    try {
      if (pathname === `${API_PREFIX}/workspaces` && method === "GET") {
        jsonReply(res, 200, {
          ok: true,
          defaultWorkspace,
          agentOptions: AGENT_TOOL_OPTIONS,
          workspaces: await options.service.listWorkspaces(),
        });
        return true;
      }

      if (pathname === `${API_PREFIX}/filesystem/locations` && method === "GET") {
        jsonReply(res, 200, { ok: true, locations: await filesystemBrowser.listLocations() });
        return true;
      }

      if (pathname === `${API_PREFIX}/filesystem/directories` && method === "POST") {
        const body = await bodyJson<{ path?: unknown; showHidden?: unknown }>(req);
        const directory = await filesystemBrowser.listDirectories(
          stringField(body.path, "path"),
          optionalBooleanField(body.showHidden, "showHidden"),
        );
        jsonReply(res, 200, { ok: true, directory });
        return true;
      }

      if (pathname === `${API_PREFIX}/filesystem/validate-directory` && method === "POST") {
        const body = await bodyJson<{ path?: unknown }>(req);
        jsonReply(res, 200, { ok: true, path: await filesystemBrowser.validateDirectory(stringField(body.path, "path")) });
        return true;
      }

      if (pathname === `${API_PREFIX}/lookup` && method === "POST") {
        const body = await bodyJson<{ workspacePath?: unknown }>(req);
        const board = await options.service.findWorkspace(stringField(body.workspacePath, "workspacePath"));
        jsonReply(res, 200, board
          ? { ok: true, exists: true, boardId: board.boardId }
          : { ok: true, exists: false });
        return true;
      }

      if (pathname === `${API_PREFIX}/open` && method === "POST") {
        const body = await bodyJson<{ workspacePath?: unknown }>(req);
        const board = await options.service.openWorkspace(stringField(body.workspacePath, "workspacePath"));
        jsonReply(res, 200, { ok: true, board, binding: await mainAgentService()?.getBinding(board.boardId) ?? null });
        return true;
      }

      if (pathname === `${API_PREFIX}/feishu-contact` && method === "GET") {
        const manager = requireMainAgentService(mainAgentService());
        jsonReply(res, 200, { ok: true, contact: await manager.getContact() });
        return true;
      }

      const boardMatch = pathname.match(/^\/api\/agent-team\/boards\/([^/]+)$/);
      if (boardMatch && method === "GET") {
        const boardId = decodeURIComponent(boardMatch[1]);
        jsonReply(res, 200, {
          ok: true,
          board: await options.service.getBoard(boardId),
          binding: await mainAgentService()?.getBinding(boardId) ?? null,
        });
        return true;
      }

      const relinkMatch = pathname.match(/^\/api\/agent-team\/boards\/([^/]+)\/relink$/);
      if (relinkMatch && method === "POST") {
        const body = await bodyJson<{ workspacePath?: unknown; expectedRevision?: unknown }>(req);
        const boardId = decodeURIComponent(relinkMatch[1]);
        const workspacePath = stringField(body.workspacePath, "workspacePath");
        const revision = revisionField(body.expectedRevision);
        const manager = mainAgentService();
        const result = manager
          ? await manager.relinkWorkspace(boardId, workspacePath, revision)
          : { board: await options.service.relinkWorkspace(boardId, workspacePath, revision), binding: null };
        jsonReply(res, 200, { ok: true, ...result });
        return true;
      }

      const mainAgentMatch = pathname.match(/^\/api\/agent-team\/boards\/([^/]+)\/main-agent$/);
      if (mainAgentMatch && method === "POST") {
        const body = await bodyJson<{ agentId?: unknown; expectedRevision?: unknown }>(req);
        if (!isAgentTool(body.agentId)) {
          throw new BoardStoreError("invalid_request", `Unsupported primary Agent: ${String(body.agentId)}`, 400);
        }
        const result = await requireMainAgentService(mainAgentService()).setPrimaryAgent(
          decodeURIComponent(mainAgentMatch[1]),
          body.agentId,
          revisionField(body.expectedRevision),
        );
        jsonReply(res, 200, { ok: true, ...result });
        return true;
      }

      const runsMatch = pathname.match(/^\/api\/agent-team\/boards\/([^/]+)\/runs$/);
      if (runsMatch && method === "GET") {
        const runs = await requireTaskExecutionService(taskExecutionService())
          .listRuns(decodeURIComponent(runsMatch[1]));
        jsonReply(res, 200, { ok: true, runs });
        return true;
      }

      const runTaskMatch = pathname.match(/^\/api\/agent-team\/boards\/([^/]+)\/tasks\/([^/]+)\/run$/);
      if (runTaskMatch && method === "POST") {
        const body = await bodyJson<Record<string, unknown>>(req);
        const result = await requireTaskExecutionService(taskExecutionService()).startTask(
          decodeURIComponent(runTaskMatch[1]),
          decodeURIComponent(runTaskMatch[2]),
          revisionField(body.expectedRevision),
        );
        jsonReply(res, 202, { ok: true, ...result });
        return true;
      }

      const stopRunMatch = pathname.match(/^\/api\/agent-team\/boards\/([^/]+)\/runs\/([^/]+)\/stop$/);
      if (stopRunMatch && method === "POST") {
        const run = await requireTaskExecutionService(taskExecutionService()).stopRun(
          decodeURIComponent(stopRunMatch[1]),
          decodeURIComponent(stopRunMatch[2]),
        );
        jsonReply(res, 200, { ok: true, run });
        return true;
      }

      const tasksMatch = pathname.match(/^\/api\/agent-team\/boards\/([^/]+)\/tasks$/);
      if (tasksMatch && method === "POST") {
        const body = await bodyJson<Record<string, unknown>>(req);
        const board = await options.service.createTask(decodeURIComponent(tasksMatch[1]), {
          expectedRevision: revisionField(body.expectedRevision),
          title: stringField(body.title, "title"),
          description: optionalString(body.description, "description"),
          columnId: body.columnId as never,
        });
        jsonReply(res, 200, { ok: true, board });
        return true;
      }

      const moveMatch = pathname.match(/^\/api\/agent-team\/boards\/([^/]+)\/tasks\/([^/]+)\/move$/);
      if (moveMatch && method === "POST") {
        const body = await bodyJson<Record<string, unknown>>(req);
        const board = await options.service.moveTask(decodeURIComponent(moveMatch[1]), decodeURIComponent(moveMatch[2]), {
          expectedRevision: revisionField(body.expectedRevision),
          columnId: body.columnId as never,
          index: integerField(body.index, "index"),
        });
        jsonReply(res, 200, { ok: true, board });
        return true;
      }

      const taskMatch = pathname.match(/^\/api\/agent-team\/boards\/([^/]+)\/tasks\/([^/]+)$/);
      if (taskMatch && method === "PATCH") {
        const body = await bodyJson<Record<string, unknown>>(req);
        const board = await options.service.updateTask(decodeURIComponent(taskMatch[1]), decodeURIComponent(taskMatch[2]), {
          expectedRevision: revisionField(body.expectedRevision),
          title: stringField(body.title, "title"),
          description: optionalString(body.description, "description"),
        });
        jsonReply(res, 200, { ok: true, board });
        return true;
      }
      if (taskMatch && method === "DELETE") {
        const body = await bodyJson<Record<string, unknown>>(req);
        const board = await options.service.deleteTask(decodeURIComponent(taskMatch[1]), decodeURIComponent(taskMatch[2]), {
          expectedRevision: revisionField(body.expectedRevision),
        });
        jsonReply(res, 200, { ok: true, board });
        return true;
      }

      jsonReply(res, 404, { ok: false, code: "not_found", error: "Agent Team API route not found" });
      return true;
    } catch (err) {
      const error = normalizeError(err);
      jsonReply(res, error.status, { ok: false, code: error.code, error: error.message });
      return true;
    }
  };
}

export const defaultAgentTeamBoardService = new BoardService(new JsonBoardRepository());
let defaultMainAgentService: MainAgentRequestService | null = null;
let defaultTaskExecutionService: TaskExecutionRequestService | null = null;
export const handleAgentTeamRequest = createAgentTeamRequestHandler({
  service: defaultAgentTeamBoardService,
  mainAgentService: () => defaultMainAgentService,
  taskExecutionService: () => defaultTaskExecutionService,
});

export function setDefaultAgentTeamMainAgentService(service: MainAgentRequestService | null): void {
  defaultMainAgentService = service;
}

export function setDefaultAgentTeamTaskExecutionService(service: TaskExecutionRequestService | null): void {
  defaultTaskExecutionService = service;
}

function requireMainAgentService(service: MainAgentRequestService | null): MainAgentRequestService {
  if (!service) {
    throw new BoardStoreError("main_agent_unavailable", "飞书主 Agent 服务尚未启动", 503);
  }
  return service;
}

function requireTaskExecutionService(service: TaskExecutionRequestService | null): TaskExecutionRequestService {
  if (!service) {
    throw new BoardStoreError("main_agent_unavailable", "主 Agent 任务执行服务尚未启动", 503);
  }
  return service;
}

async function bodyJson<T>(req: IncomingMessage): Promise<T> {
  try {
    return await readUtf8JsonBody<T>(req, MAX_REQUEST_BYTES);
  } catch (err) {
    throw new BoardStoreError("invalid_request", `Invalid request body: ${(err as Error).message}`, 400);
  }
}

function jsonReply(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

function normalizeError(err: unknown): BoardStoreError {
  if (err instanceof BoardStoreError) return err;
  return new BoardStoreError("storage_error", err instanceof Error ? err.message : String(err), 500);
}

function stringField(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new BoardStoreError("invalid_request", `${name} must be a non-empty string`, 400);
  return value;
}

function optionalString(value: unknown, name: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new BoardStoreError("invalid_request", `${name} must be a string`, 400);
  return value;
}

function optionalBooleanField(value: unknown, name: string): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") throw new BoardStoreError("invalid_request", `${name} must be a boolean`, 400);
  return value;
}

function integerField(value: unknown, name: string): number {
  if (!Number.isInteger(value)) throw new BoardStoreError("invalid_request", `${name} must be an integer`, 400);
  return value as number;
}

function revisionField(value: unknown): number {
  const revision = integerField(value, "expectedRevision");
  if (revision < 0) throw new BoardStoreError("invalid_request", "expectedRevision must be non-negative", 400);
  return revision;
}
