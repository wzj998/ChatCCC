import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  CLAUDE_API_KEY,
  CLAUDE_BASE_URL,
  CLAUDE_EFFORT,
  CLAUDE_MODEL,
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
import {
  createCardKitCard,
  sendCardKitMessage,
  updateCardKitCard,
} from "./cardkit.ts";
import { sendTextReply, setChatAvatar } from "./feishu-platform.ts";
import { logTrace } from "./trace.ts";
import type { UnifiedBlock } from "./adapters/adapter-interface.ts";
import type { ToolAdapter } from "./adapters/adapter-interface.ts";
import { createClaudeAdapter } from "./adapters/claude-adapter.ts";
import { createCursorAdapter } from "./adapters/cursor-adapter.ts";
import { createCodexAdapter } from "./adapters/codex-adapter.ts";
import { buildImSkillsPrompt, exportSkillSubDocs } from "./im-skills.ts";
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
} from "./session-chat-binding.ts";

// ---------------------------------------------------------------------------
// Shared state (imported by index.ts)
// ---------------------------------------------------------------------------

export const processedMessages = new Set<string>();
export const MAX_PROCESSED = 5000;

/** 每个 chatId 上一次已处理消息的时间戳，用于拦截延迟送达的旧消息 */
export const lastMsgTimestamps = new Map<string, number>();

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

export function resetState(): void {
  for (const entry of chatSessionMap.values()) {
    if (entry.spinnerTimer) clearInterval(entry.spinnerTimer);
    try { entry.close(); } catch { /* ignore */ }
  }
  chatSessionMap.clear();
  sessionInfoMap.clear();
  processedMessages.clear();
  lastMsgTimestamps.clear();
  // 清理新的全局状态
  activePrompts.clear();
  displayCards.clear();
  for (const stop of displayLoops.values()) stop();
  displayLoops.clear();
  console.log(`[${ts()}] [RESET] State cleared (dedup + active sessions + bindings)`);
}

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
}

