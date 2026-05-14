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
// displayCards: chatId → 展示卡片状态（display loop 用）
// ---------------------------------------------------------------------------

export interface DisplayCardState {
  cardId: string;
  sequence: number;
  cardBusy: boolean;
  cardCreatedAt: number;
  lastSentContent: string;
  streamErrorNotified: boolean;
}

export const displayCards = new Map<string, DisplayCardState>();

/** displayLoops: sessionId → 展示循环的 stop 函数 */
export const displayLoops = new Map<string, () => void>();

export function resetBindingState(): void {
  sessionChatsMap.clear();
  activePrompts.clear();
  displayCards.clear();
  for (const stop of displayLoops.values()) stop();
  displayLoops.clear();
}