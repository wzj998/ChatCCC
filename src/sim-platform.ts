/**
 * sim-platform.ts — SimulatedPlatform: 零飞书依赖的本地模拟实现
 *
 * 所有飞书 API 调用都由本地 SimStore 替代：
 * - 消息通过 SimStore 写入内存 + JSONL + 事件推送
 * - 群聊/账户信息由 SimStore 统一管理
 * - createGroupChat 生成 "sim_<uuid>" 格式的 chat_id
 *
 * 纯函数（extractSessionInfo / formatDelayNotice / reportPermissionResults）
 * 直接从 feishu-api.ts re-export，不重新实现。
 */

import { join } from "node:path";

import {
  extractSessionInfo as realExtractSessionInfo,
  extractSessionId as realExtractSessionId,
  formatDelayNotice as realFormatDelayNotice,
  reportPermissionResults as realReportPermissionResults,
} from "./feishu-api.ts";
import type { FeishuPlatform } from "./feishu-platform.ts";
import { simStore } from "./sim-store.ts";

// ---------------------------------------------------------------------------
// 持久化路径
// ---------------------------------------------------------------------------

import { homedir } from "node:os";
const SIM_DIR = join(homedir(), ".chatccc", "sim");

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function ts(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

// ---------------------------------------------------------------------------
// SimulatedPlatform
// ---------------------------------------------------------------------------

export const SimulatedPlatform: FeishuPlatform = {
  // ---- 认证 ----
  async getTenantAccessToken() {
    return "sim_token";
  },

  // ---- 消息发送：委托给 simStore ----
  async sendTextReply(_token, chatId, text) {
    console.log(`[${ts()}] [SIM:SEND] text → ${chatId}: ${text.slice(0, 80)}`);
    simStore.sendReply(chatId, "text", text);
    return true;
  },

  async sendCardReply(_token, chatId, title, content, _template) {
    console.log(`[${ts()}] [SIM:SEND] card → ${chatId}: [${title}]`);
    const text = `**[${title}]**\n${content}`;
    simStore.sendReply(chatId, "card", text);
    return true;
  },

  async sendImageReply(_token, chatId, imagePath) {
    console.log(`[${ts()}] [SIM:SEND] image → ${chatId}: ${imagePath}`);
    simStore.sendReply(chatId, "image", imagePath);
    return true;
  },

  async sendFileReply(_token, chatId, filePath) {
    console.log(`[${ts()}] [SIM:SEND] file → ${chatId}: ${filePath}`);
    simStore.sendReply(chatId, "file", filePath);
    return true;
  },

  async sendRawCard(_token, chatId, cardJson) {
    console.log(`[${ts()}] [SIM:SEND] raw_card → ${chatId}: ${cardJson.slice(0, 80)}...`);
    simStore.sendReply(chatId, "raw_card", cardJson.slice(0, 500));
    return true;
  },

  async sendPostMessage(_token, chatId, title, postContent) {
    console.log(`[${ts()}] [SIM:SEND] post → ${chatId}: title="${title}" paragraphs=${postContent.length}`);
    simStore.sendReply(chatId, "post", `[${title}] ${postContent.length} paragraphs`);
    return true;
  },

  // ---- 消息管理 ----
  async addReaction(_token, _messageId, _emojiType) {
    // 模拟模式不需要表情回应
  },

  async recallMessage(_token, _messageId) {
    return true;
  },

  async updateCardMessage(_token, _messageId, content) {
    // 模拟模式：记录卡片更新到控制台（无 chatId，不写入消息历史）
    console.log(`[${ts()}] [SIM:CARD] update: msgId=${_messageId} preview=${content.slice(0, 80)}`);
    return true;
  },

  // ---- 群聊管理 ----
  async createGroupChat(_token, name, userIds) {
    const chat = simStore.createGroupChat(name, userIds);
    console.log(`[${ts()}] [SIM:CHAT] created: ${chat.id} name="${name}" members=${userIds.length}`);
    return chat.id;
  },

  async updateChatInfo(_token, chatId, name, description) {
    simStore.updateChatInfo(chatId, name, description);
    console.log(`[${ts()}] [SIM:CHAT] updated: ${chatId} name="${name}"`);
  },

  async getChatInfo(_token, chatId) {
    const chat = simStore.getChat(chatId);
    if (!chat) throw new Error(`[99999] chat not found: ${chatId}`);
    return { name: chat.name, description: chat.description };
  },

  async disbandChat(_token, chatId) {
    simStore.disbandChat(chatId);
    console.log(`[${ts()}] [SIM:CHAT] disbanded: ${chatId}`);
  },

  // ---- 头像 ----
  async setChatAvatar(_token, _chatId, _tool, _status) {
    // 模拟模式不需要头像
  },

  async getCodexUsageSummary() {
    return {
      fiveHour: { usedPercent: 0, remainingPercent: 100, resetAtEpochSeconds: null, resetAfterSeconds: null },
      weekly: { usedPercent: 0, remainingPercent: 100, resetAtEpochSeconds: null, resetAfterSeconds: null },
    };
  },

  // ---- 图片下载 ----
  async getOrDownloadImage(_token, _messageId, fileKey) {
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

  async getMergeForwardMessages(_token, _messageId) {
    // 模拟模式没有真实 API，返回空数组让调用方降级到 preview
    return [];
  },
};

/** 模拟模式下的默认 chat_id（重新导出以保持向后兼容） */
export { SIM_DEFAULT_CHAT_ID } from "./sim-store.ts";
