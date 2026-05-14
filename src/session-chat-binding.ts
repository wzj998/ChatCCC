// ---------------------------------------------------------------------------
// session ↔ chats 双向映射
// ---------------------------------------------------------------------------
// sessionChatsMap: sessionId → Set<chatId>
// 由 session.ts 在初始化时调用 rebuildSessionChatsFromRegistry 重建
// ---------------------------------------------------------------------------

const sessionChatsMap = new Map<string, Set<string>>();

/** 从 registry 数据重建映射（由 session.ts 调用，避免循环依赖） */
export function rebuildSessionChatsFromRegistry(registry: Record<string, { chatId: string; sessionId: string }>): void {
  sessionChatsMap.clear();
  for (const record of Object.values(registry)) {
    if (!record.sessionId || !record.chatId) continue;
    bindChatToSession(record.sessionId, record.chatId);
  }
}

export function bindChatToSession(sessionId: string, chatId: string): void {
  let chats = sessionChatsMap.get(sessionId);
  if (!chats) {
    chats = new Set();
    sessionChatsMap.set(sessionId, chats);
  }
  chats.add(chatId);
}

export function unbindChatFromSession(sessionId: string, chatId: string): void {
  const chats = sessionChatsMap.get(sessionId);
  if (chats) {
    chats.delete(chatId);
    if (chats.size === 0) sessionChatsMap.delete(sessionId);
  }
  // 双保险：lastActiveChatMap 是 sessionId → 最后活跃 chatId 的快照，
  // 若被解绑的 chatId 正好是该 session 的 lastActive（典型场景：/newh
  // 把当前群从旧 session 改嫁到新 session），不清理会让旧 session 的
  // display loop 继续向已离开的群推送卡片。
  if (lastActiveChatMap.get(sessionId)?.chatId === chatId) {
    lastActiveChatMap.delete(sessionId);
  }
}

export function getChatsForSession(sessionId: string): string[] {
  const chats = sessionChatsMap.get(sessionId);
  return chats ? Array.from(chats) : [];
}

/** 检查 session 是否还有任何群绑定 */
export function hasChatsForSession(sessionId: string): boolean {
  return (sessionChatsMap.get(sessionId)?.size ?? 0) > 0;
}

/** 检查 sessionId 是否正被其他 chatId 使用（有活跃 prompt） */
export function isSessionRunning(sessionId: string): boolean {
  return activePrompts.has(sessionId);
}

// ---------------------------------------------------------------------------
// activePrompts: sessionId → 活跃 prompt 控制
// ---------------------------------------------------------------------------

export interface ActivePrompt {
  controller: AbortController;
  stopped: boolean;
  startTime: number;
}

export const activePrompts = new Map<string, ActivePrompt>();

// ---------------------------------------------------------------------------
// lastActiveChat: sessionId → 用户最后发送消息的 chatId
// 用于确保 display loop 只推送到用户最近活跃的群
// ---------------------------------------------------------------------------

const lastActiveChatMap = new Map<string, { chatId: string; timestamp: number }>();

export function recordLastActiveChat(sessionId: string, chatId: string): void {
  lastActiveChatMap.set(sessionId, { chatId, timestamp: Date.now() });
}

export function getLastActiveChat(sessionId: string): string | undefined {
  return lastActiveChatMap.get(sessionId)?.chatId;
}

/**
 * display loop 决定推送目标 chat 的纯函数：
 * 仅当 lastActiveChat 仍然绑定到该 session 时才返回，否则返回 undefined。
 *
 * 修复 bug：用户 `/newh` 把当前群从旧 session 改嫁到新 session 后，旧
 * session 的 lastActiveChatMap 残留旧 chatId 快照，display loop 会继续
 * 在该群创建/更新卡片。这里通过交叉验证 sessionChatsMap 把这种悬挂记录
 * 排除掉——loop 拿到 undefined 就走"无活跃群"分支自然停推。
 */
export function pickDisplayChat(sessionId: string): string | undefined {
  const candidate = lastActiveChatMap.get(sessionId)?.chatId;
  if (!candidate) return undefined;
  const chats = sessionChatsMap.get(sessionId);
  return chats?.has(candidate) ? candidate : undefined;
}

// ---------------------------------------------------------------------------
// displayCards: chatId → 展示卡片状态（display loop 用）
// ---------------------------------------------------------------------------

export interface DisplayCardState {
  cardId: string;
  sequence: number;
  cardBusy: boolean;
  cardCreatedAt: number;
  lastSentContent: string;
  streamErrorNotified: boolean;
  /** 卡片轮转时记录的基线，轮转后只展示增量 */
  rotationAccLen?: number;
  rotationFinalReply?: string;
  /** WeChat delta: 上次发送时 accumulatedContent 的长度 */
  lastSentAccLen?: number;
  /** WeChat delta: 上次发送时的 finalReply */
  lastSentFinalReply?: string;
}

export const displayCards = new Map<string, DisplayCardState>();

/** displayLoops: sessionId → 展示循环的 stop 函数 */
export const displayLoops = new Map<string, () => void>();

export function resetBindingState(): void {
  sessionChatsMap.clear();
  lastActiveChatMap.clear();
  activePrompts.clear();
  displayCards.clear();
  for (const stop of displayLoops.values()) stop();
  displayLoops.clear();
}