async function loadSessionTools(): Promise<Record<string, SessionToolRecord>> {
  try {
    const raw = await readFile(SESSIONS_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveSessionTools(data: Record<string, SessionToolRecord>): Promise<void> {
  try {
    await mkdir(dirname(SESSIONS_FILE), { recursive: true });
    await writeFile(SESSIONS_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    console.error(`[${ts()}] Failed to save sessions.json: ${(err as Error).message}`);
    fileLog.flush();
  }
}

export async function saveSessionTool(sessionId: string, tool: string): Promise<void> {
  const data = await loadSessionTools();
  data[sessionId] = { tool, createdAt: Date.now() };
  await saveSessionTools(data);
}

export async function getSessionTool(sessionId: string): Promise<string | null> {
  const data = await loadSessionTools();
  const record = data[sessionId];
  return record?.tool ?? null;
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
): void {
  switch (block.type) {
    case "thinking":
      state.chunkCount++;
      state.accumulatedContent += block.thinking;
      break;
    case "tool_use": {
      const inputStr =
        typeof block.input === "object"
          ? JSON.stringify(block.input)
          : String(block.input ?? "");
      const shortInput =
        inputStr.length > 300 ? inputStr.slice(0, 300) + "..." : inputStr;
      state.accumulatedContent +=
        `\n\n${getToolEmoji(block.name)} **${block.name}**\n\`${shortInput}\`\n`;
      break;
    }
    case "tool_result": {
      const toolUseId = block.tool_use_id;
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
      const isError = block.is_error;
      const icon = isError ? "❌" : "✅"; // ❌ : ✅
      state.accumulatedContent +=
        `${icon} *${toolUseId.slice(-6)}*: ${shortResult}\n`;
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
  return `model=${anthropicConfigDisplay(CLAUDE_MODEL)}, effort=${anthropicConfigDisplay(CLAUDE_EFFORT)}`;
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
  token: string,
  chatId: string,
  msgTimestamp: number,
  tool: string,
  traceId?: string,
): Promise<void> {
  return runAgentSession(sessionId, userText, token, chatId, msgTimestamp, tool, traceId);
}

// ---------------------------------------------------------------------------
// runAgentSession — session 中心的 agent prompt（文件持久化 + display 解耦）
// ---------------------------------------------------------------------------

export async function runAgentSession(
  sessionId: string,
  userText: string,
  token: string,
  _chatId: string,
  msgTimestamp: number,
  tool: string,
  traceId?: string,
): Promise<void> {
  const tid = traceId ?? "";

  // 并发检查：同一 session 只能有一个活跃 prompt
  if (activePrompts.has(sessionId)) {
    if (tid) logTrace(tid, "BLOCKED", { outcome: "session_busy", sessionId });
    console.log(`[${ts()}] [BLOCKED] Session ${sessionId} is already generating`);
    await sendTextReply(token, _chatId, "该会话正在生成回复中，请等待完成后再发送消息。").catch(() => {});
    return;
  }

  const adapter = getAdapterForTool(tool);
  const info = await adapter.getSessionInfo(sessionId);
  const cwd = info?.cwd ?? (await getDefaultCwd(_chatId));
  if (tid) logTrace(tid, "SESSION_START", { sessionId, tool, cwd, turn: (sessionInfoMap.get(_chatId)?.turnCount ?? 0) + 1 });
  console.log(
    `[${ts()}] Running ${adapter.displayName} session: ${sessionId} (${formatToolConfigForLog(tool, info?.model)}, cwd=${cwd})`
  );

  // 构建 IM skills prompt（sessionId 方式，无 token）
  const feishuSkillDir = join(PROJECT_ROOT, "im-skills", "feishu-skill");
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
  };
  const imSkillsPrompt = await buildImSkillsPrompt({ variables: skillVariables });
  await exportSkillSubDocs({ variables: skillVariables }, imSkillsCacheDir);
  const userTextWithCapabilities = [
    ...(imSkillsPrompt ? [imSkillsPrompt, ""] : []),
    "[User message]",
    userText,
    "[/User message]",
  ].join("\n");

  // 设置活跃 prompt
  const controller = new AbortController();
  const now = Date.now();
  activePrompts.set(sessionId, {
    controller,
    stopped: false,
    startTime: now,
  });

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

  // 设置所有绑定群头像为 busy
  for (const cid of getChatsForSession(sessionId)) {
    setChatAvatar(token, cid, tool, "busy").catch(() => {});
  }

  const state: AccumulatorState = {
    accumulatedContent: "",
    finalText: "",
    finalCompleteText: "",
    chunkCount: 0,
  };

  let lastFileWrite = Date.now();
  const FILE_WRITE_INTERVAL_MS = 2000;

  try {
    for await (const unifiedMsg of adapter.prompt(sessionId, userTextWithCapabilities, cwd, controller.signal)) {
      for (const block of unifiedMsg.blocks) {
        accumulateBlockContent(block, state);

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
        setChatAvatar(token, cid, tool, "idle").catch(() => {});
      }
      console.log(`[${ts()}] Session ${sessionId} stream complete (content chunks: ${state.chunkCount})`);
      if (tid) logTrace(tid, "SESSION_END", { sessionId, chunks: state.chunkCount, finalTextLen: finalReply.length });
    }
  }
}

// ---------------------------------------------------------------------------
// ensureDisplayLoop — 每个 session 一个 display 循环，读文件更新所有绑定群的卡片
// ---------------------------------------------------------------------------

const CARD_ROTATE_MS = 9 * 60 * 1000;

export function ensureDisplayLoop(sessionId: string): void {
  if (displayLoops.has(sessionId)) return;

  let dotCount = 0;

  const interval = setInterval(() => {
    void (async () => {
      const state = await readStreamState(sessionId);
      if (!state) return;

      const chats = getChatsForSession(sessionId);
      if (chats.length === 0) {
        // 无绑定群，若 session 已结束则停止 loop
        if (state.status !== "running") {
          clearInterval(interval);
          displayLoops.delete(sessionId);
        }
        return;
      }

      const isTerminal = state.status !== "running";

      for (const chatId of chats) {
        try {
          // getTenantAccessToken 有缓存，多次调用开销低
          const tokenModule = await import("./feishu-platform.ts");
          const token = await tokenModule.getTenantAccessToken();
          const display = displayCards.get(chatId);

          if (isTerminal) {
            // 发送最终结果
            if (display) {
              while (display.cardBusy) await new Promise(r => setTimeout(r, 20));
              const nextSeq = display.sequence + 1;
              const headerTitle = state.status === "stopped" ? "已停止" : "完成";
              const headerTemplate = state.status === "stopped" ? "red" : undefined;
              const cardContent = state.accumulatedContent || " ";
              const doneCard = buildProgressCard(cardContent, { showStop: false, headerTitle, headerTemplate });
              await updateCardKitCard(token, display.cardId, doneCard, nextSeq).catch(() => {});
              displayCards.delete(chatId);
            }
            if (state.finalReply) {
              await sendTextReply(token, chatId, state.finalReply).catch(() => {});
            } else if (!display && state.accumulatedContent.trim()) {
              const short = truncateContent(state.accumulatedContent, 30, 4000);
              await sendTextReply(token, chatId, `[生成过程]\n${short}`).catch(() => {});
            }
            setChatAvatar(token, chatId, state.tool, "idle").catch(() => {});
          } else {
            // running: 创建或更新卡片
            if (!display) {
              const cardId = await createCardKitCard(token, buildProgressCard("", { showStop: true, headerTitle: "生成中..." })).catch(() => null);
              if (cardId) {
                await sendCardKitMessage(token, chatId, cardId).catch(() => null);
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
              if (display.cardBusy) continue;

              // 卡片轮转
              if (Date.now() - display.cardCreatedAt > CARD_ROTATE_MS) {
                display.cardBusy = true;
                try {
                  const oldSeqBase = display.sequence;
                  const oldDisplayContent = truncateContent(state.accumulatedContent + state.finalReply) || "处理中...";
                  const oldCard = buildProgressCard(oldDisplayContent, { showStop: false, headerTitle: "生成中...（上轮）" });
                  await updateCardKitCard(token, display.cardId, oldCard, oldSeqBase + 1).catch(() => {});
                  const newCardId = await createCardKitCard(token, buildProgressCard("", { showStop: true, headerTitle: "生成中..." }));
                  if (newCardId) {
                    await sendCardKitMessage(token, chatId, newCardId);
                    display.cardId = newCardId;
                    display.sequence = 1;
                    display.cardCreatedAt = Date.now();
                    display.lastSentContent = "";
                    display.streamErrorNotified = false;
                  }
                } catch (err) {
                  console.error(`[${ts()}] [CARDIKT] rotation FAIL for ${chatId}: ${(err as Error).message}`);
                } finally {
                  display.cardBusy = false;
                }
                continue;
              }

              dotCount = (dotCount % 9) + 1;
              const content = truncateContent(state.accumulatedContent + state.finalReply + "\n" + "。".repeat(dotCount));
              if (content === display.lastSentContent) continue;

              display.lastSentContent = content;
              display.cardBusy = true;
              const mySeq = display.sequence + 1;
              try {
                const card = buildProgressCard(content, { showStop: true, headerTitle: "生成中..." });
                await updateCardKitCard(token, display.cardId, card, mySeq);
                display.sequence = mySeq;
              } catch (err) {
                console.error(`[${ts()}] CardKit update error: chatId=${chatId} ${(err as Error).message}`);
                if (!display.streamErrorNotified) {
                  display.streamErrorNotified = true;
                  sendTextReply(token, chatId, "卡片更新失败，结果将以文本形式发送。").catch(() => {});
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
  const entries = Object.values(registry)
    .filter((record) => record.chatId && record.sessionId && record.tool)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 20);
  // 并行解析每个 session 的 model/effort（cursor 涉及异步 store IO）
  return Promise.all(
    entries.map(async (info) => {
      const { model, effort } = await resolveModelEffort(info.tool, info.sessionId);
      return {
        chatId: info.chatId,
        sessionId: info.sessionId,
        chatName: info.chatName || "",
        active: info.running === true,
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

export function _clearAdapterCacheForTest(): void {
  adapterCache.clear();
}
