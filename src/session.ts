import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  CLAUDE_API_KEY,
  CLAUDE_BASE_URL,
  CLAUDE_MAX_TURN,
  CLAUDE_MODEL,
  CLAUDE_SUBAGENT_MODEL,
  CHATCCC_PORT,
  PROJECT_ROOT,
  SESSIONS_FILE,
  USER_DATA_DIR,
  addRecentDir,
  anthropicConfigDisplay,
  config,
  fileLog,
  getDefaultCwd,
  getDefaultEffortForTool,
  isAnthropicConfigEmpty,
  toolDisplayName,
  ts,
} from "./config.ts";
import { buildProgressCard, getToolEmoji, isCodeBlockOpen, truncateContent } from "./cards.ts";
import {
  createAgentActivityTracker,
  formatAgentActivityTitle,
  updateAgentActivity,
} from "./agent-activity.ts";
import type { AgentActivityKind } from "./agent-activity.ts";
import { simplifyToolUse, simplifyToolResult } from "./simplify.ts";
import { logTrace } from "./trace.ts";
import type { UnifiedBlock } from "./adapters/adapter-interface.ts";
import type { ToolAdapter } from "./adapters/adapter-interface.ts";
import type { ToolProcessInfo } from "./adapters/adapter-interface.ts";
import { createClaudeAdapter } from "./adapters/claude-adapter.ts";
import { createCursorAdapter } from "./adapters/cursor-adapter.ts";
import { createCodexAdapter } from "./adapters/codex-adapter.ts";
import { createCccAdapter } from "./adapters/ccc-adapter.ts";
import { killProcessTree } from "./adapters/proc-tree-kill.ts";
import { resourceMonitor, registerProcess, unregisterProcess } from "./adapters/resource-monitor.ts";
import { buildImSkillsPromptCached, exportSkillSubDocs, clearImSkillsPromptCache } from "./im-skills.ts";
import type { PlatformAdapter } from "./platform-adapter.ts";
import { hasResponseStalled, observeResponseProgress } from "./response-stall.ts";
import {
  MAX_PROCESSED,
  clearFeishuMessageLedgerMemory,
  processedMessages,
} from "./feishu-message-ingress.ts";

export { MAX_PROCESSED, processedMessages };

// 微信显示循环压缩：头5 + ... + 尾5，避免在最后一步 sendText 中压缩指令回复
function compressWechatDisplayText(text: string): string {
  const lines = text.split("\n");
  if (lines.length <= 10) return text;
  return [...lines.slice(0, 5), "...", ...lines.slice(-5)].join("\n");
}
import {
  readStreamState,
  writeStreamState,
  createEmptyStreamState,
  fixStaleStreamStates,
  isFinalReplySentForTurn,
  markFinalReplySent,
} from "./stream-state.ts";
import { addCardToTurn, finalizeTurnCards, markCardDone } from "./turn-cards.ts";
import {
  bindChatToSession,
  unbindChatFromSession,
  getChatsForSession,
  isSessionRunning,
  activePrompts,
  displayCards,
  unifiedDisplayLoopHandle,
  setUnifiedDisplayLoopHandle,
  rebuildSessionChatsFromRegistry,
  recordLastActiveChat,
  getLastActiveChat,
  pickDisplayChat,
  dequeueMessage,
  consumeQueuedMessage,
  cancelQueuedMessage,
  setQueuePreservedChat,
  consumeQueuePreservedChat,
  markSessionFinalizing,
  clearSessionFinalizing,
  reserveAutoRecovery,
  consumeAutoRecoveryReservation,
  cancelAutoRecoveryReservation,
  hasAutoRecoveryReservation,
} from "./session-chat-binding.ts";

async function sendFinalReplyTextOnce(
  platform: PlatformAdapter,
  chatId: string,
  sessionId: string,
  turnCount: number,
  text: string,
): Promise<boolean> {
  const sent = await platform.sendText(chatId, text).then((ok) => ok !== false).catch(() => false);
  if (sent) await markFinalReplySent(sessionId, turnCount);
  return sent;
}

