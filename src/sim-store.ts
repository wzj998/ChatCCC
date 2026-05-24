/**
 * sim-store.ts — 模拟飞书环境的状态管理核心
 *
 * SimStore 是一个单例的 EventEmitter，管理所有模拟状态：
 * - 账户（bot + 多个用户）
 * - 会话（群聊 + 私聊）
 * - 消息历史（内存 + JSONL 持久化）
 *
 * 同时暴露 setMessageHandler / dispatchMessage，让 SimAgent 进程内触发
 * handleCommand 而无需通过 HTTP。
 */

import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

export interface SimAccount {
  id: string;               // "bot" | "sim_user_001" | "alice"
  kind: "bot" | "user";
  name: string;
}

export interface SimMessage {
  id: string;               // UUID
  chatId: string;
  senderId: string;         // SimAccount.id
  type: "text" | "card" | "image" | "file" | "raw_card" | "post" | "system";
  content: string;          // 文本内容或 JSON 字符串
  timestamp: number;
}

export interface SimChat {
  id: string;               // "sim_default" | "sim_<uuid8>" | "p2p_alice_bot"
  type: "group" | "p2p";
  name: string;
  description: string;
  memberIds: string[];      // 所有成员，第一个是创建者
  messages: SimMessage[];   // 消息历史（按时间排序）
}

/** handleCommand 的回调签名 */
export type MessageHandler = (
  text: string,
  chatId: string,
  openId: string,
  timestamp: number,
  chatType: string,
  traceId?: string,
) => Promise<void>;

// ---------------------------------------------------------------------------
// 持久化路径
// ---------------------------------------------------------------------------

const SIM_DIR = join(homedir(), ".chatccc", "sim");
const MESSAGES_FILE = join(SIM_DIR, "messages.jsonl");

async function ensureDir(): Promise<void> {
  await mkdir(SIM_DIR, { recursive: true });
}

