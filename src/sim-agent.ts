/**
 * sim-agent.ts — SimAgent: 模拟飞书用户的编程接口
 *
 * SimAgent 代表一个模拟飞书用户，提供纯代码 API：
 * - sendMessage(): 发送消息给 bot
 * - on("message"): 订阅 bot 和其他人的回复
 * - on("invited_to_group"): 当被拉入群时收到通知
 * - waitForReply(): Promise 模式等待 bot 回复
 * - getMessages(): 查看会话历史消息
 *
 * 不依赖 UI，进程内直接调用，适合用于自动化测试和 Agent 编程。
 */

import { simStore, dispatchMessage, SIM_DEFAULT_CHAT_ID } from "./sim-store.ts";
import type { SimAccount, SimMessage } from "./sim-store.ts";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type MessageEventCallback = (chatId: string, msg: SimMessage) => void;
export type InvitedToGroupCallback = (chatId: string, userId: string) => void;

export interface SimAgent {
  /** 绑定的用户 ID */
  userId: string;

  /** 绑定的账户信息 */
  account: SimAccount;

  /**
   * 发送文本消息。
   * chatId 默认 sim_default；p2p 私聊需指定。
   */
  sendMessage(chatId: string, text: string): Promise<void>;

  /** 创建与 bot 的私聊，返回 p2p chatId */
  createP2pWithBot(): string;

  /** 获取用户在指定会话中的消息历史 */
  getMessages(chatId: string): SimMessage[];

  /** 获取用户所属的所有会话 */
  listChats(): { id: string; name: string; type: "p2p" | "group" }[];

  // ---- 事件订阅 ----
  /** 订阅消息事件（所有该用户所在群的消息） */
  on(event: "message", handler: MessageEventCallback): void;
  /** 订阅被拉入群事件 */
  on(event: "invited_to_group", handler: InvitedToGroupCallback): void;
  /** 取消订阅 */
  off(event: string, handler: (...args: any[]) => void): void;

  // ---- Promise 模式 ----
  /**
   * 等待指定会话的下一条 bot 回复。
   * 超时返回 null（默认 30 秒）。
   */
  waitForReply(chatId: string, timeoutMs?: number): Promise<SimMessage | null>;
}

// ---------------------------------------------------------------------------
// 实现
// ---------------------------------------------------------------------------

export function createSimAgent(userId: string): SimAgent {
  const account = simStore.getAccount(userId);
  if (!account) throw new Error(`Account "${userId}" not found. Register it in simStore first.`);
  if (account.kind !== "user") throw new Error(`Account "${userId}" is not a user account.`);

  // 确保用户有至少一个会话（bot 私聊自动创建）
  simStore.createP2pChat(userId);

  const agent: SimAgent = {
    userId,
    account,

    async sendMessage(chatId, text) {
      const chat = simStore.getChat(chatId);
      if (!chat) throw new Error(`Chat "${chatId}" not found`);
      if (!chat.memberIds.includes(userId)) {
        throw new Error(`User "${userId}" is not a member of chat "${chatId}"`);
      }
      await dispatchMessage(text, chatId, userId, chat.type === "p2p" ? "p2p" : "group");
    },

    createP2pWithBot() {
      const chat = simStore.createP2pChat(userId);
      return chat.id;
    },

    getMessages(chatId) {
      return simStore.getMessages(chatId, userId);
    },

    listChats() {
      return simStore.getChatsForUser(userId).map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
      }));
    },

    on(event, handler) {
      if (event === "message") {
        const filteredHandler = (payload: { chatId: string; message: SimMessage }) => {
          // 只推送给该用户所在群的消息
          const chat = simStore.getChat(payload.chatId);
          if (chat && chat.memberIds.includes(userId)) {
            handler(payload.chatId, payload.message);
          }
        };
        // 保存映射以便 off 能移除
        (handler as any).__filtered = filteredHandler;
        simStore.on("message", filteredHandler);
      } else if (event === "invited_to_group") {
        const filteredHandler = (payload: { chatId: string; userId: string }) => {
          if (payload.userId === userId) {
            handler(payload.chatId, payload.userId);
          }
        };
        (handler as any).__filtered = filteredHandler;
        simStore.on("member_added", filteredHandler);
      }
    },

    off(event, handler) {
      const filtered = (handler as any).__filtered;
      if (event === "message" && filtered) {
        simStore.off("message", filtered);
      } else if (event === "invited_to_group" && filtered) {
        simStore.off("member_added", filtered);
      }
    },

    waitForReply(chatId, timeoutMs = 30000) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          agent.off("message", onMessage);
          resolve(null);
        }, timeoutMs);

        const onMessage = (cid: string, msg: SimMessage) => {
          if (cid === chatId && msg.senderId === "bot") {
            clearTimeout(timer);
            agent.off("message", onMessage);
            resolve(msg);
          }
        };
        agent.on("message", onMessage);
      });
    },
  };

  return agent;
}