/**
 * feishu-platform.ts — 可替换的飞书 API 实现层
 *
 * 默认情况下所有函数直接委托给 feishu-api.ts（真实飞书 API）。
 * 在 --simulate 模式下通过 setPlatform() 整体替换为 SimulatedPlatform。
 *
 * 设计：每个导出函数都是一个"通过 _impl 代理"的包装器，
 * 消费者不需要感知底层是真实飞书还是模拟实现。
 */

import * as realApi from "./feishu-api.ts";

// ---------------------------------------------------------------------------
// 平台接口：覆盖 feishu-api.ts 的所有公开导出函数签名
// ---------------------------------------------------------------------------

export interface FeishuPlatform {
  getTenantAccessToken: typeof realApi.getTenantAccessToken;
  sendTextReply: typeof realApi.sendTextReply;
  sendCardReply: typeof realApi.sendCardReply;
  sendRawCard: typeof realApi.sendRawCard;
  sendPostMessage: typeof realApi.sendPostMessage;
  sendImageReply: typeof realApi.sendImageReply;
  sendFileReply: typeof realApi.sendFileReply;
  addReaction: typeof realApi.addReaction;
  recallMessage: typeof realApi.recallMessage;
  updateCardMessage: typeof realApi.updateCardMessage;
  createGroupChat: typeof realApi.createGroupChat;
  updateChatInfo: typeof realApi.updateChatInfo;
  getChatInfo: typeof realApi.getChatInfo;
  disbandChat: typeof realApi.disbandChat;
  setChatAvatar: typeof realApi.setChatAvatar;
  getOrDownloadImage: typeof realApi.getOrDownloadImage;
  verifyAllPermissions: typeof realApi.verifyAllPermissions;
  reportPermissionResults: typeof realApi.reportPermissionResults;
  extractSessionInfo: typeof realApi.extractSessionInfo;
  extractSessionId: typeof realApi.extractSessionId;
  formatDelayNotice: typeof realApi.formatDelayNotice;
  sendRestartCard: typeof realApi.sendRestartCard;
}

let _impl: FeishuPlatform = realApi;

/** 替换当前平台实现（模拟模式入口） */
export function setPlatform(impl: FeishuPlatform): void {
  _impl = impl;
}

/** 获取当前平台实现（仅供诊断/测试） */
export function getPlatform(): FeishuPlatform {
  return _impl;
}

// ---------------------------------------------------------------------------
// 包装器：每个函数直接委托到 _impl，签名与原函数完全一致
// ---------------------------------------------------------------------------

export function getTenantAccessToken(): ReturnType<typeof realApi.getTenantAccessToken> {
  return _impl.getTenantAccessToken();
}

export function sendTextReply(...args: Parameters<typeof realApi.sendTextReply>): ReturnType<typeof realApi.sendTextReply> {
  return _impl.sendTextReply(...args);
}

export function sendCardReply(...args: Parameters<typeof realApi.sendCardReply>): ReturnType<typeof realApi.sendCardReply> {
  return _impl.sendCardReply(...args);
}

export function sendRawCard(...args: Parameters<typeof realApi.sendRawCard>): ReturnType<typeof realApi.sendRawCard> {
  return _impl.sendRawCard(...args);
}

export function sendImageReply(...args: Parameters<typeof realApi.sendImageReply>): ReturnType<typeof realApi.sendImageReply> {
  return _impl.sendImageReply(...args);
}

export function sendFileReply(...args: Parameters<typeof realApi.sendFileReply>): ReturnType<typeof realApi.sendFileReply> {
  return _impl.sendFileReply(...args);
}

export function addReaction(...args: Parameters<typeof realApi.addReaction>): ReturnType<typeof realApi.addReaction> {
  return _impl.addReaction(...args);
}

export function recallMessage(...args: Parameters<typeof realApi.recallMessage>): ReturnType<typeof realApi.recallMessage> {
  return _impl.recallMessage(...args);
}

export function updateCardMessage(...args: Parameters<typeof realApi.updateCardMessage>): ReturnType<typeof realApi.updateCardMessage> {
  return _impl.updateCardMessage(...args);
}

export function createGroupChat(...args: Parameters<typeof realApi.createGroupChat>): ReturnType<typeof realApi.createGroupChat> {
  return _impl.createGroupChat(...args);
}

export function updateChatInfo(...args: Parameters<typeof realApi.updateChatInfo>): ReturnType<typeof realApi.updateChatInfo> {
  return _impl.updateChatInfo(...args);
}

export function getChatInfo(...args: Parameters<typeof realApi.getChatInfo>): ReturnType<typeof realApi.getChatInfo> {
  return _impl.getChatInfo(...args);
}

export function disbandChat(...args: Parameters<typeof realApi.disbandChat>): ReturnType<typeof realApi.disbandChat> {
  return _impl.disbandChat(...args);
}

export function setChatAvatar(...args: Parameters<typeof realApi.setChatAvatar>): ReturnType<typeof realApi.setChatAvatar> {
  return _impl.setChatAvatar(...args);
}

export function getOrDownloadImage(...args: Parameters<typeof realApi.getOrDownloadImage>): ReturnType<typeof realApi.getOrDownloadImage> {
  return _impl.getOrDownloadImage(...args);
}

export function verifyAllPermissions(...args: Parameters<typeof realApi.verifyAllPermissions>): ReturnType<typeof realApi.verifyAllPermissions> {
  return _impl.verifyAllPermissions(...args);
}

export function reportPermissionResults(...args: Parameters<typeof realApi.reportPermissionResults>): ReturnType<typeof realApi.reportPermissionResults> {
  return _impl.reportPermissionResults(...args);
}

export function extractSessionInfo(...args: Parameters<typeof realApi.extractSessionInfo>): ReturnType<typeof realApi.extractSessionInfo> {
  return _impl.extractSessionInfo(...args);
}

export function extractSessionId(...args: Parameters<typeof realApi.extractSessionId>): ReturnType<typeof realApi.extractSessionId> {
  return _impl.extractSessionId(...args);
}

export function formatDelayNotice(...args: Parameters<typeof realApi.formatDelayNotice>): ReturnType<typeof realApi.formatDelayNotice> {
  return _impl.formatDelayNotice(...args);
}

export function sendPostMessage(...args: Parameters<typeof realApi.sendPostMessage>): ReturnType<typeof realApi.sendPostMessage> {
  return _impl.sendPostMessage(...args);
}

export function sendRestartCard(...args: Parameters<typeof realApi.sendRestartCard>): ReturnType<typeof realApi.sendRestartCard> {
  return _impl.sendRestartCard(...args);
}