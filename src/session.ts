import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  CLAUDE_API_KEY,
  CLAUDE_BASE_URL,
  CLAUDE_EFFORT,
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
  isAnthropicConfigEmpty,
  toolDisplayName,
  ts,
} from "./config.ts";
import { buildProgressCard, getToolEmoji, truncateContent } from "./cards.ts";
import { simplifyToolUse, simplifyToolResult } from "./simplify.ts";
import { logTrace } from "./trace.ts";
import type { UnifiedBlock } from "./adapters/adapter-interface.ts";
import type { ToolAdapter } from "./adapters/adapter-interface.ts";
import { createClaudeAdapter } from "./adapters/claude-adapter.ts";
import { createCursorAdapter } from "./adapters/cursor-adapter.ts";
import { createCodexAdapter } from "./adapters/codex-adapter.ts";
import { buildImSkillsPrompt, exportSkillSubDocs } from "./im-skills.ts";
import type { PlatformAdapter } from "./platform-adapter.ts";

// 微信显示循环压缩：头5 + ... + 尾5，避免在最后一步 sendText 中压缩指令回复
function compressWechatDisplayText(text: string): string {
  const lines = text.split("\n");
  if (lines.length <= 10) return text;
  return [...lines.slice(0, 5), "...", ...lines.slice(-5)].join("\n");
}
import { readStreamState, writeStreamState, createEmptyStreamState, fixStaleStreamStates } from "./stream-state.ts";
import {
  bindChatToSession,
  unbindChatFromSession,
  getChatsForSession,
  isSessionRunning,
  activePrompts,
  displayCards,
  displayLoops,
  rebuildSessionChatsFromRegistry,
  recordLastActiveChat,
  getLastActiveChat,
  pickDisplayChat,
} from "./session-chat-binding.ts";

// ---------------------------------------------------------------------------
// Shared state (imported by index.ts)
// ---------------------------------------------------------------------------

export const processedMessages = new Set<string>();
export const MAX_PROCESSED = 5000;

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
  processedMessages.clear();
  lastMsgTimestamps.clear();
  chatPlatformMap.clear();
  activePrompts.clear();
  displayCards.clear();
  for (const stop of displayLoops.values()) stop();
  displayLoops.clear();
  console.log(`[${ts()}] [RESET] State cleared (dedup + active sessions + bindings)`);
}

// 注:`rebuildBindingsFromRegistry` 定义在下方与 loadSessionRegistry 同区域,
// 是 onReady/onReconnected 取代 resetState 的正确入口。

// ---------------------------------------------------------------------------
// Adapter: 按 tool 创建并缓存
// ---------------------------------------------------------------------------

const adapterCache = new Map<string, ToolAdapter>();

