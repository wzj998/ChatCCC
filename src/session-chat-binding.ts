// ---------------------------------------------------------------------------
// session ↔ chats 双向映射
// ---------------------------------------------------------------------------
// sessionChatsMap: sessionId → Set<chatId>
// 由 session.ts 在初始化时调用 rebuildSessionChatsFromRegistry 重建
// ---------------------------------------------------------------------------

import type { PlatformAdapter } from "./platform-adapter.ts";
import type { ResponseProgressObservation } from "./response-stall.ts";

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
  // 若被解绑的 chatId 正好是该 session 的 lastActive（典型场景：/forget
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

// Agent generator 退出后，最终卡片、registry、头像等仍可能在异步收尾。该阶段
// 也必须阻止下一轮提前进入，否则旧会话的落盘可能覆盖新会话绑定。
const finalizingSessions = new Set<string>();

// response-stall 自动恢复预约只存在于当前进程内：用户已明确 ChatCCC 重启后
// 不需要补发恢复 prompt。预约从检测到第一次停滞起一直持有到恢复轮同步进入
// runAgentSession，填补旧轮收尾和新轮 activePrompts.set 之间的空窗，保证此时
// 到达的普通用户消息只能进入缓存队列，不能抢在恢复 prompt 前执行。
const autoRecoveryReservations = new Set<string>();

/** 检查 sessionId 是否有活跃 prompt、正在收尾或已预约自动恢复。 */
export function isSessionRunning(sessionId: string): boolean {
  return activePrompts.has(sessionId)
    || finalizingSessions.has(sessionId)
    || autoRecoveryReservations.has(sessionId);
}

export function markSessionFinalizing(sessionId: string): void {
  finalizingSessions.add(sessionId);
}

export function clearSessionFinalizing(sessionId: string): void {
  finalizingSessions.delete(sessionId);
}

/** 为 response-stall 后的内部恢复轮预留下一次执行权。 */
export function reserveAutoRecovery(sessionId: string): boolean {
  if (autoRecoveryReservations.has(sessionId)) return false;
  autoRecoveryReservations.add(sessionId);
  return true;
}

/** 恢复轮启动前原子消费预约；返回 false 表示已被 /stop 取消。 */
export function consumeAutoRecoveryReservation(sessionId: string): boolean {
  return autoRecoveryReservations.delete(sessionId);
}

/** 取消尚未启动的恢复轮。 */
export function cancelAutoRecoveryReservation(sessionId: string): boolean {
  return autoRecoveryReservations.delete(sessionId);
}

export function hasAutoRecoveryReservation(sessionId: string): boolean {
  return autoRecoveryReservations.has(sessionId);
}

// ---------------------------------------------------------------------------
// activePrompts: sessionId → 活跃 prompt 控制
// ---------------------------------------------------------------------------