async function createVisibleProgressCard(
  platform: PlatformAdapter,
  chatId: string,
  sessionId: string,
  turnCount: number,
  notifyFailureText?: string,
  headerTitle = "正在启动 Agent · 0秒",
): Promise<string | null> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    let cardId: string | null = null;
    try {
      cardId = await platform.cardCreate(
        buildProgressCard("等待 Agent 输出...", { showStop: true, headerTitle }),
      );
      if (!cardId) throw new Error("empty card id");
      await platform.cardSend(chatId, cardId);
      await addCardToTurn(sessionId, turnCount, cardId);
      return cardId;
    } catch (err) {
      console.error(
        `[${ts()}] [DISPLAY] progress card send attempt ${attempt} failed: chatId=${chatId} cardId=${cardId || "(none)"} ${(err as Error).message}`,
      );
    }
  }

  if (notifyFailureText) {
    await platform.sendText(chatId, notifyFailureText).catch(() => {});
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shared state (imported by index.ts)
// ---------------------------------------------------------------------------

/** 每个 chatId 上一次已处理消息的时间戳，用于拦截延迟送达的旧消息 */
export const lastMsgTimestamps = new Map<string, number>();

// ---------------------------------------------------------------------------
// 平台引用 —— session 模块通过此引用访问 IM 平台操作，
// 避免 import feishu-platform.ts 造成的耦合。
// 由 index.ts 在启动时调用 setSessionPlatform 注入。
// ---------------------------------------------------------------------------

let platformRef: PlatformAdapter | null = null;
const chatPlatformMap = new Map<string, PlatformAdapter>();

/** 注入当前 IM 平台适配器，供 session 模块使用 */
export function setSessionPlatform(platform: PlatformAdapter): void {
  platformRef = platform;
}

export function recordChatPlatform(chatId: string, platform: PlatformAdapter): void {
  chatPlatformMap.set(chatId, platform);
}

export function forgetChatPlatform(chatId: string): void {
  chatPlatformMap.delete(chatId);
}

function platformForChat(chatId: string): PlatformAdapter | null {
  return chatPlatformMap.get(chatId) ?? platformRef;
}

const DEFAULT_PROCESS_MONITOR_INTERVAL_MS = 5000;
const DEFAULT_RESPONSE_STALL_TIMEOUT_MS = 3 * 60 * 1000;
const DEFAULT_RESPONSE_STALL_CHECK_INTERVAL_MS = 5000;
const DEFAULT_FINAL_RESPONSE_CLOSE_TIMEOUT_MS = 10_000;
export const RESPONSE_STALL_RECOVERY_PROMPT = "完成了吗？如果没完成继续";
export const RESPONSE_STALL_RECOVERY_NOTICE =
  `检测到会话停滞，正在自动确认并继续。\n\n${RESPONSE_STALL_RECOVERY_PROMPT}`;
export const RESPONSE_STALL_RECOVERY_EXHAUSTED_NOTICE =
  "⚠️ 自动续跑仍连续 3 分钟没有启动进展或新回复，本次不再自动继续。";
const RESPONSE_STALL_RECOVERY_DELAY_MS = 200;
let processMonitorIntervalMs = DEFAULT_PROCESS_MONITOR_INTERVAL_MS;
let responseStallTimeoutMs = DEFAULT_RESPONSE_STALL_TIMEOUT_MS;
let responseStallCheckIntervalMs = DEFAULT_RESPONSE_STALL_CHECK_INTERVAL_MS;
let finalResponseCloseTimeoutMs = DEFAULT_FINAL_RESPONSE_CLOSE_TIMEOUT_MS;
let isProcessAliveImpl = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export function _setProcessAliveForTest(impl: (pid: number) => boolean): void {
  isProcessAliveImpl = impl;
}

export function _resetProcessAliveForTest(): void {
  isProcessAliveImpl = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
}

export function _setProcessMonitorIntervalForTest(ms: number): void {
  processMonitorIntervalMs = ms;
}

export function _resetProcessMonitorIntervalForTest(): void {
  processMonitorIntervalMs = DEFAULT_PROCESS_MONITOR_INTERVAL_MS;
}

export function _setResponseStallTimeoutForTest(ms: number): void {
  responseStallTimeoutMs = ms;
}

export function _resetResponseStallTimeoutForTest(): void {
  responseStallTimeoutMs = DEFAULT_RESPONSE_STALL_TIMEOUT_MS;
}

export function _setResponseStallCheckIntervalForTest(ms: number): void {
  responseStallCheckIntervalMs = ms;
}

export function _resetResponseStallCheckIntervalForTest(): void {
  responseStallCheckIntervalMs = DEFAULT_RESPONSE_STALL_CHECK_INTERVAL_MS;
}

export function _setFinalResponseCloseTimeoutForTest(ms: number): void {
  finalResponseCloseTimeoutMs = ms;
}

export function _resetFinalResponseCloseTimeoutForTest(): void {
  finalResponseCloseTimeoutMs = DEFAULT_FINAL_RESPONSE_CLOSE_TIMEOUT_MS;
}

function clearPromptProcessMonitor(sessionId: string): void {
  const prompt = activePrompts.get(sessionId);
  if (!prompt?.processMonitor) return;
  clearInterval(prompt.processMonitor);
  prompt.processMonitor = undefined;
}

function clearPromptResponseStallMonitor(sessionId: string): void {
  const prompt = activePrompts.get(sessionId);
  if (!prompt?.responseStallMonitor) return;
  clearInterval(prompt.responseStallMonitor);
  prompt.responseStallMonitor = undefined;
}

function clearPromptFinalResponseCloseTimer(sessionId: string): void {
  const prompt = activePrompts.get(sessionId);
  if (!prompt?.finalResponseCloseTimer) return;
  clearTimeout(prompt.finalResponseCloseTimer);
  prompt.finalResponseCloseTimer = undefined;
}

/**
 * 权威终态只说明 Agent 已完成本轮，不保证 CLI/SDK 的输出流会及时关闭。
 * 给正常清理保留 10 秒；若流仍悬挂，则关闭底层 session 并杀掉当前 CLI 树，
 * 让 runAgentSession 以 done 收尾。这里绝不触发自动续跑，因为答案已完整到达。
 */
function scheduleFinalResponseCloseGuard(
  sessionId: string,
  runningPrompt: NonNullable<ReturnType<typeof activePrompts.get>>,
): void {
  if (runningPrompt.finalResponseCloseTimer) return;

  const timeoutMs = finalResponseCloseTimeoutMs;
  const handle = setTimeout(() => {
    const current = activePrompts.get(sessionId);
    if (
      !current
      || current !== runningPrompt
      || !current.finalResponseObserved
      || current.stopped
      || current.abnormalExit
      || current.resourceStuck
      || current.autoEnded
    ) {
      return;
    }

    current.finalResponseCloseTimer = undefined;
    clearPromptProcessMonitor(sessionId);
    clearPromptResponseStallMonitor(sessionId);
    try {
      current.closeSession?.();
    } catch (err) {
      console.warn(
        `[${ts()}] [FINAL-RESPONSE] closeSession failed for ${sessionId}: ${(err as Error).message}`,
      );
    }
    current.controller.abort();
    void killProcessTree(current.processPid);
    console.warn(
      `[${ts()}] [FINAL-RESPONSE] Session ${sessionId} stream stayed open for ${timeoutMs}ms after its authoritative final event; forced clean shutdown`,
    );
  }, timeoutMs);
  handle.unref?.();
  runningPrompt.finalResponseCloseTimer = handle;
}

function formatTerminalHeader(status: "running" | "done" | "stopped" | "error" | "auto_ended"): {
  title: string;
  template?: string;
} {
  if (status === "auto_ended") return { title: "已自动结束 · 3分钟无新内容", template: "orange" };
  if (status === "stopped") return { title: "已停止", template: "red" };
  if (status === "error") return { title: "异常结束", template: "red" };
  return { title: "完成" };
}

function turnFinalStatus(status: "running" | "done" | "stopped" | "error" | "auto_ended"): "done" | "stopped" {
  return status === "stopped" || status === "error" || status === "auto_ended" ? "stopped" : "done";
}

function formatAutoEndedReply(finalReply: string): string {
  const reason = "⚠️ 已自动结束：连续 3 分钟没有启动进展或回复字符变化。";
  return finalReply
    ? `${reason}以下回复可能不完整。\n\n${finalReply}`
    : `${reason}本轮没有可发送的回复内容。`;
}

/**
 * 只监控用户无法判断是否仍有进展的两个阶段。思考、工具调用和搜索可能合法地
 * 长时间不产生回复字符，由资源监控负责识别真正僵死，不能在这里误杀。
 */
function monitorsOutputProgress(kind: AgentActivityKind): boolean {
  return kind === "starting" || kind === "responding";
}

function formatTerminalReply(
  status: "running" | "done" | "stopped" | "error" | "auto_ended",
  finalReply: string,
): string | null {
  if (status === "auto_ended") return formatAutoEndedReply(finalReply);
  return finalReply || null;
}

function isCardKitSequenceConflict(err: unknown): boolean {
  return err instanceof Error && err.message.includes("300317");
}

function startPromptProcessMonitor(sessionId: string, info: ToolProcessInfo): void {
  const prompt = activePrompts.get(sessionId);
  if (!prompt) return;
  prompt.processPid = info.pid;
  clearPromptProcessMonitor(sessionId);

  const check = async () => {
    const current = activePrompts.get(sessionId);
    if (!current || current !== prompt) {
      clearPromptProcessMonitor(sessionId);
      return;
    }
    if (current.stopped || current.abnormalExit || current.resourceStuck || current.autoEnded) return;
    if (isProcessAliveImpl(info.pid)) return;

    current.abnormalExit = true;
    clearPromptProcessMonitor(sessionId);

    const state = await readStreamState(sessionId);
    if (state?.status === "running") {
      await writeStreamState({
        ...state,
        status: "error",
        updatedAt: Date.now(),
      });
    }

    const chatId = pickDisplayChat(sessionId) ?? getLastActiveChat(sessionId) ?? getChatsForSession(sessionId)[0];
    const p = chatId ? platformForChat(chatId) : null;
    if (chatId && p && !current.abnormalExitNotified) {
      current.abnormalExitNotified = true;
      await p.sendText(
        chatId,
        `⚠️ 进程异常结束：session ${sessionId} 对应的 CLI 进程 PID ${info.pid} 已不存在，已按完成处理。若回复不完整，请重新发送上一条指令。`,
      ).catch(() => {});
    }

    // 主动关闭 readline，让 runAgentSession 的 finally 落盘 error 终态并清理 activePrompts。
    current.controller.abort();
  };

  const handle = setInterval(() => {
    void check().catch((err) => {
      console.warn(`[${ts()}] [PROCESS-MONITOR] check failed for ${sessionId}: ${(err as Error).message}`);
    });
  }, processMonitorIntervalMs);
  handle.unref?.();
  prompt.processMonitor = handle;
}

export function _getPlatformForChatForTest(chatId: string): PlatformAdapter | null {
  return platformForChat(chatId);
}

export function getPlatformForChat(chatId: string): PlatformAdapter | null {
  return platformForChat(chatId);
}

function imSkillNamesForPlatform(platform: PlatformAdapter): string[] {
  if (platform.kind === "wechat") {
    return ["wechat-image-skill", "wechat-file-skill", "wechat-video-skill"];
  }
  return ["feishu-skill"];
}

export let sessionGen = 0;
/** @deprecated 使用 activePrompts (session-chat-binding.ts) + displayCards 替代 */
export const chatSessionMap = new Map<string, {
  gen: number;
  close: () => void;
  cardId: string | null;
  stopped: boolean;
  accumulatedContent: string;
  finalText: string;
  spinnerTimer: ReturnType<typeof setInterval> | null;
  msgTimestamp: number;
  sequence: number;
  cardBusy: boolean;
}>();

/**
 * sessionInfoMap 记录每个 chatId 当前绑定的会话元数据。
 * 同一 session 可被多个 chatId 共享；model/effort 不在其中（按 tool 动态解析）。
 */
export const sessionInfoMap = new Map<string, {
  sessionId: string;
  turnCount: number;
  lastContextTokens: number;
  startTime: number;
  tool: string;
}>();

/**
 * 清空所有进程内运行时状态。
 *
 * ⚠️ 红线：**绝对不要**在飞书 SDK 的 onReady / onReconnected 回调里调用本函数。
 * SDK 的 WebSocket 重连只是底层连接抖动，业务层（活跃 prompt、display loop、
 * stream-state 文件、轮数计数）完全不受影响。在重连里调 resetState 会：
 *   1) `activePrompts.clear()` 只是删 Map，**不会** abort 后台 generator。
 *      generator 继续跑、继续写 stream-state.json，但 display loop 已被
 *      stop，用户群里再也看不到任何更新；最终回复永远不发到群。
 *   2) 该 sessionId 在内存里"看似空闲"，下一条用户消息进来会**第二次进入**
 *      `runAgentSession`，同一个 cursor/claude session 同时跑两条 prompt，
 *      输出互相串扰、token 计费翻倍。
 *   3) `processedMessages` / `lastMsgTimestamps` 被清，SDK 重连后若服务端
 *      重推已 ack 的消息，去重失效会让同一 prompt 被处理两次。
 *   4) `sessionInfoMap` 清空后，群再发消息时 nextTurnCount 从 1 重新计数。
 *
 * 合法调用点：
 *   - 单元测试 setup（清测试间状态）
 *   - 进程首次启动（此时 Map 都是空的，调用纯粹是为了打 LOG）
 *
 * SDK 重连场景请改用 `rebuildBindingsFromRegistry()`，它只重建 sessionId →
 * chatId 映射，不动任何运行时状态。
 */
export function resetState(): void {
  for (const entry of chatSessionMap.values()) {
    if (entry.spinnerTimer) clearInterval(entry.spinnerTimer);
    try { entry.close(); } catch { /* ignore */ }
  }
  chatSessionMap.clear();
  sessionInfoMap.clear();
  clearFeishuMessageLedgerMemory();
  lastMsgTimestamps.clear();
  chatPlatformMap.clear();
  for (const prompt of activePrompts.values()) {
    if (prompt.processMonitor) clearInterval(prompt.processMonitor);
    if (prompt.responseStallMonitor) clearInterval(prompt.responseStallMonitor);
    if (prompt.finalResponseCloseTimer) clearTimeout(prompt.finalResponseCloseTimer);
  }
  activePrompts.clear();
  displayCards.clear();
  sessionModelOverrides.clear();
  sessionEffortOverrides.clear();
  sessionFastModeOverrides.clear();
  adapterCache.clear();
  stopUnifiedDisplayLoop();
  console.log(`[${ts()}] [RESET] State cleared (dedup + active sessions + bindings)`);
}

// 注:`rebuildBindingsFromRegistry` 定义在下方与 loadSessionRegistry 同区域,
// 是 onReady/onReconnected 取代 resetState 的正确入口。

// ---------------------------------------------------------------------------
// Adapter: 按 tool + effectiveModel 创建并缓存
// ---------------------------------------------------------------------------

const adapterCache = new Map<string, ToolAdapter>();

// Per-session 模型覆盖（/model 命令设置，不持久化）
const sessionModelOverrides = new Map<string, string>();
const sessionEffortOverrides = new Map<string, string>();
const sessionFastModeOverrides = new Map<string, boolean>();

/** 返回 session 的生效模型：优先 per-session 覆盖，其次全局配置（Claude） */
function getModelForSession(sessionId?: string): string {
  if (sessionId) {
    const override = sessionModelOverrides.get(sessionId);
    if (override) return override;
  }
  return CLAUDE_MODEL;
}

/** 返回指定 tool 的生效模型：优先 per-session 覆盖，其次 tool 默认配置 */
export function getEffectiveModelForTool(tool: string, sessionId?: string): string {
  if (sessionId) {
    const override = sessionModelOverrides.get(sessionId);
    if (override) return override;
  }
  if (tool === "cursor") return config.cursor.model;
  if (tool === "codex") return config.codex.model;
  if (tool === "ccc") return config.ccc.model;
  return CLAUDE_MODEL;
}

export function getEffectiveEffortForTool(tool: string, sessionId?: string): string {
  if (sessionId) {
    const override = sessionEffortOverrides.get(sessionId);
    if (override) return override;
  }
  if (tool === "claude" || tool === "codex") {
    return getDefaultEffortForTool(tool);
  }
  return "";
}

export function getEffectiveFastModeForTool(tool: string, sessionId?: string): boolean {
  if (tool !== "codex") return false;
  if (sessionId && sessionFastModeOverrides.has(sessionId)) {
    return sessionFastModeOverrides.get(sessionId) === true;
  }
  return config.codex.fastMode;
}

/** 为指定 session 设置模型覆盖（/model <name>） */
export function setSessionModelOverride(sessionId: string, model: string): void {
  sessionModelOverrides.set(sessionId, model);
  adapterCache.clear();
}

/** 清除指定 session 的模型覆盖（/model clear） */
export function clearSessionModelOverride(sessionId: string): void {
  sessionModelOverrides.delete(sessionId);
  adapterCache.clear();
}

export function setSessionEffortOverride(sessionId: string, effort: string): void {
  sessionEffortOverrides.set(sessionId, effort);
  adapterCache.clear();
}

export function clearSessionEffortOverride(sessionId: string): void {
  sessionEffortOverrides.delete(sessionId);
  adapterCache.clear();
}

export function setSessionFastModeOverride(sessionId: string, fastMode: boolean): void {
  sessionFastModeOverrides.set(sessionId, fastMode);
  adapterCache.clear();
}

export function getAdapterForTool(tool: string, sessionId?: string): ToolAdapter {
  const effectiveModel = getEffectiveModelForTool(tool, sessionId);
  const effectiveEffort = getEffectiveEffortForTool(tool, sessionId);
  const effectiveFastMode = getEffectiveFastModeForTool(tool, sessionId);
  const cacheKey = `${tool}:${effectiveModel || ""}:${effectiveEffort || ""}:${effectiveFastMode ? "fast" : "default"}`;
  const cached = adapterCache.get(cacheKey);
  if (cached) return cached;

  let adapter: ToolAdapter;
  if (tool === "cursor") {
    adapter = createCursorAdapter({ model: effectiveModel || undefined });
  } else if (tool === "codex") {
    adapter = createCodexAdapter({
      model: effectiveModel || undefined,
      effort: effectiveEffort || undefined,
      fastMode: effectiveFastMode,
    });
  } else if (tool === "ccc") {
    adapter = createCccAdapter({ model: effectiveModel || undefined });
  } else {
    adapter = createClaudeAdapter({
      model: effectiveModel,
      subagentModel: CLAUDE_SUBAGENT_MODEL,
      effort: effectiveEffort,
      apiKey: CLAUDE_API_KEY,
      baseUrl: CLAUDE_BASE_URL,
      isEmpty: isAnthropicConfigEmpty,
      maxTurn: CLAUDE_MAX_TURN,
    });
  }
  adapterCache.set(cacheKey, adapter);
  return adapter;
}

// ---------------------------------------------------------------------------
// Session tool persistence (state/sessions.json)
// ---------------------------------------------------------------------------

interface SessionToolRecord {
  tool: string;
  createdAt: number;
  chatName?: string;
}

let sessionToolsFile = SESSIONS_FILE;

async function loadSessionTools(): Promise<Record<string, SessionToolRecord>> {
  try {
    const raw = await readFile(sessionToolsFile, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveSessionTools(data: Record<string, SessionToolRecord>): Promise<void> {
  try {
    await mkdir(dirname(sessionToolsFile), { recursive: true });
    await writeFile(sessionToolsFile, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    console.error(`[${ts()}] Failed to save sessions.json: ${(err as Error).message}`);
    fileLog.flush();
  }
}

export async function saveSessionTool(sessionId: string, tool: string, chatName?: string): Promise<void> {
  const data = await loadSessionTools();
  const existing = data[sessionId];
  const mergedChatName = chatName ?? existing?.chatName;
  data[sessionId] = {
    tool,
    createdAt: existing?.createdAt ?? Date.now(),
    ...(mergedChatName ? { chatName: mergedChatName } : {}),
  };
  await saveSessionTools(data);
}

export async function getSessionTool(sessionId: string): Promise<string | null> {
  const data = await loadSessionTools();
  const record = data[sessionId];
  return record?.tool ?? null;
}

export function _setSessionToolsFileForTest(filePath: string): void {
  sessionToolsFile = filePath;
}

export function _resetSessionToolsFileForTest(): void {
  sessionToolsFile = SESSIONS_FILE;
}

// ---------------------------------------------------------------------------
// Conversation session registry for /sessions
// ---------------------------------------------------------------------------

export const SESSION_REGISTRY_FILE = join(USER_DATA_DIR, "state", "session-registry.json");
let sessionRegistryFile = SESSION_REGISTRY_FILE;

export interface SessionRegistryUpdate {
  chatId: string;
  sessionId: string;
  tool: string;
  /** 会话容器类型；旧 registry 没有该字段，读取时必须兼容。 */
  chatType?: string;
  chatName?: string;
  turnCount?: number;
  lastContextTokens?: number;
  startTime?: number;
  updatedAt?: number;
  running?: boolean;
}

interface SessionRegistryRecord {
  chatId: string;
  sessionId: string;
  tool: string;
  chatType?: string;
  chatName: string;
  turnCount: number;
  lastContextTokens: number;
  startTime: number;
  updatedAt: number;
  running: boolean;
}

type SessionRegistryData = Record<string, SessionRegistryRecord>;

async function loadSessionRegistry(): Promise<SessionRegistryData> {
  try {
    const raw = await readFile(sessionRegistryFile, "utf-8");
    const parsed = JSON.parse(raw) as SessionRegistryData;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** 供 session-chat-binding.ts 重建映射 */
export async function loadSessionRegistryForBinding(): Promise<SessionRegistryData> {
  return loadSessionRegistry();
}

/**
 * 从持久化的 registry 重建 sessionId → chatId 映射。
 *
 * 设计契约（替代之前 onReady/onReconnected 误用的 resetState）：
 *   - **不动** activePrompts：后台 prompt 在 SDK 重连后必须继续被识别为活跃,
 *     否则下条用户消息会绕过 isSessionRunning 检查再开一条 prompt,
 *     导致同一 sessionId 双开 generator
 *   - **不动** sessionInfoMap：内存里的轮数/contextTokens 比 registry 更新
 *   - **不动** displayCards：正在跑的 prompt 还需要它们继续推卡片
 *   - **不动** processedMessages / lastMsgTimestamps：SDK 重连若重推已 ack 消息,
 *     去重 set 还在才能避免同一 prompt 跑两遍
 *
 * 唯一被重建的是 sessionChatsMap（通过调用 rebuildSessionChatsFromRegistry）——
 * 该 Map 是从 registry 派生的纯只读映射,重建是幂等且廉价的。
 */
export async function rebuildBindingsFromRegistry(): Promise<void> {
  const registry = await loadSessionRegistry();
  rebuildSessionChatsFromRegistry(registry);
}

async function saveSessionRegistry(data: SessionRegistryData): Promise<void> {
  try {
    await mkdir(dirname(sessionRegistryFile), { recursive: true });
    await writeFile(sessionRegistryFile, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    console.error(`[${ts()}] Failed to save session-registry.json: ${(err as Error).message}`);
    fileLog.flush();
  }
}

export async function recordSessionRegistry(update: SessionRegistryUpdate): Promise<void> {
  const data = await loadSessionRegistry();
  const existing = data[update.chatId];
  const now = update.updatedAt ?? Date.now();

  data[update.chatId] = {
    chatId: update.chatId,
    sessionId: update.sessionId,
    tool: update.tool,
    chatType: update.chatType ?? existing?.chatType,
    chatName: update.chatName ?? existing?.chatName ?? "",
    turnCount: update.turnCount ?? existing?.turnCount ?? 0,
    lastContextTokens: update.lastContextTokens ?? existing?.lastContextTokens ?? 0,
    startTime: update.startTime ?? existing?.startTime ?? now,
    updatedAt: now,
    running: update.running ?? existing?.running ?? false,
  };

  await saveSessionRegistry(data);
}

export async function removeSessionRegistryRecord(chatId: string): Promise<void> {
  const data = await loadSessionRegistry();
  delete data[chatId];
  await saveSessionRegistry(data);
}

export function _setSessionRegistryFileForTest(filePath: string): void {
  sessionRegistryFile = filePath;
}

export function _resetSessionRegistryFileForTest(): void {
  sessionRegistryFile = SESSION_REGISTRY_FILE;
}

// ---------------------------------------------------------------------------
// accumulateBlockContent — 将 UnifiedBlock 累积到渲染状态（纯函数，可测试）
// ---------------------------------------------------------------------------

// 注意：以下字段命名含 "final"，但实际语义是"本轮所有文本的累积"，并非仅
// "最后一段回复"。历史原因得名——当时以为 finalReply 只包含最后一轮输出，实则
// 所有 text block（工具调用前、调用间、调用后）都累加在这里。
// accumulatedContent + finalReply 拼接后才是完整流式输出的全部内容。
export interface AccumulatorState {
  accumulatedContent: string;
  /** 本轮所有 text block 的累加（流式文本 delta），包括工具调用前后的全部文本 */
  finalText: string;
  /**
   * 适配器明确给出的"完整最终文本"（覆盖语义）。
   * 仅 Cursor `--stream-partial-output` 模式末尾的 final assistant 消息会写入；
   * 用于配合 pickFinalReply 在 partial 累加 vs final 完整文本之间挑选最终回复，
   * 避免最终消息出现两段重复内容。
   */
  finalCompleteText: string;
  chunkCount: number;
}

/**
 * 在 partial 累加（finalText）与适配器给出的"完整最终文本"（finalCompleteText）
 * 之间挑选最终回复：
 *   - finalCompleteText 非空时永远优先（来自 cursor result.result 等权威源）
 *   - 否则回退到 finalText（partial 累加）
 *
 * 不做长度比较：cursor 在工具调用前会发 buffered flush（重复快照），
 * 若按当前 adapter 误把 buffered flush 当 delta 累加，partial 累加可能"虚高"，
 * 此时取更长会选错；权威源（result.result）才是正解。
 */
export function pickFinalReply(state: AccumulatorState): string {
  return state.finalCompleteText || state.finalText;
}

export function accumulateBlockContent(
  block: UnifiedBlock,
  state: AccumulatorState,
  toolCallMap?: Map<string, { name: string; input: unknown }>,
): void {
  switch (block.type) {
    case "thinking":
      state.chunkCount++;
      // 用引用块标记思考内容（中文无法斜体，引用块有视觉区分）
      state.accumulatedContent += `\n> ${block.thinking.replace(/\n/g, "\n> ")}\n`;
      break;
    case "tool_use": {
      // 记录 tool_use 信息供后续 tool_result 使用
      if (toolCallMap && block.id) {
        toolCallMap.set(block.id, { name: block.name, input: block.input });
      }
      const simplified = simplifyToolUse(block.name, block.input);
      if (simplified !== null) {
        state.accumulatedContent += `\n\n${simplified}\n`;
      } else {
        const inputStr =
          typeof block.input === "object"
            ? JSON.stringify(block.input)
            : String(block.input ?? "");
        const shortInput =
          inputStr.length > 300 ? inputStr.slice(0, 300) + "..." : inputStr;
        state.accumulatedContent +=
          `\n\n${getToolEmoji(block.name)} **${block.name}**\n\`${shortInput}\`\n`;
      }
      break;
    }
    case "tool_result": {
      const toolUseId = block.tool_use_id;
      const isError = block.is_error;
      // 查找对应的 tool_use 以获取工具名和输入
      const toolCall = toolCallMap?.get(toolUseId);
      const toolName = toolCall?.name;
      const toolInput = toolCall?.input;
      const simplified = toolName
        ? simplifyToolResult(toolName, toolUseId, !!isError, toolInput)
        : null;
      if (simplified !== null) {
        state.accumulatedContent += `${simplified}\n`;
      } else {
        const resultContent = block.content;
        let resultStr = "";
        if (typeof resultContent === "string") {
          resultStr = resultContent;
        } else if (Array.isArray(resultContent)) {
          resultStr = resultContent
            .map((c: { type?: string; text?: string }) => c.text ?? "")
            .join("");
        } else if (resultContent) {
          resultStr = JSON.stringify(resultContent);
        }
        const shortResult =
          resultStr.length > 200 ? resultStr.slice(0, 200) + "..." : resultStr;
        const icon = isError ? "❌" : "✅"; // ❌ : ✅
        state.accumulatedContent +=
          `${icon} *${toolUseId.slice(-6)}*: ${shortResult}\n`;
      }
      break;
    }
    case "redacted_thinking":
      state.accumulatedContent += "\n\n⚠️ 内容被安全过滤\n"; // ⚠️
      break;
    case "search_result":
      state.accumulatedContent +=
        `\n\n🔍 联网搜索: **${block.query}**\n`; // 🔍
      break;
    case "text":
      state.finalText += block.text;
      // 新的增量文本到达时清空 finalCompleteText，确保 pickFinalReply 回退到
      // finalText（累积文本）。否则 Cursor buffered flush 设置的旧
      // finalCompleteText 会"吞掉"工具调用后新到达的增量文本。
      state.finalCompleteText = "";
      break;
    case "text_final":
      // 覆盖而非追加：适配器已保证这是一段完整最终文本（如 Cursor 流末快照）
      state.finalCompleteText = block.text;
      break;
    case "compact_boundary": {
      const triggerLabel = block.trigger === "manual" ? "手动" : "自动"; // 手动 / 自动
      state.accumulatedContent +=
        `\n\n🔄 上下文压缩(${triggerLabel}): **${block.pre_tokens}** → **${block.post_tokens}** tokens\n`; // 🔄 / →
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// switchChatBinding — /newh、/session N 共用的事务式"切换 chat 绑定"
// ---------------------------------------------------------------------------
//
// 设计契约（解决三类历史 bug）：
//
//   1. 私聊不能调 updateChatInfo（飞书 API 在 p2p chatId 上会返回非 0 → throw）。
//      之前的实现没判断 chatType,私聊 /newh、/session N 走到 updateChatInfo
//      就直接抛错,留下"内存已切换、registry 没更新"的脏状态。
//
//   2. updateChatInfo 群聊也可能因为网络/频控失败。之前的代码顺序是
//        先 unbind 旧 → bind 新 → 再调 updateChatInfo
//      API 失败后内存绑定已经切走,但群 description 还是旧 sessionId。
//      下次用户在群里发消息时,extractSessionInfo 拿到旧 sessionId,而内存绑定
//      指向新 sessionId,路由完全错乱（参考 /newh 的 corner case 7）。
//
//   3. 改成"先 API 后内存"的顺序后,API 失败就完全不切换内存,下次消息按
//      旧 description 正常路由到旧 session,新创建的 session 留在 sessions.json
//      里成为可清理的 orphan。
//
// 调用方约定：
//   - newSessionId 必须是已经 createSession 完成的真实 session（本函数不创建）
//   - oldSessionId 为 null 表示当前 chat 没有任何旧绑定（比如私聊首次绑）
//   - 私聊跳过 updateChatInfo,直接做内存切换 + registry 持久化
//   - API 失败时：
//       * 不动内存绑定 / sessionInfoMap / displayCards
//       * 返回 { ok: false, error }
//       * 调用方负责把错误反馈给用户
// ---------------------------------------------------------------------------

export interface SwitchChatBindingArgs {
  chatId: string;
  chatType: string;
  oldSessionId: string | null;
  newSessionId: string;
  tool: string;
  /** 群名（私聊忽略） */
  chatName: string;
  /** 群描述（私聊忽略），通常为 `${sessionPrefixForTool(tool)} ${newSessionId}` */
  newDescription: string;
  /** 切换后 sessionInfoMap 的初始 turnCount/lastContextTokens（如沿用历史） */
  initialTurnCount?: number;
  initialContextTokens?: number;
  /** 飞书 updateChatInfo 实现，依赖注入便于测试 mock */
  updateChatInfoFn: (chatId: string, name: string, description: string) => Promise<void>;
}

export interface SwitchChatBindingResult {
  ok: boolean;
  error?: Error;
}

export async function switchChatBinding(args: SwitchChatBindingArgs): Promise<SwitchChatBindingResult> {
  const {
    chatId,
    chatType,
    oldSessionId,
    newSessionId,
    tool,
    chatName,
    newDescription,
    initialTurnCount = 0,
    initialContextTokens = 0,
    updateChatInfoFn,
  } = args;

  // Step 1: 群聊场景先调用飞书 API（不可逆操作放最前）。
  // 私聊跳过——p2p chatId 调 updateChatInfo 必然失败。
  if (chatType !== "p2p") {
    try {
      await updateChatInfoFn(chatId, chatName, newDescription);
    } catch (err) {
      // API 失败：完全不动内存,调用方负责回报用户。
      return { ok: false, error: err as Error };
    }
  }

  // Step 2: API 成功（或私聊跳过）后,原子地切换内存绑定。
  // 这一段全是同步 Map 操作,不会失败。
  if (oldSessionId) {
    unbindChatFromSession(oldSessionId, chatId);
    displayCards.delete(chatId);
    cancelQueuedMessage(oldSessionId);
  }
  bindChatToSession(newSessionId, chatId);
  recordLastActiveChat(newSessionId, chatId);

  const now = Date.now();
  sessionInfoMap.set(chatId, {
    sessionId: newSessionId,
    turnCount: initialTurnCount,
    lastContextTokens: initialContextTokens,
    startTime: now,
    tool,
  });

  // Step 3: 持久化（registry + sessions.json）。
  // 这两步即使失败也不影响内存正确性,下次 prompt 会再写一次。
  await recordSessionRegistry({
    chatId,
    sessionId: newSessionId,
    tool,
    chatType,
    chatName,
    turnCount: initialTurnCount,
    lastContextTokens: initialContextTokens,
    startTime: now,
    running: false,
  });
  await saveSessionTool(newSessionId, tool, chatName);

  return { ok: true };
}

// ---------------------------------------------------------------------------
// AI tool session management
// ---------------------------------------------------------------------------

/**
 * 日志用：把 tool 对应的"配置摘要"格式化为单行字符串。
 * Claude 显示 model/effort（来自环境变量）；Cursor 显示 model（运行时由
 * cursor-agent 决定，初次创建时尚未学习到，故显示占位）。
 */
function formatToolConfigForLog(tool: string, sessionModel?: string, sessionId?: string): string {
  if (tool === "cursor") {
    return `model=${sessionModel ?? "(由 cursor-agent 决定，init 事件后学习)"}`;
  }
  if (tool === "codex") {
    const m = getEffectiveModelForTool(tool, sessionId);
    const e = getEffectiveEffortForTool(tool, sessionId);
    const modelStr = m.trim() !== "" ? m : "(由 codex config.toml 决定)";
    const effortStr = e.trim() !== ""
      ? `effort=${e}`
      : "effort=(由 codex config.toml 决定)";
    return `model=${modelStr}, ${effortStr}, fast=${getEffectiveFastModeForTool(tool, sessionId) ? "on" : "off"}`;
  }
  if (tool === "ccc") {
    const m = getEffectiveModelForTool(tool, sessionId);
    const modelStr = m.trim() !== "" ? m : "(not configured)";
    return `model=${modelStr}, baseURL=${config.ccc.DEEPSEEK_BASE_URL}`;
  }
  return `model=${anthropicConfigDisplay(getModelForSession(sessionId))}, subagentModel=${anthropicConfigDisplay(CLAUDE_SUBAGENT_MODEL)}, effort=${anthropicConfigDisplay(getEffectiveEffortForTool(tool, sessionId))}`;
}

export async function initClaudeSession(tool: string, overrideCwd?: string, chatId?: string): Promise<{ sessionId: string; cwd: string }> {
  const cwd = overrideCwd ?? (await getDefaultCwd(chatId));
  const adapter = getAdapterForTool(tool);
  console.log(
    `[${ts()}] [STEP 1/5] Creating ${adapter.displayName} session (${formatToolConfigForLog(tool)}, cwd=${cwd})`
  );

  // Claude/Cursor 创建会话时需要先等待 SDK/CLI 的 init 事件。它们若在首个
  // 事件前卡死，正式 turn 尚未建立，runAgentSession 的看门狗无法介入。
  // 因此创建入口也使用相同的三分钟阈值，并通过 AbortSignal 释放底层资源。
  const createController = new AbortController();
  let createTimeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutError = new Error(
    `${adapter.displayName} session creation timed out after 3 minutes without an init event`,
  );
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    createTimeout = setTimeout(() => {
      // 先固定对外错误，再 abort 适配器，避免适配器自己的 abort 错误赢得竞态。
      reject(timeoutError);
      createController.abort();
    }, responseStallTimeoutMs);
    createTimeout.unref?.();
  });

  let result: Awaited<ReturnType<ToolAdapter["createSession"]>>;
  try {
    result = await Promise.race([
      adapter.createSession(cwd, createController.signal),
      timeoutPromise,
    ]);
  } finally {
    if (createTimeout) clearTimeout(createTimeout);
  }
  const sessionId = result.sessionId;
  console.log(`[${ts()}]   → sessionId: ${sessionId}`);

  await saveSessionTool(sessionId, tool);

  await addRecentDir(cwd);

  return { sessionId, cwd };
}

export async function resumeAndPrompt(
  sessionId: string,
  userText: string,
  platform: PlatformAdapter,
  chatId: string,
  msgTimestamp: number,
  tool: string,
  traceId?: string,
): Promise<void> {
  return runAgentSession(sessionId, userText, platform, chatId, msgTimestamp, tool, traceId);
}

// ---------------------------------------------------------------------------
// runAgentSession — session 中心的 agent prompt（文件持久化 + display 解耦）
// ---------------------------------------------------------------------------

interface RunAgentSessionOptions {
  /**
   * 标记本轮是 response-stall 后的唯一一次内部续跑。若本轮再次因相同原因
   * 停滞，不再递归创建第三轮，避免服务异常期间无限消耗 token。
   */
  autoRecovery?: boolean;
}

export async function runAgentSession(
  sessionId: string,
  userText: string,
  platform: PlatformAdapter,
  _chatId: string,
  msgTimestamp: number,
  tool: string,
  traceId?: string,
  options: RunAgentSessionOptions = {},
): Promise<void> {
  const tid = traceId ?? "";

  // runAgentSession 是飞书用户消息、队列消息与内部自动恢复共同使用的唯一
  // prompt 执行入口。即使冷启动后的历史群只靠群描述解析出 sessionId、registry
  // 尚未重建出内存映射，也必须在任何异步操作前补齐绑定，确保三种来源都有完全
  // 相同的卡片、状态和收尾行为。
  const previousSessionId = sessionInfoMap.get(_chatId)?.sessionId;
  if (previousSessionId && previousSessionId !== sessionId) {
    unbindChatFromSession(previousSessionId, _chatId);
  }
  bindChatToSession(sessionId, _chatId);

  // 记录用户最后发送消息的群（display loop 只推送到该群）
  // 如果是从队列消费且队列消息来自其他群，保留原来的 display chat
  recordChatPlatform(_chatId, platform);
  recordLastActiveChat(sessionId, consumeQueuePreservedChat(sessionId) ?? _chatId);

  // 并发检查：同一 session 只能有一个活跃 prompt
  if (activePrompts.has(sessionId)) {
    if (tid) logTrace(tid, "BLOCKED", { outcome: "session_busy", sessionId });
    console.log(`[${ts()}] [BLOCKED] Session ${sessionId} is already generating`);
    const isWechatBusy = platform.kind === "wechat";
    const busyMsg = isWechatBusy
      ? "当前正在生成回复中，请等待完成后再发送消息。也可以发送 /stop 结束，已完成的步骤不会丢失。"
      : "该会话正在生成回复中，请等待完成后再发送消息。也可以发送 /stop 结束，已完成的步骤不会丢失。";
    await platform.sendText(_chatId, busyMsg).catch(() => {});
    return;
  }

  // 立即标记活跃，确保 /sessions、isSessionRunning 等查询在异步准备阶段就能看到运行状态。
  // 注意：下面的 try/catch 在准备失败时会清理 activePrompts。
  const controller = new AbortController();
  const now = Date.now();
  activePrompts.set(sessionId, {
    controller,
    stopped: false,
    startTime: now,
    autoRecovery: options.autoRecovery === true,
    finalResponseObserved: false,
  });

  // 资源监控僵死检测：CPU + 内存连续 3 分钟无变化 → 强制停止
  const onResourceStuck = (data: { pid: number; sessionId: string; idleMinutes: number }) => {
    if (data.sessionId !== sessionId) return;
    const prompt = activePrompts.get(sessionId);
    if (!prompt || prompt.stopped || prompt.abnormalExit || prompt.resourceStuck || prompt.autoEnded) return;
    prompt.resourceStuck = true;

    const chatId = pickDisplayChat(sessionId) ?? getLastActiveChat(sessionId) ?? getChatsForSession(sessionId)[0];
    const p = chatId ? platformForChat(chatId) : null;
    if (chatId && p) {
      p.sendText(
        chatId,
        `⚠️ 会话僵死：session ${sessionId.slice(0, 8)} 对应的 CLI 进程 PID ${data.pid} CPU 和内存连续 ${data.idleMinutes} 分钟无变化，已强制停止。若回复不完整，请重新发送上一条指令。`,
      ).catch(() => {});
    }

    controller.abort();
  };
  resourceMonitor.on("stuck", onResourceStuck);

  // 异步准备工作（session info、IM skills prompt 等）
  let adapter: ToolAdapter;
  let info: Awaited<ReturnType<ToolAdapter["getSessionInfo"]>>;
  let cwd: string;
  try {
    adapter = getAdapterForTool(tool, sessionId);
    info = await adapter.getSessionInfo(sessionId);
    cwd = info?.cwd ?? (await getDefaultCwd(_chatId));
    if (tid) logTrace(tid, "SESSION_START", { sessionId, tool, cwd, turn: (sessionInfoMap.get(_chatId)?.turnCount ?? 0) + 1 });
    console.log(
      `[${ts()}] Running ${adapter.displayName} session: ${sessionId} (${formatToolConfigForLog(tool, info?.model, sessionId)}, cwd=${cwd})`
    );

    // 构建 IM skills prompt（sessionId 方式，无 token）
    const feishuSkillDir = join(PROJECT_ROOT, "im-skills", "feishu-skill");
    const wechatImageSkillDir = join(PROJECT_ROOT, "im-skills", "wechat-image-skill");
    const wechatFileSkillDir = join(PROJECT_ROOT, "im-skills", "wechat-file-skill");
    const wechatVideoSkillDir = join(PROJECT_ROOT, "im-skills", "wechat-video-skill");
    const imSkillsCacheDir = join(USER_DATA_DIR, "im-skills");
    const skillVariables = {
      cwd,
      session_id: sessionId,
      im_skills_cache_dir: imSkillsCacheDir,
      delegate_task_url: `http://127.0.0.1:${CHATCCC_PORT}/api/agent/delegate-task`,
      send_image_url: `http://127.0.0.1:${CHATCCC_PORT}/api/agent/send-image`,
      send_file_url: `http://127.0.0.1:${CHATCCC_PORT}/api/agent/send-file`,
      send_image_script: join(feishuSkillDir, "send-image.mjs"),
      send_file_script: join(feishuSkillDir, "send-file.mjs"),
      download_video_script: join(feishuSkillDir, "download-video.mjs"),
      wechat_send_image_script: join(wechatImageSkillDir, "send-image.mjs"),
      wechat_send_file_script: join(wechatFileSkillDir, "send-file.mjs"),
      wechat_send_video_script: join(wechatVideoSkillDir, "send-video.mjs"),
    };
    const enabledSkillNames = imSkillNamesForPlatform(platform);
    var imSkillsPrompt = await buildImSkillsPromptCached({ variables: skillVariables, enabledSkillNames });
    await exportSkillSubDocs({ variables: skillVariables, enabledSkillNames }, imSkillsCacheDir);
    var userTextWithCapabilities = [
      ...(imSkillsPrompt ? [imSkillsPrompt, ""] : []),
      "[User message]",
      userText,
      "[/User message]",
    ].join("\n");
  } catch (preambleErr) {
    // 准备工作失败，清理活跃标记，避免"僵尸"活跃状态阻塞后续消息
    activePrompts.delete(sessionId);
    throw preambleErr;
  }

  // 更新 sessionInfoMap（所有绑定群共用）
  const existingInfo = sessionInfoMap.get(_chatId);
  const nextTurnCount = (existingInfo?.turnCount ?? 0) + 1;
  const nextContextTokens = existingInfo?.lastContextTokens ?? 0;
  // 对所有绑定的 chatId 更新 sessionInfoMap
  for (const cid of getChatsForSession(sessionId)) {
    const ei = sessionInfoMap.get(cid);
    sessionInfoMap.set(cid, {
      sessionId,
      turnCount: nextTurnCount,
      lastContextTokens: nextContextTokens,
      startTime: now,
      tool,
    });
  }
  // 确保触发群也在 map 中
  if (!sessionInfoMap.has(_chatId)) {
    sessionInfoMap.set(_chatId, {
      sessionId,
      turnCount: nextTurnCount,
      lastContextTokens: nextContextTokens,
      startTime: now,
      tool,
    });
  }

  await recordSessionRegistry({
    chatId: _chatId,
    sessionId,
    tool,
    turnCount: nextTurnCount,
    lastContextTokens: nextContextTokens,
    startTime: now,
    running: true,
  });

  // 在覆盖 stream state 前，先终结上一轮的展示卡片并发送最终回复。
  // 竞态根因：上一轮 finally 写入 "done" 状态后，200ms setTimeout 即启动
  // 新一轮 runAgentSession，立即覆盖为 "running" 状态并 kill 旧 display
  // loop。旧 loop 的 3s 间隔 tick 只有约 6.7% 概率在 200ms 窗口内命中，
  // 导致 finalReply 丢失、完成卡片空白。此处主动读取上一轮终端状态完成
  // 卡片终结和回复发送，不依赖 display loop 时序，保证"先发完上一个回答
  // 再开始缓存问题对应的任务"。
  const prevState = await readStreamState(sessionId);
  if (prevState && prevState.status !== "running") {
    const prevTerminalReply = formatTerminalReply(prevState.status, prevState.finalReply);
    const displayChatId = pickDisplayChat(sessionId);
    if (displayChatId) {
      const pp = platformForChat(displayChatId);
      const display = displayCards.get(displayChatId);

      if (display && pp) {
        // 统一 display loop 被 cardBusy 挡住或尚未 tick → 现在终结卡片
        while (display.cardBusy) await new Promise(r => setTimeout(r, 20));

        // 竞态防护：等待期间统一 display loop 的 tick 可能也已读到同一个
        // terminal state，发送了 finalReply 并删除/替换了 displayCards 条目。
        // 通过引用比较检测——若统一 loop 已处理则只补持久化和头像，不重复发。
        if (displayCards.get(displayChatId) !== display) {
          const finalStatus = turnFinalStatus(prevState.status);
          finalizeTurnCards(sessionId, prevState.turnCount, finalStatus).catch(() => {});
          pp.setChatAvatar(displayChatId, prevState.tool, "idle").catch(() => {});
        } else {
          const nextSeq = display.sequence + 1;
          const { title: headerTitle, template: headerTemplate } = formatTerminalHeader(prevState.status);
          const cardContent = truncateContent(prevState.accumulatedContent + prevState.finalReply) || " ";
          const doneCard = buildProgressCard(cardContent, { showStop: false, headerTitle, headerTemplate });
          await pp.cardUpdate(display.cardId, doneCard, nextSeq).catch(err => {
            console.error(`[${ts()}] [DISPLAY] prevState final cardUpdate failed: ${(err as Error).message}`);
          });
          // cardUpdate IO 期间统一 loop 可能也已处理此 display → 删前检查引用
          const stillOursAfterUpdate = displayCards.get(displayChatId) === display;
          displayCards.delete(displayChatId);

          // 持久化：标记上一轮所有卡片为终态
          const finalStatus = turnFinalStatus(prevState.status);
          finalizeTurnCards(sessionId, prevState.turnCount, finalStatus).catch(() => {});

          if (prevTerminalReply && stillOursAfterUpdate && !isFinalReplySentForTurn(prevState)) {
            await sendFinalReplyTextOnce(pp, displayChatId, sessionId, prevState.turnCount, prevTerminalReply);
          }
          pp.setChatAvatar(displayChatId, prevState.tool, "idle").catch(() => {});
        }
      } else if (pp && prevTerminalReply && !isFinalReplySentForTurn(prevState)) {
        // 无 display 记录但上一轮有 finalReply（极快轮次），至少发送
        const finalStatus = turnFinalStatus(prevState.status);
        finalizeTurnCards(sessionId, prevState.turnCount, finalStatus).catch(() => {});
        await sendFinalReplyTextOnce(pp, displayChatId, sessionId, prevState.turnCount, prevTerminalReply);
      }
      // else: displayCards 无记录且无 finalReply → 无需处理
    }
  }

  // 初始化 stream-state.json
  const initialState = createEmptyStreamState(sessionId, cwd, tool, nextTurnCount);
  const activityTracker = createAgentActivityTracker(initialState.activity?.startedAt ?? Date.now());
  await writeStreamState(initialState);

  // 为新 turn 创建第一张展示卡片，同时注册到 turn-cards 持久化。
  // 统一 display loop 始终运行，卡片创建后下一个 tick 即自动开始更新。
  const displayChatIdForNew = pickDisplayChat(sessionId);
  if (displayChatIdForNew) {
    const ppNew = platformForChat(displayChatIdForNew);
    if (ppNew && ppNew.kind !== "wechat") {
      const initialHeaderTitle = formatAgentActivityTitle(activityTracker.activity);
      const cardId = await createVisibleProgressCard(
        ppNew,
        displayChatIdForNew,
        sessionId,
        nextTurnCount,
        "生成中卡片发送失败，结果将以文本形式发送。",
        initialHeaderTitle,
      );
      if (cardId) {
        displayCards.set(displayChatIdForNew, {
          cardId,
          sequence: 1,
          cardBusy: false,
          cardCreatedAt: Date.now(),
          lastSentContent: "",
          lastSentHeaderTitle: initialHeaderTitle,
          streamErrorNotified: false,
          sessionId,
          turnCount: nextTurnCount,
          dotCount: 0,
        });
      }
    } else if (ppNew && ppNew.kind === "wechat") {
      // WeChat: 无卡片，但需要 display entry 追踪已发送内容
      displayCards.set(displayChatIdForNew, {
        cardId: "",
        sequence: 0,
        cardBusy: false,
        cardCreatedAt: Date.now(),
        lastSentContent: "",
        streamErrorNotified: false,
        sessionId,
        turnCount: nextTurnCount,
        dotCount: 0,
      });
    }
  }

  // 设置最后活跃群头像为 busy
  const activeCid = getLastActiveChat(sessionId) ?? getChatsForSession(sessionId)[0];
  if (activeCid) {
    platform.setChatAvatar(activeCid, tool, "busy").catch(() => {});
  }

  const state: AccumulatorState = {
    accumulatedContent: "",
    finalText: "",
    finalCompleteText: "",
    chunkCount: 0,
  };

  let lastFileWrite = Date.now();
  const FILE_WRITE_INTERVAL_MS = 2000;
  const toolCallMap = new Map<string, { name: string; input: unknown }>();
  let streamErrored = false;

  const runningPrompt = activePrompts.get(sessionId);
  if (runningPrompt) {
    // 必须在消费第一个事件前建立零字符基线。部分 CLI 卡死时只启动了进程，
    // 甚至一个事件都不会 yield；若等循环体更新进度，这种会话会永久停在
    // “正在启动 Agent”，也永远触发不了三分钟保护。
    runningPrompt.responseProgress = observeResponseProgress(
      undefined,
      true,
      0,
      activityTracker.activity.startedAt,
    );

    const checkResponseStall = async () => {
      const current = activePrompts.get(sessionId);
      if (!current || current !== runningPrompt) {
        clearPromptResponseStallMonitor(sessionId);
        return;
      }
      if (
        current.stopped
        || current.abnormalExit
        || current.resourceStuck
        || current.autoEnded
        || current.finalResponseObserved
        || !monitorsOutputProgress(activityTracker.activity.kind)
        || !hasResponseStalled(current.responseProgress, Date.now(), responseStallTimeoutMs)
      ) {
        return;
      }

      const autoEndedAt = Date.now();
      // 普通轮第一次因回复停滞结束时，立即预约同 session 的内部续跑。
      // 预约先于 abort/收尾建立，isSessionRunning 会在整个交接窗口保持 true，
      // 因此恰好到达的用户消息只能排队，绝不可能抢在恢复 prompt 前。
      // 若当前已经是恢复轮，则不再预约第三轮。
      if (!current.autoRecovery) {
        reserveAutoRecovery(sessionId);
      }
      current.autoEnded = true;
      current.autoEndedAt = autoEndedAt;
      clearPromptResponseStallMonitor(sessionId);
      clearPromptProcessMonitor(sessionId);

      // First publish an atomic terminal state so the card cannot keep claiming the
      // Agent is running while process cleanup is underway.
      await writeStreamState({
        sessionId,
        status: "auto_ended",
        accumulatedContent: state.accumulatedContent,
        finalReply: pickFinalReply(state).trim(),
        activity: activityTracker.activity,
        chunkCount: state.chunkCount,
        turnCount: nextTurnCount,
        contextTokens: existingInfo?.lastContextTokens ?? 0,
        updatedAt: autoEndedAt,
        cwd,
        tool,
        autoEndedAt,
      });

      // 最终事件可能在上面的落盘 I/O 期间到达。只有适配器明确标记的完整
      // final response 才能赢得这场竞态；普通文本片段绝不能取消超时。
      if (current.finalResponseObserved) {
        current.autoEnded = false;
        current.autoEndedAt = undefined;
        cancelAutoRecoveryReservation(sessionId);
        console.log(
          `[${ts()}] [RESPONSE-STALL] Authoritative final response won timeout race for ${sessionId}`,
        );
        return;
      }

      try {
        current.closeSession?.();
      } catch (err) {
        console.warn(`[${ts()}] [RESPONSE-STALL] closeSession failed for ${sessionId}: ${(err as Error).message}`);
      }
      current.controller.abort();
      await killProcessTree(current.processPid);
      console.warn(
        `[${ts()}] [RESPONSE-STALL] Session ${sessionId} auto-ended after 3 minutes without startup or reply progress`,
      );
    };

    const responseStallMonitor = setInterval(() => {
      void checkResponseStall().catch((err) => {
        console.warn(`[${ts()}] [RESPONSE-STALL] check failed for ${sessionId}: ${(err as Error).message}`);
      });
    }, responseStallCheckIntervalMs);
    responseStallMonitor.unref?.();
    runningPrompt.responseStallMonitor = responseStallMonitor;
  }

  try {
    for await (const unifiedMsg of adapter.prompt(sessionId, userTextWithCapabilities, cwd, controller.signal, {
      onProcessStart: (processInfo) => {
        startPromptProcessMonitor(sessionId, processInfo);
        if (processInfo.pid !== undefined) registerProcess(processInfo.pid, sessionId);
      },
      onProcessExit: (exitInfo) => {
        clearPromptProcessMonitor(sessionId);
        if (exitInfo.pid !== undefined) unregisterProcess(exitInfo.pid);
      },
      onSessionCreated: (closeSession) => {
        const prompt = activePrompts.get(sessionId);
        if (prompt) prompt.closeSession = closeSession;
      },
    })) {
      if (unifiedMsg.isFinalResponse) {
        const prompt = activePrompts.get(sessionId);
        if (prompt && prompt === runningPrompt) {
          // 同步标记必须发生在任何 await 之前，让 watchdog 无法在已收到完整
          // 最终事件后仍把本轮判为停滞。
          if (!prompt.finalResponseObserved) {
            prompt.finalResponseObserved = true;
            scheduleFinalResponseCloseGuard(sessionId, prompt);
          }
        }
      }

      let activityChanged = false;
      for (const block of unifiedMsg.blocks) {
        if (updateAgentActivity(activityTracker, block)) activityChanged = true;
        accumulateBlockContent(block, state, toolCallMap);

        if (block.type === "compact_boundary" && block.post_tokens) {
          for (const cid of getChatsForSession(sessionId)) {
            const sinfo = sessionInfoMap.get(cid);
            if (sinfo) sinfo.lastContextTokens = block.post_tokens;
          }
          await recordSessionRegistry({
            chatId: _chatId,
            sessionId,
            tool,
            lastContextTokens: block.post_tokens,
            running: true,
          });
        }
      }

      const prompt = activePrompts.get(sessionId);
      if (prompt && !prompt.autoEnded) {
        const totalChars = state.accumulatedContent.length + pickFinalReply(state).length;
        prompt.responseProgress = observeResponseProgress(
          // starting → responding 本身是一次有效进展，即便首个文本块仍为空也应
          // 重新计时；其它活动阶段会清空观察窗口。
          activityChanged ? undefined : prompt.responseProgress,
          monitorsOutputProgress(activityTracker.activity.kind),
          totalChars,
          Date.now(),
        );
      }

      // 定时写入文件
      const now2 = Date.now();
      if (activityChanged || now2 - lastFileWrite >= FILE_WRITE_INTERVAL_MS) {
        lastFileWrite = now2;
        await writeStreamState({
          sessionId,
          status: "running",
          accumulatedContent: state.accumulatedContent,
          finalReply: pickFinalReply(state),
          activity: activityTracker.activity,
          chunkCount: state.chunkCount,
          turnCount: nextTurnCount,
          contextTokens: existingInfo?.lastContextTokens ?? 0,
          updatedAt: now2,
          cwd,
          tool,
        });
      }
    }
  } catch (streamErr) {
    streamErrored = true;
    console.error(`[${ts()}] [STREAM] Error in stream loop for ${sessionId}: ${(streamErr as Error).message}`);
  } finally {
    // 标记 prompt 结束
    resourceMonitor.off("stuck", onResourceStuck);
    const prompt = activePrompts.get(sessionId);
    const wasStopped = prompt?.stopped ?? false;
    const wasAbnormalExit = prompt?.abnormalExit ?? false;
    const wasResourceStuck = prompt?.resourceStuck ?? false;
    const timeoutTriggered = prompt?.autoEnded ?? false;
    const completedAtTimeoutBoundary =
      timeoutTriggered && (prompt?.finalResponseObserved ?? false);
    const wasAutoEnded = timeoutTriggered && !completedAtTimeoutBoundary;
    const wasAutoRecovery = prompt?.autoRecovery ?? false;
    const autoEndedAt = wasAutoEnded ? prompt?.autoEndedAt : undefined;
    clearPromptResponseStallMonitor(sessionId);
    clearPromptProcessMonitor(sessionId);
    clearPromptFinalResponseCloseTimer(sessionId);
    markSessionFinalizing(sessionId);
    activePrompts.delete(sessionId);

    try {
      if (completedAtTimeoutBoundary) {
        // reservation 可能在 watchdog 开始终止普通轮时已经建立。最终回复若在
        // abort/kill 清理边界到达，本轮按完成处理，并原子取消尚未启动的恢复轮。
        cancelAutoRecoveryReservation(sessionId);
        console.log(
          `[${ts()}] [RESPONSE-STALL] Session ${sessionId} completed with an authoritative final response during timeout cleanup`,
        );
      }
      // 即使运行期间映射被异常清空，也必须更新本次实际触发 chat，避免 registry
      // 永久残留 running=true。
      const finalizationChatIds = [...new Set([
        ...getChatsForSession(sessionId),
        _chatId,
      ])];
      // 先写最终状态（done/stopped），确保 display loop 在下一轮消费前
      // 读到新状态并终结旧卡片。否则 setImmediate 在 CHECK 阶段先于
      // writeFile I/O（POLL 阶段）执行，display loop 会误以为旧轮仍在
      // 运行中并更新旧卡片，而不是新建卡片。
      const finalStatus = completedAtTimeoutBoundary
        ? "done"
        : wasAutoEnded
          ? "auto_ended"
          : (streamErrored || wasAbnormalExit || wasResourceStuck)
            ? "error"
            : wasStopped
              ? "stopped"
              : "done";
      const finalReply = pickFinalReply(state).trim();

    // stop-stuck-loop 接口可能在 fire-and-forget 中已写入带 final_reply 的
    // stream state，finally 不应覆盖它。同时保留 stuckAt 标记，防止
    // stop-stuck-loop 结束后 session 被错误恢复。
    let finalReplyToWrite = finalReply;
    let preserveStuckAt: number | undefined;
    try {
      const existing = await readStreamState(sessionId);
      if (existing) {
        if (existing.finalReply.length > finalReply.length) {
          finalReplyToWrite = existing.finalReply;
        }
        preserveStuckAt = existing.stuckAt;
      }
    } catch {}

    await writeStreamState({
      sessionId,
      status: finalStatus,
      accumulatedContent: state.accumulatedContent,
      finalReply: finalReplyToWrite,
      activity: activityTracker.activity,
      chunkCount: state.chunkCount,
      turnCount: nextTurnCount,
      contextTokens: existingInfo?.lastContextTokens ?? 0,
      updatedAt: Date.now(),
      cwd,
      tool,
      ...(preserveStuckAt ? { stuckAt: preserveStuckAt } : {}),
      ...(autoEndedAt !== undefined ? { autoEndedAt } : {}),
    });

    // display loop 下一轮会读到最终状态并发送消息

    let autoRecoveryTarget: { chatId: string; platform: PlatformAdapter } | undefined;

    if (wasStopped) {
      for (const cid of finalizationChatIds) {
        const finfo = sessionInfoMap.get(cid);
        await recordSessionRegistry({
          chatId: cid,
          sessionId,
          tool,
          turnCount: finfo?.turnCount ?? nextTurnCount,
          lastContextTokens: finfo?.lastContextTokens ?? nextContextTokens,
          startTime: finfo?.startTime ?? now,
          running: false,
        });
      }
      const active1 = getLastActiveChat(sessionId) ?? finalizationChatIds[0];
      if (active1) {
        await platform.sendText(active1, "会话已停止。").catch(() => {});
        platform.setChatAvatar(active1, tool, "idle").catch(() => {});
      }
      console.log(`[${ts()}] Session ${sessionId} stopped (content chunks: ${state.chunkCount})`);
      if (tid) logTrace(tid, "SESSION_END", { sessionId, outcome: "stopped", chunks: state.chunkCount });
    } else if (wasAutoEnded) {
      for (const cid of finalizationChatIds) {
        const finfo = sessionInfoMap.get(cid);
        await recordSessionRegistry({
          chatId: cid,
          sessionId,
          tool,
          turnCount: finfo?.turnCount ?? nextTurnCount,
          lastContextTokens: finfo?.lastContextTokens ?? nextContextTokens,
          startTime: finfo?.startTime ?? now,
          running: false,
        });
      }
      const activeAutoEnded = getLastActiveChat(sessionId) ?? finalizationChatIds[0];
      if (activeAutoEnded) {
        const pp = platformForChat(activeAutoEnded) ?? platform;
        const terminalState = await readStreamState(sessionId);
        if (!displayCards.has(activeAutoEnded) && (!terminalState || !isFinalReplySentForTurn(terminalState))) {
          await sendFinalReplyTextOnce(
            pp,
            activeAutoEnded,
            sessionId,
            nextTurnCount,
            formatAutoEndedReply(finalReplyToWrite),
          );
        }
        pp.setChatAvatar(activeAutoEnded, tool, "idle").catch(() => {});

        if (wasAutoRecovery) {
          // 这是紧接第一次停滞而启动的恢复轮；再次发生相同停滞即终止
          // 自动链，避免第三轮及之后的无限续跑。
          await pp.sendText(
            activeAutoEnded,
            RESPONSE_STALL_RECOVERY_EXHAUSTED_NOTICE,
          ).catch(() => {});
        } else if (hasAutoRecoveryReservation(sessionId)) {
          // 用户可见提示与内部恢复 prompt 分离：提示发送失败不影响恢复，
          // 内部恢复仍由 reservation 保证先于普通缓存消息。
          await pp.sendText(
            activeAutoEnded,
            RESPONSE_STALL_RECOVERY_NOTICE,
          ).catch(() => {});
          autoRecoveryTarget = { chatId: activeAutoEnded, platform: pp };
        }
      }
      console.warn(`[${ts()}] Session ${sessionId} auto-ended after stalled startup or response output (content chunks: ${state.chunkCount})`);
      if (tid) logTrace(tid, "SESSION_END", { sessionId, outcome: "response_stall", chunks: state.chunkCount });
    } else if (wasAbnormalExit) {
      for (const cid of finalizationChatIds) {
        const finfo = sessionInfoMap.get(cid);
        await recordSessionRegistry({
          chatId: cid,
          sessionId,
          tool,
          turnCount: finfo?.turnCount ?? nextTurnCount,
          lastContextTokens: finfo?.lastContextTokens ?? nextContextTokens,
          startTime: finfo?.startTime ?? now,
          running: false,
        });
      }
      const activeErr = getLastActiveChat(sessionId) ?? finalizationChatIds[0];
      if (activeErr) platform.setChatAvatar(activeErr, tool, "idle").catch(() => {});
      console.log(`[${ts()}] Session ${sessionId} process exited unexpectedly (content chunks: ${state.chunkCount})`);
      if (tid) logTrace(tid, "SESSION_END", { sessionId, outcome: "process_missing", chunks: state.chunkCount });
    } else {
      for (const cid of finalizationChatIds) {
        const finfo = sessionInfoMap.get(cid);
        await recordSessionRegistry({
          chatId: cid,
          sessionId,
          tool,
          turnCount: finfo?.turnCount ?? nextTurnCount,
          lastContextTokens: finfo?.lastContextTokens ?? nextContextTokens,
          startTime: finfo?.startTime ?? now,
          running: false,
        });
      }
      const active2 = getLastActiveChat(sessionId) ?? finalizationChatIds[0];
      if (active2) {
        const terminalState = await readStreamState(sessionId);
        if (finalReply && !displayCards.has(active2) && (!terminalState || !isFinalReplySentForTurn(terminalState))) {
          const pp = platformForChat(active2) ?? platform;
          await sendFinalReplyTextOnce(pp, active2, sessionId, nextTurnCount, finalReply);
        }
        platform.setChatAvatar(active2, tool, "idle").catch(() => {});
      }
      console.log(`[${ts()}] Session ${sessionId} stream complete (content chunks: ${state.chunkCount})`);
      if (tid) logTrace(tid, "SESSION_END", { sessionId, chunks: state.chunkCount, finalTextLen: finalReply.length });
    }

    // 失去聊天绑定时无法安全选择恢复轮的展示目标，取消本次进程内预约。
    if (
      wasAutoEnded
      && hasAutoRecoveryReservation(sessionId)
      && !autoRecoveryTarget
    ) {
      cancelAutoRecoveryReservation(sessionId);
    }
    const shouldScheduleAutoRecovery =
      autoRecoveryTarget !== undefined
      && hasAutoRecoveryReservation(sessionId);

    // 必须等本轮最终卡片、registry 和头像全部收尾后再取出并调度队列消息。
    // 在收尾期间新到达的消息也会因 finalizingSessions 被正确排入这里。
    let queuedForConsumption: ReturnType<typeof dequeueMessage> = undefined;
    if (wasStopped) {
      const discarded = dequeueMessage(sessionId);
      if (discarded) {
        console.log(`[${ts()}] [QUEUE] Discarding queued message for stopped session ${sessionId}`);
      }
    } else if (!shouldScheduleAutoRecovery) {
      // 第一次 response-stall 后保留普通缓存；恢复轮结束后由恢复轮的
      // finally 再消费，顺序固定为“自动恢复 → 用户缓存”。
      queuedForConsumption = dequeueMessage(sessionId);
    }

    if (queuedForConsumption) {
      const queued = queuedForConsumption;
      // 队列消息可能来自其他群，保存当前 display chat 避免 display loop 被
      // 错误重定向（runAgentSession 会 consumeQueuePreservedChat 并在存在时
      // 用保存的 chat 替代 queued.chatId 作为 display 目标）。
      const preservedChat = getLastActiveChat(sessionId);
      if (preservedChat && preservedChat !== queued.chatId) {
        setQueuePreservedChat(sessionId, preservedChat);
      }
      console.log(`[${ts()}] [QUEUE] Consuming queued message for session ${sessionId}: "${queued.text.slice(0, 50)}"`);
      // setTimeout 而非 setImmediate：给 display loop 的 setInterval
      // 足够时间读到最终状态并终结旧卡片，避免新轮更新旧卡片。
      setTimeout(() => {
        consumeQueuedMessage(platform, queued);
      }, RESPONSE_STALL_RECOVERY_DELAY_MS);
    }

    if (shouldScheduleAutoRecovery && autoRecoveryTarget) {
      const target = autoRecoveryTarget;
      console.log(
        `[${ts()}] [RESPONSE-STALL] Reserved automatic recovery for session ${sessionId}`,
      );
      // 延迟与普通队列原有策略一致，让上一轮终态先完成展示。reservation
      // 在定时器等待期间仍令 isSessionRunning=true；调用 runAgentSession
      // 时会在首次 await 前同步写入 activePrompts，然后才消费 reservation，
      // 因而不存在普通用户消息可插入的事件循环空窗。
      setTimeout(() => {
        if (!hasAutoRecoveryReservation(sessionId)) return;
        const recoveryRun = runAgentSession(
          sessionId,
          RESPONSE_STALL_RECOVERY_PROMPT,
          target.platform,
          target.chatId,
          Date.now(),
          tool,
          undefined,
          { autoRecovery: true },
        );
        consumeAutoRecoveryReservation(sessionId);
        void recoveryRun.catch((err) => {
          console.error(
            `[${ts()}] [RESPONSE-STALL] Automatic recovery failed for ${sessionId}: ${(err as Error).message}`,
          );
          target.platform.sendText(
            target.chatId,
            `⚠️ 自动续跑启动失败：${(err as Error).message}`,
          ).catch(() => {});

          // 若恢复轮在进入主 stream try/finally 前即准备失败，它不会自然
          // 消费此前保留的用户缓存；在错误回调中补做一次，避免队列悬挂。
          const queued = dequeueMessage(sessionId);
          if (queued) {
            consumeQueuedMessage(target.platform, queued);
          }
        });
      }, RESPONSE_STALL_RECOVERY_DELAY_MS);
    }
    } finally {
      clearSessionFinalizing(sessionId);
    }
  }
}

// ---------------------------------------------------------------------------
// startUnifiedDisplayLoop — 全局统一 display 循环，遍历 displayCards 更新卡片
// ---------------------------------------------------------------------------
// 替代旧的 per-session ensureDisplayLoop，消除 kill/restart 竞态条件。
// 单一定时器遍历所有 displayCards 条目，通过条目内的 sessionId 查找 stream state。
// ---------------------------------------------------------------------------

const CARD_ROTATE_MS = 9 * 60 * 1000;

export function startUnifiedDisplayLoop(): void {
  if (unifiedDisplayLoopHandle !== null) return;

  let tickRunning = false;
  const interval = setInterval(() => {
    void (async () => {
      if (tickRunning) return;
      tickRunning = true;
      try {
        for (const [chatId, display] of displayCards) {
          if (display.cardBusy) continue;

          const sessionId = display.sessionId;
          const state = await readStreamState(sessionId);
          if (!state) {
            displayCards.delete(chatId);
            continue;
          }

        // 交叉验证：chat 当前绑定的 session 是否仍是 display 记录的 session。
        // 若 chat 已被切换到其他 session（如 /newh），旧 display 必须停推。
        const currentSessionForChat = sessionInfoMap.get(chatId)?.sessionId;
        if (currentSessionForChat && currentSessionForChat !== sessionId) {
          if (state.status !== "running") {
            displayCards.delete(chatId);
          }
          continue;
        }

        // 验证 chat 仍是该 session 的最后活跃群
        const lastActive = getLastActiveChat(sessionId);
        if (lastActive !== chatId) {
          if (state.status !== "running") {
            displayCards.delete(chatId);
          }
          continue;
        }

        const isTerminal = state.status !== "running";

        try {
          const p = platformForChat(chatId);
          if (!p) continue;

          const isWechat = p.kind === "wechat";

          if (isTerminal) {
            if (isWechat) {
              const prevAccLen = display.lastSentAccLen ?? 0;
              const prevFinalReply = display.lastSentFinalReply ?? "";
              const accDelta = state.accumulatedContent.slice(prevAccLen);
              let replyDelta: string;
              if (prevFinalReply && state.finalReply.startsWith(prevFinalReply)) {
                replyDelta = state.finalReply.slice(prevFinalReply.length);
              } else {
                replyDelta = state.finalReply;
              }
              const remaining = (accDelta + replyDelta).trim();

              // 若 session 仍在 activePrompts 中，说明 runAgentSession 的 finally
              // 还没执行，当前 stream state 可能是 stopSession fire-and-forget
              // 写入的，finalReply 滞后于内存态。跳过发送，等 finally 落盘后
              // 下一次 tick 再处理，避免发送过期内容或与后续发送重复。
              if (activePrompts.has(sessionId)) continue;

              const tail = "━━━ 回答结束 ━━━";
              const finalMsg = state.status === "auto_ended"
                ? formatAutoEndedReply(remaining)
                : remaining
                  ? remaining + "\n" + tail
                  : tail;
              if (!isFinalReplySentForTurn(state)) {
                await sendFinalReplyTextOnce(p, chatId, sessionId, state.turnCount, finalMsg);
              }
              displayCards.delete(chatId);
            } else {
              // 发送最终结果（卡片平台）
              while (display.cardBusy) await new Promise(r => setTimeout(r, 20));
              const promptStillActive = activePrompts.has(sessionId);
              if (
                promptStillActive &&
                display.lastSentAccLen === state.accumulatedContent.length &&
                display.lastSentFinalReply === state.finalReply
              ) {
                continue;
              }
              const terminalCardAlreadyUpdated =
                display.lastSentAccLen === state.accumulatedContent.length &&
                display.lastSentFinalReply === state.finalReply;
              let terminalCardUpdateAccepted = terminalCardAlreadyUpdated;
              if (!terminalCardAlreadyUpdated) {
                const nextSeq = display.sequence + 1;
                const { title: headerTitle, template: headerTemplate } = formatTerminalHeader(state.status);
                const cardContent = truncateContent(state.accumulatedContent + state.finalReply) || " ";
                const doneCard = buildProgressCard(cardContent, { showStop: false, headerTitle, headerTemplate });
                await p.cardUpdate(display.cardId, doneCard, nextSeq).then(() => {
                  display.sequence = nextSeq;
                  terminalCardUpdateAccepted = true;
                }).catch(err => {
                  console.error(`[${ts()}] [DISPLAY] terminal cardUpdate failed: ${(err as Error).message}`);
                  if (isCardKitSequenceConflict(err)) {
                    display.sequence = nextSeq;
                    terminalCardUpdateAccepted = true;
                  }
                });
                if (terminalCardUpdateAccepted) {
                  display.lastSentAccLen = state.accumulatedContent.length;
                  display.lastSentFinalReply = state.finalReply;
                }
              }

              // 若 session 仍在 activePrompts 中，说明 runAgentSession 的 finally
              // 还没执行，当前 stream state 可能是 stopSession fire-and-forget
              // 写入的，finalReply 滞后于内存态。卡片已更新为终态外观，但不发送
              // 文本、不删除 display 条目，留给 finally 落盘后的下一次 tick 处理。
              if (promptStillActive) {
                continue;
              }

              let terminalTextDelivered = true;
              const terminalReply = formatTerminalReply(state.status, state.finalReply);
              if (terminalReply) {
                if (!isFinalReplySentForTurn(state)) {
                  terminalTextDelivered = await sendFinalReplyTextOnce(p, chatId, sessionId, state.turnCount, terminalReply);
                }
              } else if (state.accumulatedContent.trim()) {
                const short = truncateContent(state.accumulatedContent, 30, 4000);
                terminalTextDelivered = await p.sendText(chatId, `[生成过程]\n${short}`).then((ok) => ok !== false).catch(() => false);
              }

              if (!terminalTextDelivered) {
                console.error(`[${ts()}] [DISPLAY] terminal text send failed, keep display for retry: chatId=${chatId} session=${sessionId} turn=${state.turnCount}`);
                continue;
              }

              const finalSt = turnFinalStatus(state.status);
              finalizeTurnCards(sessionId, state.turnCount, finalSt).catch(() => {});
              displayCards.delete(chatId);
            }
            p.setChatAvatar(chatId, state.tool, "idle").catch(() => {});
            console.log(`[${ts()}] [DISPLAY] unified loop deleted display for ${chatId} (terminal: ${state.status})`);
          } else {
            // running: 创建或更新展示
            if (isWechat) {
              // WeChat: 不使用卡片，基于 agent 真实 delta 推送 raw content
              const prevAccLen = display.lastSentAccLen ?? 0;
              const prevFinalReply = display.lastSentFinalReply ?? "";
              const accDelta = state.accumulatedContent.slice(prevAccLen);
              let replyDelta: string;
              if (prevFinalReply && state.finalReply.startsWith(prevFinalReply)) {
                replyDelta = state.finalReply.slice(prevFinalReply.length);
              } else {
                replyDelta = state.finalReply;
              }
              const delta = (accDelta + replyDelta).trim();
              if (!delta) continue;

              display.cardBusy = true;
              try {
                const ok = await p.sendText(chatId, compressWechatDisplayText(delta));
                if (ok) {
                  display.lastSentAccLen = state.accumulatedContent.length;
                  display.lastSentFinalReply = state.finalReply;
                  display.lastSentContent = delta;
                }
              } catch (err) {
                console.error(`[${ts()}] WeChat sendText error: chatId=${chatId} ${(err as Error).message}`);
                if (!display.streamErrorNotified) {
                  display.streamErrorNotified = true;
                  p.sendText(chatId, "文本发送失败，请稍后查看结果。").catch(() => {});
                }
              } finally {
                display.cardBusy = false;
              }
            } else {
              // 非 WeChat: 卡片流程
              if (display.turnCount !== state.turnCount) {
                console.log(`[${ts()}] [DISPLAY] turn mismatch for ${chatId}: display.turnCount=${display.turnCount} state.turnCount=${state.turnCount}, resetting`);
                finalizeTurnCards(sessionId, display.turnCount, "done").catch(() => {});
                displayCards.delete(chatId);
                continue;
              }

              const activityHeaderTitle = formatAgentActivityTitle(state.activity, Date.now());

              // 卡片轮转
              if (Date.now() - display.cardCreatedAt > CARD_ROTATE_MS) {
                display.cardBusy = true;
                try {
                  const newCardId = await createVisibleProgressCard(
                    p,
                    chatId,
                    sessionId,
                    display.turnCount,
                    display.streamErrorNotified ? undefined : "生成中卡片发送失败，结果将继续更新在上一张卡片中。",
                    activityHeaderTitle,
                  );
                  if (!newCardId) {
                    display.streamErrorNotified = true;
                    continue;
                  }
                  const oldSeqBase = display.sequence;
                  const oldContent = state.accumulatedContent + state.finalReply;
                  const oldCard = buildProgressCard(truncateContent(oldContent) || " ", { showStop: false, headerTitle: "上一阶段记录" });
                  await p.cardUpdate(display.cardId, oldCard, oldSeqBase + 1).then(() => {
                    display.sequence = oldSeqBase + 1;
                  }).catch(err => {
                    console.error(`[${ts()}] [DISPLAY] rotation old cardUpdate failed: ${(err as Error).message}`);
                  });
                  markCardDone(sessionId, display.turnCount, display.cardId).catch(() => {});
                  display.cardId = newCardId;
                  display.sequence = 1;
                  display.cardCreatedAt = Date.now();
                  display.rotationAccLen = state.accumulatedContent.length;
                  display.rotationFinalReply = state.finalReply;
                  display.lastSentContent = "";
                  display.lastSentHeaderTitle = activityHeaderTitle;
                  display.streamErrorNotified = false;
                } catch (err) {
                  console.error(`[${ts()}] [CARDIKT] rotation FAIL for ${chatId}: ${(err as Error).message}`);
                } finally {
                  display.cardBusy = false;
                }
                continue;
              }

              // 轮转后：分开追踪 accumulatedContent 和 finalReply 增量
              if (display.rotationAccLen !== undefined) {
                const accDelta = state.accumulatedContent.slice(display.rotationAccLen);
                const rotReply = display.rotationFinalReply ?? "";
                let replyDelta: string;
                if (rotReply && state.finalReply.startsWith(rotReply)) {
                  replyDelta = state.finalReply.slice(rotReply.length);
                } else {
                  replyDelta = state.finalReply;
                }
                const delta = (accDelta + replyDelta).trim();

                display.dotCount = (display.dotCount % 9) + 1;
                let deltaBase = delta;
                if (isCodeBlockOpen(deltaBase)) deltaBase += "\n```";
                const displayContent = deltaBase + "\n" + "。".repeat(display.dotCount);
                if (
                  displayContent === display.lastSentContent
                  && activityHeaderTitle === display.lastSentHeaderTitle
                ) continue;

                display.lastSentContent = displayContent;
                display.lastSentHeaderTitle = activityHeaderTitle;
                const deltaCard = buildProgressCard(truncateContent(displayContent) || "等待 Agent 输出...", {
                  showStop: true,
                  headerTitle: activityHeaderTitle,
                });
                display.cardBusy = true;
                const mySeq = display.sequence + 1;
                try {
                  await p.cardUpdate(display.cardId, deltaCard, mySeq);
                  display.sequence = mySeq;
                } catch (err) {
                  const errMsg = (err as Error).message;
                  console.error(`[${ts()}] CardKit update error: chatId=${chatId} ${errMsg}`);
                  if (errMsg.includes("300317")) {
                    display.sequence = mySeq;
                  } else if (!display.streamErrorNotified) {
                    display.streamErrorNotified = true;
                    p.sendText(chatId, "卡片更新失败，结果将以文本形式发送。").catch(() => {});
                  }
                } finally {
                  display.cardBusy = false;
                }
                continue;
              }

              display.dotCount = (display.dotCount % 9) + 1;
              let contentBase = state.accumulatedContent + state.finalReply;
              if (isCodeBlockOpen(contentBase)) contentBase += "\n```";
              const fullContent = contentBase + "\n" + "。".repeat(display.dotCount);
              if (
                fullContent === display.lastSentContent
                && activityHeaderTitle === display.lastSentHeaderTitle
              ) continue;

              display.lastSentContent = fullContent;
              display.lastSentHeaderTitle = activityHeaderTitle;
              const cardContent = truncateContent(fullContent) || "等待 Agent 输出...";
              display.cardBusy = true;
              const mySeq = display.sequence + 1;
              try {
                const card = buildProgressCard(cardContent, { showStop: true, headerTitle: activityHeaderTitle });
                await p.cardUpdate(display.cardId, card, mySeq);
                display.sequence = mySeq;
              } catch (err) {
                const errMsg = (err as Error).message;
                console.error(`[${ts()}] CardKit update error: chatId=${chatId} ${errMsg}`);
                if (errMsg.includes("300317")) {
                  display.sequence = mySeq;
                } else if (!display.streamErrorNotified) {
                  display.streamErrorNotified = true;
                  p.sendText(chatId, "卡片更新失败，结果将以文本形式发送。").catch(() => {});
                }
              } finally {
                display.cardBusy = false;
              }
            }
          }
          } catch (err) {
            console.error(`[${ts()}] Display loop error for ${chatId}: ${(err as Error).message}`);
          }
        }
      } finally {
        tickRunning = false;
      }
    })().catch((err: unknown) => {
      const e = err instanceof Error ? err : new Error(String(err));
      console.error(`[${ts()}] Unified display loop uncaught: ${e.message}`);
    });
  }, 3000);

  setUnifiedDisplayLoopHandle(interval);
  console.log(`[${ts()}] [DISPLAY] Unified display loop started`);
}

export function stopUnifiedDisplayLoop(): void {
  if (unifiedDisplayLoopHandle !== null) {
    clearInterval(unifiedDisplayLoopHandle);
    setUnifiedDisplayLoopHandle(null);
    console.log(`[${ts()}] [DISPLAY] Unified display loop stopped`);
  }
}

// ---------------------------------------------------------------------------
// stopSession — 停止指定 session 的活跃 prompt
// ---------------------------------------------------------------------------
//
// 设计要点：
// 1) controller.abort() 触发 adapter finally 里的 killProcessTree(proc.pid)，
//    后者负责把整棵 CLI 进程树（cmd.exe 壳 + node CLI 入口 + 真二进制）一起
//    收尸；之前用 proc.kill() 在 Windows + shell:true 下只能杀第一层 cmd.exe，
//    会留下"幽灵 CLI 子进程"继续跑、stream-state 永远停在 running。
//
// 2) 立刻 fire-and-forget 把 stream-state 标 stopped，不依赖 runAgentSession
//    的 finally。原因：generator 自然结束依赖子进程 stdout 关闭，killProcessTree
//    虽然很快但仍是异步，期间 display loop 可能多读到 1–2 帧 "running"，
//    用户体验上"按下停止后还要等几秒卡片才变成已停止"。先把状态标好，
//    finally 后续再写一次也不冲突——status 最终值仍然是 stopped。
export function stopSession(sessionId: string): boolean {
  // /stop 拥有高于内部自动恢复的优先级。旧轮已经完成、恢复轮尚在 200ms
  // 预约窗口时 activePrompts 为空，因此必须单独取消 reservation。
  const cancelledRecovery = cancelAutoRecoveryReservation(sessionId);
  const prompt = activePrompts.get(sessionId);
  if (!prompt) {
    if (cancelledRecovery) {
      cancelQueuedMessage(sessionId);
      console.log(`[${ts()}] [STOP] Reserved automatic recovery for ${sessionId} cancelled`);
      return true;
    }
    return false;
  }
  prompt.stopped = true;
  clearPromptResponseStallMonitor(sessionId);
  clearPromptProcessMonitor(sessionId);
  clearPromptFinalResponseCloseTimer(sessionId);
  cancelQueuedMessage(sessionId);

  // 先发起整棵进程树清理，再触发 close/abort。Windows 上 CLI 由
  // cmd.exe → node → 实际二进制组成；若先 process.kill(cmd.exe)，taskkill
  // 随后便无法从已消失的根 PID 找到后代，正是幽灵 Codex/Cursor 的来源。
  // killProcessTree 在返回 Promise 前已启动 taskkill，因此这里无需阻塞。
  void killProcessTree(prompt.processPid);
  try {
    prompt.closeSession?.();
  } catch (err) {
    console.warn(`[${ts()}] [STOP] closeSession failed for ${sessionId}: ${(err as Error).message}`);
  }
  prompt.controller.abort();
  console.log(`[${ts()}] [STOP] Session ${sessionId} aborted`);

  // fire-and-forget：立刻把 stream-state.status 改成 stopped，
  // 让 display loop 下一次扫到立刻渲染"已停止"卡片，不必再等几秒。
  void (async () => {
    try {
      const current = await readStreamState(sessionId);
      if (!current) return;
      // 已经是终态就别再覆盖，避免把 done/error 误改成 stopped
      if (current.status !== "running") return;
      await writeStreamState({
        ...current,
        status: "stopped",
        updatedAt: Date.now(),
      });
    } catch (err) {
      console.warn(
        `[${ts()}] [STOP] writeStreamState(stopped) failed for ${sessionId}: ${(err as Error).message}`,
      );
    }
  })();

  return true;
}

// ---------------------------------------------------------------------------
// Session status query (供 /state、/sessions 命令使用)
// ---------------------------------------------------------------------------
//
// model / effort 的来源策略（按 tool 区分，避免硬塞 ChatCCC 全局配置导致显示
// 与实际不符）：
//   - tool === "cursor"
//       model：调用 cursor-adapter.getSessionInfo 取持久化的真实模型，
//              未学习到时显示占位符 "—"
//       effort：cursor-agent 没有 effort 概念，恒为 null（卡片渲染时隐藏该行）
//   - tool === "claude"（默认）
//       model：anthropicConfigDisplay(CLAUDE_MODEL)
//       effort：anthropicConfigDisplay(CLAUDE_EFFORT)
// ---------------------------------------------------------------------------

/** 未知/未学习到时的 model 占位符（卡片可视提示，避免在 UI 上显示空字符串） */
export const UNKNOWN_MODEL_PLACEHOLDER = "—";

export interface SessionStatus {
  sessionId: string;
  chatName: string;
  running: boolean;
  turnCount: number;
  lastContextTokens: number;
  startTime: number;
  model: string;
  /** null 表示该工具没有 effort 概念（如 Cursor），调用方应隐藏该行 */
  effort: string | null;
  accumulatedLength: number;
}

async function resolveModelEffort(
  tool: string,
  sessionId: string,
): Promise<{ model: string; effort: string | null }> {
  if (tool === "cursor") {
    let model = UNKNOWN_MODEL_PLACEHOLDER;
    try {
      const adapter = getAdapterForTool(tool, sessionId);
      const info = await adapter.getSessionInfo(sessionId);
      if (info?.model) model = info.model;
    } catch {
      // adapter 异常时降级为占位符（不阻塞 /state 卡片）
    }
    return { model, effort: null };
  }
  if (tool === "codex") {
    const m = getEffectiveModelForTool(tool, sessionId);
    const e = getEffectiveEffortForTool(tool, sessionId);
    return {
      model: m.trim() !== "" ? m : UNKNOWN_MODEL_PLACEHOLDER,
      effort: e.trim() !== "" ? e : UNKNOWN_MODEL_PLACEHOLDER,
    };
  }
  if (tool === "ccc") {
    const m = getEffectiveModelForTool(tool, sessionId);
    return {
      model: m.trim() !== "" ? m : UNKNOWN_MODEL_PLACEHOLDER,
      effort: null,
    };
  }
  return {
    model: anthropicConfigDisplay(getModelForSession(sessionId)),
    effort: anthropicConfigDisplay(getEffectiveEffortForTool(tool, sessionId)),
  };
}

export async function getSessionStatus(chatId: string): Promise<SessionStatus | null> {
  const info = sessionInfoMap.get(chatId);
  if (!info) return null;

  const activePrompt = activePrompts.get(info.sessionId);
  const isActive = !!activePrompt && !activePrompt.stopped && !activePrompt.abnormalExit;
  const { model, effort } = await resolveModelEffort(info.tool, info.sessionId);

  const registry = await loadSessionRegistry();
  const chatName = registry[chatId]?.chatName ?? "";

  // 从 stream-state.json 获取当前累积长度
  let accumulatedLength = 0;
  const streamState = await readStreamState(info.sessionId);
  if (streamState) {
    accumulatedLength = streamState.accumulatedContent.length + streamState.finalReply.length;
  }

  return {
    sessionId: info.sessionId,
    chatName,
    running: isActive,
    turnCount: info.turnCount,
    lastContextTokens: info.lastContextTokens,
    startTime: info.startTime,
    model,
    effort,
    accumulatedLength,
  };
}

export interface SessionsListEntry {
  chatId: string;
  chatType?: string;
  sessionId: string;
  chatName: string;
  active: boolean;
  turnCount: number;
  startTime: number;
  model: string;
  /** null 表示该工具没有 effort 概念（如 Cursor） */
  effort: string | null;
  tool: string;
}

export async function getAllSessionsStatus(): Promise<SessionsListEntry[]> {
  const registry = await loadSessionRegistry();
  const registryEntries = Object.values(registry)
    .filter((record) => record.chatId && record.sessionId && record.tool)
    .map((record) => ({ ...record, sortTime: record.updatedAt }));
  const registeredSessionIds = new Set(registryEntries.map((record) => record.sessionId));
  const sessionTools = await loadSessionTools();
  const orphanEntries = Object.entries(sessionTools)
    .filter(([sessionId, record]) => sessionId && record?.tool && !registeredSessionIds.has(sessionId))
    .map(([sessionId, record]) => {
      const createdAt = Number.isFinite(record.createdAt) ? record.createdAt : 0;
      const active = activePrompts.get(sessionId);
      return {
        chatId: "",
        chatType: undefined,
        sessionId,
        tool: record.tool,
        chatName: record.chatName ?? "",
        turnCount: 0,
        lastContextTokens: 0,
        startTime: active?.startTime ?? createdAt,
        updatedAt: createdAt,
        running: false,
        sortTime: active?.startTime ?? createdAt,
      };
    });
  const entries = [...registryEntries, ...orphanEntries]
    .sort((a, b) => b.sortTime - a.sortTime)
    .slice(0, 20);
  // 并行解析每个 session 的 model/effort（cursor 涉及异步 store IO）
  return Promise.all(
    entries.map(async (info) => {
      const { model, effort } = await resolveModelEffort(info.tool, info.sessionId);
      return {
        chatId: info.chatId,
        chatType: info.chatType,
        sessionId: info.sessionId,
        chatName: info.chatName || "",
        active: !!activePrompts.get(info.sessionId) &&
          !activePrompts.get(info.sessionId)?.stopped &&
          !activePrompts.get(info.sessionId)?.abnormalExit,
        turnCount: info.turnCount,
        startTime: info.startTime,
        model,
        effort,
        tool: info.tool,
      };
    }),
  );
}

// ---------------------------------------------------------------------------
// 测试辅助：注入自定义 adapter 到 adapterCache
// ---------------------------------------------------------------------------
// 仅供单测使用——下划线前缀表明非生产 API。让 session-status 的测试可以
// 注入一个内存 store + adapter，以验证 cursor 分支按 tool 取真实 model。
// ---------------------------------------------------------------------------

export function _setAdapterForToolForTest(tool: string, adapter: ToolAdapter): void {
  adapterCache.set(tool, adapter);
  // 同时设置当前配置模型对应的 key（getAdapterForTool 会优先 lookup 含 model 的 key）
  const effective = getEffectiveModelForTool(tool);
  const effort = getEffectiveEffortForTool(tool);
  const fastMode = getEffectiveFastModeForTool(tool);
  adapterCache.set(`${tool}:${effective || ""}:${effort || ""}:${fastMode ? "fast" : "default"}`, adapter);
  if (effective) adapterCache.set(`${tool}:${effective}`, adapter);
}

export function clearAdapterCache(): void {
  adapterCache.clear();
}

export function _clearAdapterCacheForTest(): void {
  clearAdapterCache();
}
