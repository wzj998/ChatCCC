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
import { sendTextReply, setChatAvatar } from "./feishu-api.ts";
import { logTrace } from "./trace.ts";
import type { UnifiedBlock } from "./adapters/adapter-interface.ts";
import type { ToolAdapter } from "./adapters/adapter-interface.ts";
import { createClaudeAdapter } from "./adapters/claude-adapter.ts";
import { createCursorAdapter } from "./adapters/cursor-adapter.ts";
import { createCodexAdapter } from "./adapters/codex-adapter.ts";
import {
  createAgentImageGrant,
  revokeAgentImageGrant,
} from "./agent-image-rpc.ts";
import {
  createAgentFileGrant,
  revokeAgentFileGrant,
} from "./agent-file-rpc.ts";
import { setSessionGrants, clearSessionGrants, AGENT_SESSION_GRANTS_PATH } from "./agent-grants-rpc.ts";
import { buildImSkillsPrompt, exportSkillSubDocs } from "./im-skills.ts";

// ---------------------------------------------------------------------------
// Shared state (imported by index.ts)
// ---------------------------------------------------------------------------

export const processedMessages = new Set<string>();
export const MAX_PROCESSED = 5000;

export let sessionGen = 0;
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
 * sessionInfoMap 记录每个 chatId 当前会话的"轻量元数据"：
 *
 * 注意此处**不**保存 model / effort：
 *   - Claude 会话：model/effort 由 ChatCCC 启动时的环境变量决定（CLAUDE_MODEL/EFFORT），
 *     getSessionStatus 直接读全局配置即可。
 *   - Cursor 会话：model 是 cursor-agent 自报的运行时值（如 Composer 2 Fast），
 *     由 cursor-adapter 持久化到 cursor-session-meta.json，
 *     getSessionStatus 通过 adapter.getSessionInfo 实时获取；effort 概念不适用。
 *
 * 把 model/effort 从 sessionInfoMap 移除是为了消除"硬塞 CLAUDE_* 给 Cursor"
 * 的不一致 bug——/status、/sessions 必须显示真实工具的真实信息。
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
  console.log(`[${ts()}] [RESET] State cleared (dedup + active sessions)`);
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
  const tid = traceId ?? "";
  const adapter = getAdapterForTool(tool);
  const info = await adapter.getSessionInfo(sessionId);
  const cwd = info?.cwd ?? (await getDefaultCwd(chatId));
  if (tid) logTrace(tid, "SESSION_START", { sessionId, tool, cwd, turn: (sessionInfoMap.get(chatId)?.turnCount ?? 0) + 1 });
  console.log(
    `[${ts()}] Resuming ${adapter.displayName} session: ${sessionId} (${formatToolConfigForLog(tool, info?.model)}, cwd=${cwd})`
  );
  const imageGrant = createAgentImageGrant({
    chatId,
    sessionId,
    cwd,
    port: CHATCCC_PORT,
    traceId: tid || undefined,
  });
  const fileGrant = createAgentFileGrant({
    chatId,
    sessionId,
    cwd,
    port: CHATCCC_PORT,
    traceId: tid || undefined,
  });
  const feishuSkillDir = join(PROJECT_ROOT, "im-skills", "feishu-skill");
  const imSkillsCacheDir = join(USER_DATA_DIR, "im-skills");
  const skillVariables = {
    cwd,
    session_id: sessionId,
    im_skills_cache_dir: imSkillsCacheDir,
    session_grants_url: `http://127.0.0.1:${CHATCCC_PORT}${AGENT_SESSION_GRANTS_PATH}`,
    send_image_url: imageGrant.url,
    send_image_script: join(feishuSkillDir, "send-image.mjs"),
    send_file_script: join(feishuSkillDir, "send-file.mjs"),
    download_video_script: join(feishuSkillDir, "download-video.mjs"),
  };
  setSessionGrants(sessionId, imageGrant, fileGrant);
  const imSkillsPrompt = await buildImSkillsPrompt({ variables: skillVariables });
  // 渲染子文档到缓存目录，供 Agent 按需读取
  await exportSkillSubDocs({ variables: skillVariables }, imSkillsCacheDir);
  const userTextWithCapabilities = [
    ...(imSkillsPrompt ? [imSkillsPrompt, ""] : []),
    "[User message]",
    userText,
    "[/User message]",
  ].join("\n");

  const controller = new AbortController();

  chatSessionMap.set(chatId, {
    gen: ++sessionGen,
    close: () => controller.abort(),
    cardId: null,
    stopped: false,
    accumulatedContent: "",
    finalText: "",
    spinnerTimer: null,
    msgTimestamp,
    sequence: 0,
    cardBusy: false,
  });
  const myGen = sessionGen;

  setChatAvatar(token, chatId, tool, "busy").catch(() => {});

  const now = Date.now();
  const existingInfo = sessionInfoMap.get(chatId);
  sessionInfoMap.set(chatId, {
    sessionId,
    turnCount: (existingInfo?.turnCount ?? 0) + 1,
    lastContextTokens: existingInfo?.lastContextTokens ?? 0,
    startTime: now,
    tool,
  });

  let cardId: string | null = null;
  cardId = await createCardKitCard(token, buildProgressCard("", { showStop: true, headerTitle: "生成中..." })).catch((err) => {
    if (tid) logTrace(tid, "CARD_CREATE_FAIL", { error: (err as Error).message });
    console.error(`[${ts()}] [CARDIKT] createCard FAIL: chatId=${chatId} ${(err as Error).message}`);
    fileLog.flush();
    sendTextReply(token, chatId, "⚠️ 流式卡片创建失败（可能因限流），将使用文本回复。").catch(() => {});
    return null;
  });
  if (cardId) {
    const cEntry = chatSessionMap.get(chatId);
    if (cEntry) { cEntry.cardId = cardId; cEntry.sequence = 1; }
    const sendOk = await sendCardKitMessage(token, chatId, cardId).catch((err) => {
      if (tid) logTrace(tid, "CARD_SEND_FAIL", { cardId, error: (err as Error).message });
      console.error(`[${ts()}] [CARDIKT] sendMessage FAIL: chatId=${chatId} cardId=${cardId} ${(err as Error).message}`);
      fileLog.flush();
      return false;
    });
    if (!sendOk) {
      sendTextReply(token, chatId, "⚠️ 卡片发送失败，将使用文本回复。").catch(() => {});
      cardId = null;
      if (cEntry) { cEntry.cardId = null; cEntry.sequence = 0; }
    }
  }

  const state: AccumulatorState = {
    accumulatedContent: "",
    finalText: "",
    finalCompleteText: "",
    chunkCount: 0,
  };

  let cardCreatedAt = Date.now();
  const CARD_ROTATE_MS = 9 * 60 * 1000;

  let dotCount = 0;
  let lastSentContent = "";
  let streamErrorNotified = false;
  let healthLogTicks = 0;
  // 兜底：setInterval 不 await 异步回调，回调内任何漏接的异常都会变成
  // unhandledRejection 进而（在 Node 默认策略下）让进程崩。这里用 IIFE + .catch
  // 整体兜一层，配合内部两个细粒度 try/catch 一起守住。
  const sendInterval = cardId ? setInterval(() => {
    void (async () => {
    const cEntry = chatSessionMap.get(chatId);
    if (!cEntry || cEntry.stopped || cEntry.cardBusy) return;
    if (cEntry.cardId !== cardId) return;

    if (Date.now() - cardCreatedAt > CARD_ROTATE_MS) {
      cEntry.cardBusy = true;
      try {
        const oldSeqBase = cEntry.sequence;
        const oldDisplay = truncateContent(state.accumulatedContent + pickFinalReply(state)) || "处理中...";
        const oldCard = buildProgressCard(oldDisplay, { showStop: false, headerTitle: "生成中...（上轮）" });
        await updateCardKitCard(token, cardId!, oldCard, oldSeqBase + 1).catch(() => {});
        const newCardId = await createCardKitCard(token, buildProgressCard("", { showStop: true, headerTitle: "生成中..." }));
        if (!newCardId) throw new Error("createCardKitCard returned empty");
        await sendCardKitMessage(token, chatId, newCardId);
        cardId = newCardId;
        cEntry.cardId = newCardId;
        cEntry.sequence = 1;
        cardCreatedAt = Date.now();
        lastSentContent = "";
        streamErrorNotified = false;
        console.log(`[${ts()}] [CARDIKT] rotated: old=${oldSeqBase} new=${newCardId} (9min timeout)`);
      } catch (err) {
        console.error(`[${ts()}] [CARDIKT] rotation FAIL: ${(err as Error).message}`);
      } finally {
        cEntry.cardBusy = false;
      }
      return;
    }

    dotCount = (dotCount % 9) + 1;
    const content = truncateContent(state.accumulatedContent + pickFinalReply(state) + "\n" + "。".repeat(dotCount));
    if (content === lastSentContent) return;

    lastSentContent = content;
    cEntry.cardBusy = true;
    const mySeq = cEntry.sequence + 1;
    try {
      const card = buildProgressCard(content, { showStop: true, headerTitle: "生成中..." });
      await updateCardKitCard(token, cardId!, card, mySeq);
      cEntry.sequence = mySeq;
      cEntry.accumulatedContent = state.accumulatedContent;
      streamErrorNotified = false;
      healthLogTicks++;
      if (healthLogTicks % 10 === 0) {
        console.log(`[${ts()}] [CARDIKT] update health: seq=${mySeq} content=${state.accumulatedContent.length}chars text=${state.finalText.length}chars cardAge=${Math.round((Date.now() - cardCreatedAt) / 1000)}s`);
      }
    } catch (err) {
      console.error(`[${ts()}] CardKit update error: chatId=${chatId} cardId=${cardId} seq=${mySeq} ${(err as Error).message}`);
      if (!streamErrorNotified) {
        streamErrorNotified = true;
        sendTextReply(token, chatId, "⚠️ 卡片更新失败，结果将以文本形式发送。").catch(() => {});
      }
    } finally {
      cEntry.cardBusy = false;
    }
    })().catch((err: unknown) => {
      const e = err instanceof Error ? err : new Error(String(err));
      console.error(`[${ts()}] [CARDIKT] spinner tick uncaught: ${e.message}\n${e.stack ?? ""}`);
      const entry = chatSessionMap.get(chatId);
      if (entry) entry.cardBusy = false;
    });
  }, 3000) : null;
  if (sendInterval) {
    const entry = chatSessionMap.get(chatId);
    if (entry) entry.spinnerTimer = sendInterval;
  }

  try {
    for await (const unifiedMsg of adapter.prompt(sessionId, userTextWithCapabilities, cwd, controller.signal)) {
      for (const block of unifiedMsg.blocks) {
        accumulateBlockContent(block, state);

        // 更新持久化上下文 token 数（compact_boundary 事件）
        if (block.type === "compact_boundary" && block.post_tokens) {
          const info = sessionInfoMap.get(chatId);
          if (info) { info.lastContextTokens = block.post_tokens; }
        }
      }
    }
  } catch (streamErr) {
    console.error(`[${ts()}] [STREAM] Error in stream loop: ${(streamErr as Error).message}`);
  } finally {
    if (sendInterval) clearInterval(sendInterval);
    revokeAgentImageGrant(imageGrant.token);
    revokeAgentFileGrant(fileGrant.token);
    clearSessionGrants(sessionId);
  }

  const cEntry = chatSessionMap.get(chatId);
  if (!cEntry || cEntry.gen !== myGen) return;
  const wasStopped = cEntry.stopped;
  chatSessionMap.delete(chatId);
  setChatAvatar(token, chatId, tool, "idle").catch(() => {});

  const finalCardContent = state.accumulatedContent || " ";
  if (cardId) {
    while (cEntry.cardBusy) {
      await new Promise(r => setTimeout(r, 20));
    }
    const nextSeq = cEntry.sequence + 1;
    if (wasStopped) {
      const stopCard = buildProgressCard(finalCardContent, { showStop: false, headerTitle: "已停止", headerTemplate: "red" });
      await updateCardKitCard(token, cardId, stopCard, nextSeq).catch((err) => {
        console.error(`[${ts()}] CardKit finalize: chatId=${chatId} cardId=${cardId} ${(err as Error).message}`);
        fileLog.flush();
      });
    } else {
      const doneCard = buildProgressCard(finalCardContent, { showStop: false, headerTitle: "完成" });
      await updateCardKitCard(token, cardId, doneCard, nextSeq).catch((err) => {
        console.error(`[${ts()}] CardKit finalize: chatId=${chatId} cardId=${cardId} ${(err as Error).message}`);
        fileLog.flush();
        sendTextReply(token, chatId, "⚠️ 卡片最终更新失败。").catch(() => {});
      });
    }
  }

  // 在 partial 累加 vs 适配器给出的 final 完整文本之间挑选；
  // Cursor 流末会发 final 完整快照，若与 partial 累加都直接发会出现两段重复。
  const finalReply = pickFinalReply(state).trim();

  if (wasStopped) {
    if (finalReply) {
      await sendTextReply(token, chatId, finalReply).catch((err) =>
        console.error(`[${ts()}] Failed to send partial text: ${(err as Error).message}`)
      );
    }
    console.log(`[${ts()}] Session ${sessionId} stopped by user (content chunks: ${state.chunkCount})`);
    if (tid) logTrace(tid, "SESSION_END", { sessionId, outcome: "stopped", chunks: state.chunkCount });
    return;
  }

  if (streamErrorNotified) {
    if (state.accumulatedContent.trim()) {
      const shortContent = truncateContent(state.accumulatedContent, 30, 4000);
      await sendTextReply(token, chatId, `[生成过程]\n${shortContent}`).catch((err) =>
        console.error(`[${ts()}] Failed to send content fallback: ${(err as Error).message}`)
      );
    }
    if (finalReply) {
      await sendTextReply(token, chatId, finalReply).catch((err) =>
        console.error(`[${ts()}] Failed to send text fallback: ${(err as Error).message}`)
      );
    }
  } else {
    if (finalReply) {
      await sendTextReply(token, chatId, finalReply).catch((err) =>
        console.error(`[${ts()}] Failed to send final text: ${(err as Error).message}`)
      );
    } else if (!cardId && state.accumulatedContent.trim()) {
      const shortContent = truncateContent(state.accumulatedContent, 30, 4000);
      await sendTextReply(token, chatId, `[生成过程]\n${shortContent}`).catch((err) =>
        console.error(`[${ts()}] Failed to send content text: ${(err as Error).message}`)
      );
    }
  }

  console.log(`[${ts()}] Session ${sessionId} stream complete (content chunks: ${state.chunkCount})`);
  if (tid) logTrace(tid, "SESSION_END", { sessionId, chunks: state.chunkCount, finalTextLen: finalReply.length });
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

  const active = chatSessionMap.get(chatId);
  const { model, effort } = await resolveModelEffort(info.tool, info.sessionId);

  return {
    sessionId: info.sessionId,
    running: active !== undefined && !active.stopped,
    turnCount: info.turnCount,
    lastContextTokens: info.lastContextTokens,
    startTime: info.startTime,
    model,
    effort,
    accumulatedLength: active ? active.accumulatedContent.length + active.finalText.length : 0,
  };
}

export interface SessionsListEntry {
  chatId: string;
  sessionId: string;
  active: boolean;
  turnCount: number;
  startTime: number;
  model: string;
  /** null 表示该工具没有 effort 概念（如 Cursor） */
  effort: string | null;
  tool: string;
}

export async function getAllSessionsStatus(): Promise<SessionsListEntry[]> {
  const entries = Array.from(sessionInfoMap.entries());
  // 并行解析每个 session 的 model/effort（cursor 涉及异步 store IO）
  return Promise.all(
    entries.map(async ([chatId, info]) => {
      const active = chatSessionMap.get(chatId);
      const { model, effort } = await resolveModelEffort(info.tool, info.sessionId);
      return {
        chatId,
        sessionId: info.sessionId,
        active: active !== undefined && !active.stopped,
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