export interface ActivePrompt {
  controller: AbortController;
  stopped: boolean;
  startTime: number;
  /** Root PID for the CLI process currently serving this prompt, if the adapter exposes one. */
  processPid?: number;
  processMonitor?: ReturnType<typeof setInterval>;
  responseStallMonitor?: ReturnType<typeof setInterval>;
  avatarRefreshTimer?: ReturnType<typeof setInterval>;
  /** Grace timer that force-closes a stream which stays open after its authoritative final event. */
  finalResponseCloseTimer?: ReturnType<typeof setTimeout>;
  /** Character-count progress observed only while the activity is "responding". */
  responseProgress?: ResponseProgressObservation;
  /** Set before a response-stall auto-end begins so competing monitors cannot win the race. */
  autoEnded?: boolean;
  autoEndedAt?: number;
  /** Set when the watchdog detects that the CLI process disappeared before stream finalization. */
  abnormalExit?: boolean;
  abnormalExitNotified?: boolean;
  /** Set when the resource monitor detects CPU + memory unchanged for 3 minutes. */
  resourceStuck?: boolean;
  /** True only for the single internal continuation turn after a response stall. */
  autoRecovery?: boolean;
  /** Adapter observed an authoritative completed final-response event. */
  finalResponseObserved?: boolean;
  /** Adapter-provided callback to close the underlying SDK session / subprocess.
   *  Called by stop-stuck-loop before controller.abort() to terminate the CLI
   *  process immediately, rather than waiting for the async generator to unblock. */
  closeSession?: () => void;
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
 * 修复 bug：用户 `/forget` 把当前群从旧 session 改嫁到新 session 后，旧
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
// queuePreservedChat: 队列消费时保留 display loop 目标 chat
// 队列消息来自其他群时，不应把 display loop 重定向到该群
// ---------------------------------------------------------------------------

const queuePreservedChatMap = new Map<string, string>();

/** 队列消费前保存当前 display chat，消费完后自动清除（一次性） */
export function setQueuePreservedChat(sessionId: string, chatId: string): void {
  queuePreservedChatMap.set(sessionId, chatId);
}

/** 获取并清除队列保存的 display chat，没有则返回 undefined */
export function consumeQueuePreservedChat(sessionId: string): string | undefined {
  const chat = queuePreservedChatMap.get(sessionId);
  queuePreservedChatMap.delete(sessionId);
  return chat;
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
  /** Last rendered activity header; elapsed time can change without body output. */
  lastSentHeaderTitle?: string;
  streamErrorNotified: boolean;
  /** 所属 session */
  sessionId: string;
  /** 所属 turn */
  turnCount: number;
  /** 卡片轮转时记录的基线，轮转后只展示增量 */
  rotationAccLen?: number;
  rotationFinalReply?: string;
  /** WeChat delta: 上次发送时 accumulatedContent 的长度 */
  lastSentAccLen?: number;
  /** WeChat delta: 上次发送时的 finalReply */
  lastSentFinalReply?: string;
  /** Liveness animation counter; the explicit activity header conveys Agent state. */
  dotCount: number;
}

export const displayCards = new Map<string, DisplayCardState>();

/** 统一 display loop 的 interval handle，由 session.ts 管理 */
export let unifiedDisplayLoopHandle: ReturnType<typeof setInterval> | null = null;

export function setUnifiedDisplayLoopHandle(h: ReturnType<typeof setInterval> | null): void {
  unifiedDisplayLoopHandle = h;
}

// ---------------------------------------------------------------------------
// queuedMessages: sessionId → 缓存消息（生成中排队，队列最大长度 1）
// ---------------------------------------------------------------------------

export interface QueuedMessage {
  text: string;
  chatId: string;
  openId: string;
  msgTimestamp: number;
  chatType: string;
  traceId?: string;
}

export const queuedMessages = new Map<string, QueuedMessage>();

export interface SessionDrainSnapshot {
  activeSessionIds: string[];
  queuedSessionIds: string[];
}

/** Includes prompt execution, finalization, auto-recovery reservations, and accepted queues. */
export function getSessionDrainSnapshot(): SessionDrainSnapshot {
  const active = new Set<string>([
    ...activePrompts.keys(),
    ...finalizingSessions,
    ...autoRecoveryReservations,
  ]);
  return {
    activeSessionIds: [...active].sort(),
    queuedSessionIds: [...queuedMessages.keys()].sort(),
  };
}

export function enqueueMessage(sessionId: string, msg: QueuedMessage): boolean {
  if (queuedMessages.has(sessionId)) return false;
  queuedMessages.set(sessionId, msg);
  return true;
}

export function dequeueMessage(sessionId: string): QueuedMessage | undefined {
  const msg = queuedMessages.get(sessionId);
  queuedMessages.delete(sessionId);
  return msg;
}

export function cancelQueuedMessage(sessionId: string): boolean {
  return queuedMessages.delete(sessionId);
}

export function hasQueuedMessage(sessionId: string): boolean {
  return queuedMessages.has(sessionId);
}

// ---------------------------------------------------------------------------
// 队列消费回调（由 index.ts 注入，避免 session.ts → orchestrator.ts 循环依赖）
// ---------------------------------------------------------------------------

let onConsumeQueuedMessage: ((platform: PlatformAdapter, msg: QueuedMessage) => void) | null = null;

export function setQueueConsumer(fn: (platform: PlatformAdapter, msg: QueuedMessage) => void): void {
  onConsumeQueuedMessage = fn;
}

export function consumeQueuedMessage(platform: PlatformAdapter, msg: QueuedMessage): void {
  onConsumeQueuedMessage?.(platform, msg);
}

export function resetBindingState(): void {
  sessionChatsMap.clear();
  lastActiveChatMap.clear();
  for (const prompt of activePrompts.values()) {
    if (prompt.processMonitor) clearInterval(prompt.processMonitor);
    if (prompt.responseStallMonitor) clearInterval(prompt.responseStallMonitor);
    if (prompt.finalResponseCloseTimer) clearTimeout(prompt.finalResponseCloseTimer);
  }
  activePrompts.clear();
  finalizingSessions.clear();
  autoRecoveryReservations.clear();
  queuedMessages.clear();
  displayCards.clear();
  if (unifiedDisplayLoopHandle !== null) {
    clearInterval(unifiedDisplayLoopHandle);
    unifiedDisplayLoopHandle = null;
  }
}
