import type { AgentTool } from "../../agent-tool.ts";
import { isAgentTool } from "../../agent-tool.ts";
import type { PlatformAdapter } from "../../platform-adapter.ts";
import { sessionChatName } from "../../session-name.ts";
import type { Board } from "../domain/board.ts";
import type { FeishuP2pContactStore } from "../repositories/feishu-p2p-contact-store.ts";
import type {
  JsonMainAgentBindingRepository,
  MainAgentBinding,
} from "../repositories/main-agent-binding-repository.ts";
import { BoardStoreError } from "../repositories/board-repository.ts";
import type { BoardService } from "./board-service.ts";

export interface MainAgentBindSessionInput {
  chatId: string;
  oldSessionId: string | null;
  newSessionId: string;
  agentId: AgentTool;
  cwd: string;
  chatName: string;
  namingPolicy: "project-fixed";
}

export interface MainAgentSessionRuntime {
  createSession(agentId: AgentTool, cwd: string): Promise<{ sessionId: string; cwd: string }>;
  isSessionRunning(sessionId: string): boolean;
  bindSession(input: MainAgentBindSessionInput): Promise<void>;
}

export interface MainAgentServiceOptions {
  boardService: BoardService;
  bindingRepository: JsonMainAgentBindingRepository;
  contactStore: FeishuP2pContactStore;
  platform: PlatformAdapter;
  runtime: MainAgentSessionRuntime;
  now?: () => Date;
}

export interface MainAgentProjectResult {
  board: Board;
  binding: MainAgentBinding;
}

export class MainAgentService {
  private readonly now: () => Date;
  private readonly projectOperations = new Map<string, Promise<void>>();

  constructor(private readonly options: MainAgentServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  getContact() {
    return this.options.contactStore.get();
  }

  getBinding(projectId: string) {
    return this.options.bindingRepository.get(projectId);
  }

  setPrimaryAgent(projectId: string, agentId: AgentTool, expectedRevision: number): Promise<MainAgentProjectResult> {
    if (!isAgentTool(agentId)) {
      throw new BoardStoreError("invalid_request", `Unsupported primary Agent: ${String(agentId)}`, 400);
    }
    return this.exclusive(projectId, async () => {
      const board = await this.options.boardService.getBoard(projectId);
      if (board.revision !== expectedRevision) {
        throw new BoardStoreError(
          "revision_conflict",
          `Board changed in another page (expected revision ${expectedRevision}, current ${board.revision})`,
          409,
        );
      }
      return this.provision(board, agentId, false);
    });
  }

  relinkWorkspace(projectId: string, workspacePath: string, expectedRevision: number): Promise<MainAgentProjectResult | { board: Board; binding: null }> {
    return this.exclusive(projectId, async () => {
      const existing = await this.options.bindingRepository.get(projectId);
      const currentSessionId = existing ? (await this.resolveCurrentSession(existing)).sessionId : null;
      if (currentSessionId && this.options.runtime.isSessionRunning(currentSessionId)) {
        throw new BoardStoreError("main_agent_running", "主 Agent 正在执行任务，请先停止后再重新关联目录", 409);
      }
      const board = await this.options.boardService.relinkWorkspace(projectId, workspacePath, expectedRevision);
      if (!existing || !board.primaryAgentId) return { board, binding: null };
      return this.provision(board, board.primaryAgentId, true);
    });
  }

  private async provision(board: Board, agentId: AgentTool, forceNewSession: boolean): Promise<MainAgentProjectResult> {
    const existing = await this.options.bindingRepository.get(board.boardId);
    const currentSession = existing ? await this.resolveCurrentSession(existing) : null;
    const currentSessionId = currentSession?.sessionId ?? null;
    if (currentSessionId && this.options.runtime.isSessionRunning(currentSessionId)) {
      throw new BoardStoreError("main_agent_running", "主 Agent 正在执行任务，请先停止后再切换", 409);
    }

    if (
      !forceNewSession &&
      existing?.status === "ready" &&
      existing.agentId === agentId &&
      currentSession?.agentId === agentId
    ) {
      const savedBoard = board.primaryAgentId === agentId
        ? board
        : await this.options.boardService.setPrimaryAgent(board.boardId, agentId, board.revision);
      return { board: savedBoard, binding: existing };
    }

    const contact = existing?.ownerOpenId
      ? { openId: existing.ownerOpenId }
      : await this.options.contactStore.get();
    if (!contact) {
      throw new BoardStoreError(
        "feishu_dm_required",
        "请先给飞书机器人私聊发送任意消息，再回到网页重试",
        409,
      );
    }

    const chatName = sessionChatName("主Agent", board.workspacePath);
    let binding: MainAgentBinding = {
      schemaVersion: 1,
      projectId: board.boardId,
      platform: "feishu",
      ...(existing?.chatId ? { chatId: existing.chatId } : {}),
      ...(currentSessionId ? { sessionId: currentSessionId } : {}),
      agentId,
      namingPolicy: "project-fixed",
      status: "provisioning",
      ownerOpenId: contact.openId,
      updatedAt: this.now().toISOString(),
    };
    await this.options.bindingRepository.save(binding);

    try {
      const created = await this.options.runtime.createSession(agentId, board.workspacePath);
      let chatId = existing?.chatId;
      if (!chatId) {
        chatId = await this.options.platform.createGroup(chatName, [contact.openId]);
      }
      binding = {
        ...binding,
        chatId,
        sessionId: created.sessionId,
        updatedAt: this.now().toISOString(),
      };
      // Persist irreversible identifiers before the remaining steps so a retry reuses the group.
      await this.options.bindingRepository.save(binding);

      await this.options.runtime.bindSession({
        chatId,
        oldSessionId: currentSessionId,
        newSessionId: created.sessionId,
        agentId,
        cwd: created.cwd,
        chatName,
        namingPolicy: "project-fixed",
      });

      binding = { ...binding, status: "ready", updatedAt: this.now().toISOString() };
      await this.options.bindingRepository.save(binding);
      const savedBoard = board.primaryAgentId === agentId
        ? board
        : await this.options.boardService.setPrimaryAgent(board.boardId, agentId, board.revision);

      await this.options.platform.sendCard(
        chatId,
        "主 Agent 已就绪",
        `项目：**${chatName.slice("主Agent-".length)}**\n\n工作目录：\`${created.cwd}\`\n\n可以直接在本群与主 Agent 对话。`,
        "green",
      ).catch(() => false);
      return { board: savedBoard, binding };
    } catch (err) {
      const failed: MainAgentBinding = {
        ...binding,
        status: "error",
        lastError: (err as Error).message,
        updatedAt: this.now().toISOString(),
      };
      await this.options.bindingRepository.save(failed).catch(() => {});
      throw err;
    }
  }

  private async resolveCurrentSession(binding: MainAgentBinding): Promise<{ sessionId: string | null; agentId: AgentTool }> {
    if (!binding.chatId) return { sessionId: binding.sessionId ?? null, agentId: binding.agentId };
    try {
      const info = await this.options.platform.getChatInfo(binding.chatId);
      const session = this.options.platform.extractSessionInfo(info.description);
      return {
        sessionId: session?.sessionId ?? binding.sessionId ?? null,
        agentId: isAgentTool(session?.tool) ? session.tool : binding.agentId,
      };
    } catch {
      return { sessionId: binding.sessionId ?? null, agentId: binding.agentId };
    }
  }

  private async exclusive<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.projectOperations.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.projectOperations.set(projectId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.projectOperations.get(projectId) === current) this.projectOperations.delete(projectId);
    }
  }
}