async function appendJsonl(line: Record<string, unknown>): Promise<void> {
  await ensureDir();
  await appendFile(MESSAGES_FILE, JSON.stringify(line) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// SimStore
// ---------------------------------------------------------------------------

export class SimStore extends EventEmitter {
  accounts = new Map<string, SimAccount>();
  chats = new Map<string, SimChat>();

  // ---- 初始化 ----

  constructor() {
    super();
    this._initDefaults();
  }

  private _initDefaults(): void {
    // 注册 bot 账户
    this.accounts.set("bot", { id: "bot", kind: "bot", name: "ChatCCC" });

    // 注册默认用户
    this.accounts.set("sim_user_001", { id: "sim_user_001", kind: "user", name: "Developer" });

    // 创建默认群聊
    const defaultChatId = "sim_default";
    this.chats.set(defaultChatId, {
      id: defaultChatId,
      type: "group",
      name: "默认模拟会话",
      description: "",
      memberIds: ["bot", "sim_user_001"],
      messages: [],
    });
  }

  // ---- 账户管理 ----

  registerAccount(account: SimAccount): void {
    if (this.accounts.has(account.id)) {
      throw new Error(`Account "${account.id}" already exists`);
    }
    this.accounts.set(account.id, account);
  }

  getAccount(id: string): SimAccount | undefined {
    return this.accounts.get(id);
  }

  // ---- 会话管理 ----

  createGroupChat(name: string, memberIds: string[]): SimChat {
    const chatId = `sim_${randomUUID().slice(0, 8)}`;
    // bot 始终是成员
    const allMembers = ["bot", ...memberIds.filter((id) => id !== "bot")];
    const chat: SimChat = {
      id: chatId,
      type: "group",
      name,
      description: "",
      memberIds: allMembers,
      messages: [],
    };
    this.chats.set(chatId, chat);

    // 通知被拉入群的用户
    for (const uid of memberIds) {
      this.emit("member_added", { chatId, userId: uid });
    }
    this.emit("chat_created", { chat });

    return chat;
  }

  createP2pChat(userId: string): SimChat {
    // p2p 命名规则：p2p_<userId>_bot
    const chatId = `p2p_${userId}_bot`;
    const existing = this.chats.get(chatId);
    if (existing) return existing;

    const user = this.accounts.get(userId);
    const chat: SimChat = {
      id: chatId,
      type: "p2p",
      name: user ? `${user.name} 的私聊` : `私聊`,
      description: "",
      memberIds: ["bot", userId],
      messages: [],
    };
    this.chats.set(chatId, chat);
    this.emit("chat_created", { chat });
    return chat;
  }

  getChat(chatId: string): SimChat | undefined {
    return this.chats.get(chatId);
  }

  getChatsForUser(userId: string): SimChat[] {
    return [...this.chats.values()].filter((c) => c.memberIds.includes(userId));
  }

  addMember(chatId: string, userId: string): void {
    const chat = this.chats.get(chatId);
    if (!chat) throw new Error(`Chat not found: ${chatId}`);
    if (!chat.memberIds.includes(userId)) {
      chat.memberIds.push(userId);
      this.emit("member_added", { chatId, userId });
    }
  }

  updateChatInfo(chatId: string, name: string, description: string): void {
    const chat = this.chats.get(chatId);
    if (chat) {
      chat.name = name;
      chat.description = description;
    } else {
      // 模拟模式下机器人可能尝试更新不存在的群（比如从旧状态恢复），兼容处理
      this.chats.set(chatId, {
        id: chatId,
        type: "group",
        name,
        description,
        memberIds: ["bot", "sim_user_001"],
        messages: [],
      });
    }
  }

  disbandChat(chatId: string): void {
    this.chats.delete(chatId);
  }

  // ---- 消息管理 ----

  /** 任何参与者发送消息 */
  recordMessage(
    chatId: string,
    senderId: string,
    type: SimMessage["type"],
    content: string,
  ): SimMessage {
    const chat = this.chats.get(chatId);
    if (!chat) throw new Error(`Chat not found: ${chatId}`);

    const msg: SimMessage = {
      id: randomUUID(),
      chatId,
      senderId,
      type,
      content,
      timestamp: Date.now(),
    };
    chat.messages.push(msg);

    // 写 JSONL
    appendJsonl({
      direction: senderId === "bot" ? "send" : "recv",
      chat_id: chatId,
      sender_id: senderId,
      msg_type: type,
      content,
      timestamp: msg.timestamp,
    }).catch(() => {});

    // 通知所有订阅者
    this.emit("message", { chatId, message: msg });

    return msg;
  }

  /** bot 发送回复——即使 chat 不存在也记录（兼容未知 chat） */
  sendReply(chatId: string, type: SimMessage["type"], content: string): SimMessage {
    const msg: SimMessage = {
      id: randomUUID(),
      chatId,
      senderId: "bot",
      type,
      content,
      timestamp: Date.now(),
    };

    // 如果 chat 存在，追加到消息历史
    const chat = this.chats.get(chatId);
    if (chat) {
      chat.messages.push(msg);
    }

    // 写 JSONL
    appendJsonl({
      direction: "send",
      chat_id: chatId,
      msg_type: type,
      content,
      timestamp: msg.timestamp,
    }).catch(() => {});

    // 通知订阅者
    this.emit("message", { chatId, message: msg });

    return msg;
  }

  /** 获取指定会话的消息 */
  getMessages(chatId: string, requesterId: string): SimMessage[] {
    const chat = this.chats.get(chatId);
    if (!chat) return [];
    // 只有成员能看消息
    if (!chat.memberIds.includes(requesterId)) return [];
    return chat.messages;
  }

  /** 重置所有状态（测试用） */
  reset(): void {
    this.accounts.clear();
    this.chats.clear();
    this.removeAllListeners();
    this._initDefaults();
  }
}

// ---------------------------------------------------------------------------
// 单例 + 消息分发
// ---------------------------------------------------------------------------

export const simStore = new SimStore();

export const SIM_DEFAULT_CHAT_ID = "sim_default";

let _messageHandler: MessageHandler | null = null;

/** 注册 handleCommand 回调（由 index.ts 在模拟模式启动时调用） */
export function setMessageHandler(handler: MessageHandler): void {
  _messageHandler = handler;
}

/** 模拟用户发送消息 → 记录消息 + 触发 bot 处理 */
export async function dispatchMessage(
  text: string,
  chatId: string,
  openId: string,
  chatType: string,
): Promise<void> {
  if (!_messageHandler) throw new Error("Message handler not registered — is simulate mode running?");
  simStore.recordMessage(chatId, openId, "text", text);
  await _messageHandler(text, chatId, openId, Date.now(), chatType);
}