export function getAdapterForTool(tool: string): ToolAdapter {
  const cached = adapterCache.get(tool);
  if (cached) return cached;

  let adapter: ToolAdapter;
  if (tool === "cursor") {
    adapter = createCursorAdapter();
  } else if (tool === "codex") {
    adapter = createCodexAdapter();
  } else {
    adapter = createClaudeAdapter({
      model: CLAUDE_MODEL,
      subagentModel: CLAUDE_SUBAGENT_MODEL,
      effort: CLAUDE_EFFORT,
      isEmpty: isAnthropicConfigEmpty,
      apiKey: CLAUDE_API_KEY,
      baseUrl: CLAUDE_BASE_URL,
    });
  }
  adapterCache.set(tool, adapter);
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
 *   - **不动** displayCards / displayLoops：正在跑的 prompt 还需要它们继续推卡片
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

export interface AccumulatorState {
  accumulatedContent: string;
  /** partial text 块按追加语义累积；适用于 Cursor 的流式增量与 Claude SDK 的 delta */
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
function formatToolConfigForLog(tool: string, sessionModel?: string): string {
  if (tool === "cursor") {
    return `model=${sessionModel ?? "(由 cursor-agent 决定，init 事件后学习)"}`;
  }
  if (tool === "codex") {
    const m = config.codex.model;
    const e = config.codex.effort;
    const modelStr = m.trim() !== "" ? m : "(由 codex config.toml 决定)";
    const effortStr = e.trim() !== ""
      ? `effort=${e}`
      : "effort=(由 codex config.toml 决定)";
    return `model=${modelStr}, ${effortStr}`;
  }
  return `model=${anthropicConfigDisplay(CLAUDE_MODEL)}, subagentModel=${anthropicConfigDisplay(CLAUDE_SUBAGENT_MODEL)}, effort=${anthropicConfigDisplay(CLAUDE_EFFORT)}`;
}

export async function initClaudeSession(tool: string, overrideCwd?: string, chatId?: string): Promise<{ sessionId: string; cwd: string }> {
  const cwd = overrideCwd ?? (await getDefaultCwd(chatId));
  const adapter = getAdapterForTool(tool);
  console.log(
    `[${ts()}] [STEP 1/5] Creating ${adapter.displayName} session (${formatToolConfigForLog(tool)}, cwd=${cwd})`
  );

  const result = await adapter.createSession(cwd);
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

export async function runAgentSession(
  sessionId: string,
  userText: string,
  platform: PlatformAdapter,
  _chatId: string,
  msgTimestamp: number,
  tool: string,
  traceId?: string,
): Promise<void> {
  const tid = traceId ?? "";

  // 记录用户最后发送消息的群（display loop 只推送到该群）
  recordChatPlatform(_chatId, platform);
  recordLastActiveChat(sessionId, _chatId);

  // 并发检查：同一 session 只能有一个活跃 prompt
  if (activePrompts.has(sessionId)) {
    if (tid) logTrace(tid, "BLOCKED", { outcome: "session_busy", sessionId });
    console.log(`[${ts()}] [BLOCKED] Session ${sessionId} is already generating`);
    const isWechatBusy = platform.kind === "wechat";
    const busyMsg = isWechatBusy
      ? "当前正在生成回复中，请等待完成后再发送消息。如需中断生成，请发送 /stop 指令。"
      : "该会话正在生成回复中，请等待完成后再发送消息。";
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
  });

  // 异步准备工作（session info、IM skills prompt 等）
  let adapter: ToolAdapter;
  let info: Awaited<ReturnType<ToolAdapter["getSessionInfo"]>>;
  let cwd: string;
  try {
    adapter = getAdapterForTool(tool);
    info = await adapter.getSessionInfo(sessionId);
    cwd = info?.cwd ?? (await getDefaultCwd(_chatId));
    if (tid) logTrace(tid, "SESSION_START", { sessionId, tool, cwd, turn: (sessionInfoMap.get(_chatId)?.turnCount ?? 0) + 1 });
    console.log(
      `[${ts()}] Running ${adapter.displayName} session: ${sessionId} (${formatToolConfigForLog(tool, info?.model)}, cwd=${cwd})`
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
    var imSkillsPrompt = await buildImSkillsPrompt({ variables: skillVariables, enabledSkillNames });
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

  // 初始化 stream-state.json
  const initialState = createEmptyStreamState(sessionId, cwd, tool, nextTurnCount);
  await writeStreamState(initialState);

  // 启动 display loop
  ensureDisplayLoop(sessionId);

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

  try {
    for await (const unifiedMsg of adapter.prompt(sessionId, userTextWithCapabilities, cwd, controller.signal)) {
      for (const block of unifiedMsg.blocks) {
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

      // 定时写入文件
      const now2 = Date.now();
      if (now2 - lastFileWrite >= FILE_WRITE_INTERVAL_MS) {
        lastFileWrite = now2;
        await writeStreamState({
          sessionId,
          status: "running",
          accumulatedContent: state.accumulatedContent,
          finalReply: pickFinalReply(state),
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
    console.error(`[${ts()}] [STREAM] Error in stream loop for ${sessionId}: ${(streamErr as Error).message}`);
  } finally {
    // 标记 prompt 结束
    const prompt = activePrompts.get(sessionId);
    const wasStopped = prompt?.stopped ?? false;
    activePrompts.delete(sessionId);

    // 写最终状态
    const finalStatus = wasStopped ? "stopped" : "done";
    const finalReply = pickFinalReply(state).trim();
    await writeStreamState({
      sessionId,
      status: finalStatus,
      accumulatedContent: state.accumulatedContent,
      finalReply,
      chunkCount: state.chunkCount,
      turnCount: nextTurnCount,
      contextTokens: existingInfo?.lastContextTokens ?? 0,
      updatedAt: Date.now(),
      cwd,
      tool,
    });

    // display loop 下一轮会读到最终状态并发送消息

    if (wasStopped) {
      for (const cid of getChatsForSession(sessionId)) {
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
      const active1 = getLastActiveChat(sessionId) ?? getChatsForSession(sessionId)[0];
      if (active1) platform.setChatAvatar(active1, tool, "idle").catch(() => {});
      console.log(`[${ts()}] Session ${sessionId} stopped (content chunks: ${state.chunkCount})`);
      if (tid) logTrace(tid, "SESSION_END", { sessionId, outcome: "stopped", chunks: state.chunkCount });
    } else {
      for (const cid of getChatsForSession(sessionId)) {
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
      const active2 = getLastActiveChat(sessionId) ?? getChatsForSession(sessionId)[0];
      if (active2) platform.setChatAvatar(active2, tool, "idle").catch(() => {});
      console.log(`[${ts()}] Session ${sessionId} stream complete (content chunks: ${state.chunkCount})`);
      if (tid) logTrace(tid, "SESSION_END", { sessionId, chunks: state.chunkCount, finalTextLen: finalReply.length });
    }
  }
}

// ---------------------------------------------------------------------------
// ensureDisplayLoop — 每个 session 一个 display 循环，读文件更新最后活跃群的卡片
// ---------------------------------------------------------------------------

const CARD_ROTATE_MS = 9 * 60 * 1000;

export function ensureDisplayLoop(sessionId: string): void {
  if (displayLoops.has(sessionId)) return;

  let dotCount = 0;

  const interval = setInterval(() => {
    void (async () => {
      const state = await readStreamState(sessionId);
      if (!state) return;

      // pickDisplayChat 在 lastActiveChat 已与本 session 解绑时返回 undefined，
      // 避免 /newh 等改嫁场景下旧 session 仍向已离开群推卡片。
      const chatId = pickDisplayChat(sessionId);
      if (!chatId) {
        // 无活跃群，若 session 已结束则停止 loop
        if (state.status !== "running") {
          clearInterval(interval);
          displayLoops.delete(sessionId);
          // 兜底：lastActiveChatMap 可能因进程重启丢失，从 registry 映射恢复头像
          const fallbackChat = getChatsForSession(sessionId)[0];
          const fallbackPlatform = fallbackChat ? platformForChat(fallbackChat) : null;
          if (fallbackChat && fallbackPlatform) {
            fallbackPlatform.setChatAvatar(fallbackChat, state.tool, "idle").catch(() => {});
          }
        }
        return;
      }

      // 交叉验证：chat 当前绑定的 session 是否仍是本 display loop 的 session。
      // 若 chat 已被切换到其他 session（如 /new p2p 未解绑旧 session 的历史遗留
      // 或任何未来新增的切换路径），旧 loop 必须停推，避免向已离开的 chat 推送内容。
      const currentSessionForChat = sessionInfoMap.get(chatId)?.sessionId;
      if (currentSessionForChat && currentSessionForChat !== sessionId) {
        if (state.status !== "running") {
          clearInterval(interval);
          displayLoops.delete(sessionId);
        }
        return;
      }

      const isTerminal = state.status !== "running";

      try {
        const p = platformForChat(chatId);
        if (!p) return;
        const display = displayCards.get(chatId);

        const isWechat = p.kind === "wechat";

        if (isTerminal) {
          if (isWechat) {
            // WeChat: 没有卡片需要终结，用 delta 逻辑发剩余内容，避免重发已推送的部分
            // 分开追踪 accumulatedContent 和 finalReply，而非拼接后对比
            const prevAccLen = display?.lastSentAccLen ?? 0;
            const prevFinalReply = display?.lastSentFinalReply ?? "";
            const accDelta = state.accumulatedContent.slice(prevAccLen);
            let replyDelta: string;
            if (prevFinalReply && state.finalReply.startsWith(prevFinalReply)) {
              replyDelta = state.finalReply.slice(prevFinalReply.length);
            } else {
              replyDelta = state.finalReply;
            }
            const remaining = (accDelta + replyDelta).trim();
            const tail = "━━━ 回答结束 ━━━";
            const finalMsg = remaining ? remaining + "\n" + tail : tail;
            await p.sendText(chatId, finalMsg).catch(() => {});
            if (display) displayCards.delete(chatId);
          } else {
            // 发送最终结果（卡片平台）
            if (display) {
              while (display.cardBusy) await new Promise(r => setTimeout(r, 20));
              const nextSeq = display.sequence + 1;
              const headerTitle = state.status === "stopped" ? "已停止" : "完成";
              const headerTemplate = state.status === "stopped" ? "red" : undefined;
              const cardContent = state.accumulatedContent || " ";
              const doneCard = buildProgressCard(cardContent, { showStop: false, headerTitle, headerTemplate });
              await p.cardUpdate(display.cardId, doneCard, nextSeq).catch(() => {});
              displayCards.delete(chatId);
            }
            if (state.finalReply) {
              await p.sendText(chatId, state.finalReply).catch(() => {});
            } else if (!display && state.accumulatedContent.trim()) {
              const short = truncateContent(state.accumulatedContent, 30, 4000);
              await p.sendText(chatId, `[生成过程]\n${short}`).catch(() => {});
            }
          }
          p.setChatAvatar(chatId, state.tool, "idle").catch(() => {});
        } else {
          // running: 创建或更新展示
          if (isWechat) {
            // WeChat: 不使用卡片，基于 agent 真实 delta 推送 raw content
            if (!display) {
              displayCards.set(chatId, {
                cardId: "",
                sequence: 0,
                cardBusy: false,
                cardCreatedAt: Date.now(),
                lastSentContent: "",
                streamErrorNotified: false,
              });
            }
            const d = displayCards.get(chatId);
            if (!d || d.cardBusy) return;

            // 分开追踪 accumulatedContent 和 finalReply 的已发送位置。
            // 如果只用 rawFull.startsWith(prevRaw)，当新的 tool_use/tool_result
            // 插入到 accumulatedContent 中间时，rawFull 不再以 prevRaw 开头，
            // 会回退到发送完整内容 → 产生大量重复。
            const prevAccLen = d.lastSentAccLen ?? 0;
            const prevFinalReply = d.lastSentFinalReply ?? "";
            const accDelta = state.accumulatedContent.slice(prevAccLen);
            let replyDelta: string;
            if (prevFinalReply && state.finalReply.startsWith(prevFinalReply)) {
              replyDelta = state.finalReply.slice(prevFinalReply.length);
            } else {
              replyDelta = state.finalReply;
            }
            const delta = (accDelta + replyDelta).trim();
            if (!delta) return;

            d.cardBusy = true;
            try {
              const ok = await p.sendText(chatId, compressWechatDisplayText(delta));
              if (ok) {
                d.lastSentAccLen = state.accumulatedContent.length;
                d.lastSentFinalReply = state.finalReply;
                d.lastSentContent = delta;
              } else {
                // 发送失败（限流等），不更新光标，下次合并重试
                return;
              }
            } catch (err) {
              console.error(`[${ts()}] WeChat sendText error: chatId=${chatId} ${(err as Error).message}`);
              if (!d.streamErrorNotified) {
                d.streamErrorNotified = true;
                p.sendText(chatId, "文本发送失败，请稍后查看结果。").catch(() => {});
              }
            } finally {
              d.cardBusy = false;
            }
          } else {
            // 非 WeChat: 卡片流程
            if (!display) {
              const cardId = await p.cardCreate(buildProgressCard("", { showStop: true, headerTitle: "生成中..." })).catch(() => null);
              if (cardId) {
                await p.cardSend(chatId, cardId).catch(() => null);
                displayCards.set(chatId, {
                  cardId,
                  sequence: 1,
                  cardBusy: false,
                  cardCreatedAt: Date.now(),
                  lastSentContent: "",
                  streamErrorNotified: false,
                });
              }
            } else {
              if (display.cardBusy) return;

              // 卡片轮转
              if (Date.now() - display.cardCreatedAt > CARD_ROTATE_MS) {
                display.cardBusy = true;
                try {
                  const oldSeqBase = display.sequence;
                  const oldDisplayContent = truncateContent(state.accumulatedContent + state.finalReply) || "处理中...";
                  const oldCard = buildProgressCard(oldDisplayContent, { showStop: false, headerTitle: "生成中...（上轮）" });
                  await p.cardUpdate(display.cardId, oldCard, oldSeqBase + 1).catch(() => {});
                  const newCardId = await p.cardCreate(buildProgressCard("", { showStop: true, headerTitle: "生成中..." }));
                  if (newCardId) {
                    await p.cardSend(chatId, newCardId);
                    display.cardId = newCardId;
                    display.sequence = 1;
                    display.cardCreatedAt = Date.now();
                    // 记录基线：分开追踪 accumulatedContent 长度和 finalReply，
                    // 避免 tool 内容中间插入时前缀匹配失败 → 回退发完整内容
                    display.rotationAccLen = state.accumulatedContent.length;
                    display.rotationFinalReply = state.finalReply;
                    display.lastSentContent = "";
                    display.streamErrorNotified = false;
                  }
                } catch (err) {
                  console.error(`[${ts()}] [CARDIKT] rotation FAIL for ${chatId}: ${(err as Error).message}`);
                } finally {
                  display.cardBusy = false;
                }
                return;
              }

              // 轮转后：分开追踪 accumulatedContent 和 finalReply 增量，
              // 避免 tool 内容插入中间时前缀匹配失败
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
                if (!delta || delta === display.lastSentContent) return;
                display.lastSentContent = delta;
                const deltaCard = buildProgressCard(truncateContent(delta) || "处理中...", { showStop: true, headerTitle: "生成中..." });
                display.cardBusy = true;
                const mySeq = display.sequence + 1;
                try {
                  await p.cardUpdate(display.cardId, deltaCard, mySeq);
                  display.sequence = mySeq;
                } catch (err) {
                  console.error(`[${ts()}] CardKit update error: chatId=${chatId} ${(err as Error).message}`);
                  if (!display.streamErrorNotified) {
                    display.streamErrorNotified = true;
                    p.sendText(chatId, "卡片更新失败，结果将以文本形式发送。").catch(() => {});
                  }
                } finally {
                  display.cardBusy = false;
                }
                return;
              }

              dotCount = (dotCount % 9) + 1;
              const fullContent = state.accumulatedContent + state.finalReply + "\n" + "。".repeat(dotCount);
              if (fullContent === display.lastSentContent) return;

              display.lastSentContent = fullContent;
              const cardContent = truncateContent(fullContent);
              display.cardBusy = true;
              const mySeq = display.sequence + 1;
              try {
                const card = buildProgressCard(cardContent, { showStop: true, headerTitle: "生成中..." });
                await p.cardUpdate(display.cardId, card, mySeq);
                display.sequence = mySeq;
              } catch (err) {
                console.error(`[${ts()}] CardKit update error: chatId=${chatId} ${(err as Error).message}`);
                if (!display.streamErrorNotified) {
                  display.streamErrorNotified = true;
                  p.sendText(chatId, "卡片更新失败，结果将以文本形式发送。").catch(() => {});
                }
              } finally {
                display.cardBusy = false;
              }
            }
          }
        }
      } catch (err) {
        console.error(`[${ts()}] Display loop error for ${chatId}: ${(err as Error).message}`);
      }

      if (isTerminal) {
        clearInterval(interval);
        displayLoops.delete(sessionId);
      }
    })().catch((err: unknown) => {
      const e = err instanceof Error ? err : new Error(String(err));
      console.error(`[${ts()}] Display loop uncaught for ${sessionId}: ${e.message}`);
    });
  }, 3000);

  displayLoops.set(sessionId, () => clearInterval(interval));
}

// ---------------------------------------------------------------------------
// stopSession — 停止指定 session 的活跃 prompt
// ---------------------------------------------------------------------------

export function stopSession(sessionId: string): boolean {
  const prompt = activePrompts.get(sessionId);
  if (!prompt) return false;
  prompt.stopped = true;
  prompt.controller.abort();
  console.log(`[${ts()}] [STOP] Session ${sessionId} aborted`);
  return true;
}

// ---------------------------------------------------------------------------
// Session status query (供 /status、/sessions 命令使用)
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
      const adapter = getAdapterForTool(tool);
      const info = await adapter.getSessionInfo(sessionId);
      if (info?.model) model = info.model;
    } catch {
      // adapter 异常时降级为占位符（不阻塞 /status 卡片）
    }
    return { model, effort: null };
  }
  if (tool === "codex") {
    const m = config.codex.model;
    const e = config.codex.effort;
    return {
      model: m.trim() !== "" ? m : UNKNOWN_MODEL_PLACEHOLDER,
      effort: e.trim() !== "" ? e : UNKNOWN_MODEL_PLACEHOLDER,
    };
  }
  return {
    model: anthropicConfigDisplay(CLAUDE_MODEL),
    effort: anthropicConfigDisplay(CLAUDE_EFFORT),
  };
}

export async function getSessionStatus(chatId: string): Promise<SessionStatus | null> {
  const info = sessionInfoMap.get(chatId);
  if (!info) return null;

  const isActive = activePrompts.has(info.sessionId) && !(activePrompts.get(info.sessionId)?.stopped);
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
        sessionId: info.sessionId,
        chatName: info.chatName || "",
        active: activePrompts.has(info.sessionId) && !(activePrompts.get(info.sessionId)?.stopped),
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
}

export function clearAdapterCache(): void {
  adapterCache.clear();
}

export function _clearAdapterCacheForTest(): void {
  clearAdapterCache();
}
