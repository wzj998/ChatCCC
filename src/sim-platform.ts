/**
 * sim-platform.ts — SimulatedPlatform: 零飞书依赖的本地模拟实现
 *
 * 所有飞书 API 调用都由本地逻辑替代：
 * - 消息写入本地 JSONL（~/.chatccc/sim/messages.jsonl）
 * - 群聊信息存在内存 Map 中
 * - createGroupChat 生成 "sim_<uuid>" 格式的 chat_id
 *
 * 纯函数（extractSessionInfo / formatDelayNotice / reportPermissionResults）
 * 直接从 feishu-api.ts re-export，不重新实现。
 */

import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  extractSessionInfo as realExtractSessionInfo,
  extractSessionId as realExtractSessionId,
  formatDelayNotice as realFormatDelayNotice,
  reportPermissionResults as realReportPermissionResults,
} from "./feishu-api.ts";
import type { FeishuPlatform } from "./feishu-platform.ts";

// ---------------------------------------------------------------------------
// 持久化路径
// ---------------------------------------------------------------------------

const SIM_DIR = join(homedir(), ".chatccc", "sim");
const MESSAGES_FILE = join(SIM_DIR, "messages.jsonl");

// ---------------------------------------------------------------------------
// 内存状态
// ---------------------------------------------------------------------------

interface SimChat {
  name: string;
  description: string;
  members: string[];
}

const chats = new Map<string, SimChat>();

// 默认模拟群：用户注入消息时如果不指定 chat_id，就用这个
const DEFAULT_CHAT_ID = "sim_default";
chats.set(DEFAULT_CHAT_ID, {
  name: "默认模拟会话",
  description: "",
  members: ["sim_user_001"],
});

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function ts(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

async function appendJsonl(line: Record<string, unknown>): Promise<void> {
  await mkdir(SIM_DIR, { recursive: true });
  await appendFile(MESSAGES_FILE, JSON.stringify(line) + "\n", "utf-8");
}

/** 模拟 user_id 转 open_id 的映射 */
function resolveOpenId(userIds: string[]): string {
  return userIds[0] ?? "sim_user_001";
}

// ---------------------------------------------------------------------------
// SimulatedPlatform
// ---------------------------------------------------------------------------

export const SimulatedPlatform: FeishuPlatform = {
  // ---- 认证 ----
  async getTenantAccessToken() {
    return "sim_token";
  },

  // ---- 消息发送：全部写本地 JSONL ----
  async sendTextReply(_token, chatId, text) {
    console.log(`[${ts()}] [SIM:SEND] text → ${chatId}: ${text.slice(0, 80)}`);
    await appendJsonl({
      direction: "send",
      chat_id: chatId,
      msg_type: "text",
      content: text,
      timestamp: Date.now(),
    });
    return true;
  },

  async sendCardReply(_token, chatId, title, content, _template) {
    console.log(`[${ts()}] [SIM:SEND] card → ${chatId}: [${title}]`);
    const text = `**[${title}]**\n${content}`;
    await appendJsonl({
      direction: "send",
      chat_id: chatId,
      msg_type: "card",
      header: title,
      content: content,
      timestamp: Date.now(),
    });
    return true;
  },

  async sendImageReply(_token, chatId, imagePath) {
    console.log(`[${ts()}] [SIM:SEND] image → ${chatId}: ${imagePath}`);
    await appendJsonl({
      direction: "send",
      chat_id: chatId,
      msg_type: "image",
      image_path: imagePath,
      timestamp: Date.now(),
    });
    return true;
  },

  async sendFileReply(_token, chatId, filePath) {
    console.log(`[${ts()}] [SIM:SEND] file → ${chatId}: ${filePath}`);
    await appendJsonl({
      direction: "send",
      chat_id: chatId,
      msg_type: "file",
      file_path: filePath,
      timestamp: Date.now(),
    });
    return true;
  },

  async sendRawCard(_token, chatId, cardJson) {
    console.log(`[${ts()}] [SIM:SEND] raw_card → ${chatId}: ${cardJson.slice(0, 80)}...`);
    await appendJsonl({
      direction: "send",
      chat_id: chatId,
      msg_type: "raw_card",
      card_json_preview: cardJson.slice(0, 500),
      timestamp: Date.now(),
    });
    return true;
  },

  // ---- 消息管理 ----
  async addReaction(_token, _messageId, _emojiType) {
    // 模拟模式不需要表情回应
  },

  async recallMessage(_token, _messageId) {
    return true; // 假装撤回成功
  },

  async updateCardMessage(_token, _messageId, content) {
    // 模拟模式：写更新记录到 JSONL
    await appendJsonl({
      type: "card_update",
      message_id: _messageId,
      content_preview: content.slice(0, 200),
      timestamp: Date.now(),
    });
    return true;
  },

  // ---- 群聊管理 ----
  async createGroupChat(_token, name, userIds) {
    const chatId = `sim_${randomUUID().slice(0, 8)}`;
    chats.set(chatId, { name, description: "Creating...", members: userIds });
    console.log(`[${ts()}] [SIM:CHAT] created: ${chatId} name="${name}" members=${userIds.length}`);
    return chatId;
  },

  async updateChatInfo(_token, chatId, name, description) {
    const existing = chats.get(chatId);
    if (existing) {
      existing.name = name;
      existing.description = description;
    } else {
      chats.set(chatId, { name, description, members: ["sim_user_001"] });
    }
    console.log(`[${ts()}] [SIM:CHAT] updated: ${chatId} name="${name}"`);
  },

  async getChatInfo(_token, chatId) {
    const chat = chats.get(chatId);
    if (!chat) throw new Error(`[99999] chat not found: ${chatId}`);
    return { name: chat.name, description: chat.description };
  },

  // ---- 头像 ----
  async setChatAvatar(_token, _chatId, _tool, _status) {
    // 模拟模式不需要头像
  },

  // ---- 图片下载 ----
  async getOrDownloadImage(_token, _messageId, fileKey) {
    // 模拟模式下图片不需要从飞书下载，返回占位路径
    return join(SIM_DIR, "images", fileKey);
  },

  // ---- 权限验证 ----
  async verifyAllPermissions(_token) {
    return [
      { scope: "im:chat", description: "模拟", ok: true, detail: "模拟模式跳过" },
      { scope: "im:message:send_as_bot", description: "模拟", ok: true, detail: "模拟模式跳过" },
      { scope: "im:message:reaction", description: "模拟", ok: true, detail: "模拟模式跳过" },
      { scope: "im:message", description: "模拟", ok: true, detail: "模拟模式跳过" },
      { scope: "cardkit:card", description: "模拟", ok: true, detail: "模拟模式跳过" },
    ];
  },

  // ---- 纯函数：直接从真实实现 re-export ----
  extractSessionInfo: realExtractSessionInfo,
  extractSessionId: realExtractSessionId,
  formatDelayNotice: realFormatDelayNotice,
  reportPermissionResults: realReportPermissionResults,

  // ---- 其他 ----
  async sendRestartCard(_token) {
    // 模拟模式不需要重启通知
  },
};

/** 模拟模式下的默认 chat_id */
export const SIM_DEFAULT_CHAT_ID = DEFAULT_CHAT_ID;