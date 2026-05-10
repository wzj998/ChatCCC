import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import {
  CLAUDE_EFFORT,
  CLAUDE_MODEL,
  SESSIONS_FILE,
  addRecentDir,
  anthropicConfigDisplay,
  fileLog,
  getDefaultCwd,
  isSdkAnthropicDefault,
  toolDisplayName,
  ts,
} from "./config.ts";
import { buildProgressCard, getToolEmoji, truncateContent } from "./cards.ts";
import {
  createCardKitCard,
  sendCardKitMessage,
  updateCardKitCard,
} from "./cardkit.ts";
import { sendTextReply } from "./feishu-api.ts";
import type { UnifiedBlock } from "./adapters/adapter-interface.ts";
import type { ToolAdapter } from "./adapters/adapter-interface.ts";
import { createClaudeAdapter } from "./adapters/claude-adapter.ts";
import { createCursorAdapter } from "./adapters/cursor-adapter.ts";

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

export const sessionInfoMap = new Map<string, {
  sessionId: string;
  turnCount: number;
  lastContextTokens: number;
  startTime: number;
  model: string;
  effort: string;
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
  } else {
    adapter = createClaudeAdapter({
      model: CLAUDE_MODEL,
      effort: CLAUDE_EFFORT,
      isDefault: isSdkAnthropicDefault,
    });
  }
  adapterCache.set(tool, adapter);
  return adapter;
}

// ---------------------------------------------------------------------------
// Session tool persistence (.claude/sessions.json)
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
  finalText: string;
  chunkCount: number;
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
// Claude session management
// ---------------------------------------------------------------------------

export async function initClaudeSession(tool: string): Promise<string> {
  const cwd = await getDefaultCwd();
  const adapter = getAdapterForTool(tool);
  console.log(
    `[${ts()}] [STEP 1/5] Creating ${adapter.displayName} session (model=${anthropicConfigDisplay(CLAUDE_MODEL)}, effort=${anthropicConfigDisplay(CLAUDE_EFFORT)}, cwd=${cwd})`
  );

  const result = await adapter.createSession(cwd);
  const sessionId = result.sessionId;
  console.log(`[${ts()}]   → sessionId: ${sessionId}`);

  await saveSessionTool(sessionId, tool);

  await addRecentDir(cwd);

  return sessionId;
}

export async function resumeAndPrompt(
  sessionId: string,
  userText: string,
  token: string,
  chatId: string,
  msgTimestamp: number,
  tool: string,
): Promise<void> {
  const adapter = getAdapterForTool(tool);
  const info = await adapter.getSessionInfo(sessionId);
  const cwd = info?.cwd ?? (await getDefaultCwd());
  console.log(
    `[${ts()}] Resuming ${adapter.displayName} session: ${sessionId} (model=${anthropicConfigDisplay(CLAUDE_MODEL)}, effort=${anthropicConfigDisplay(CLAUDE_EFFORT)}, cwd=${cwd})`
  );

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

  const now = Date.now();
  const existingInfo = sessionInfoMap.get(chatId);
  sessionInfoMap.set(chatId, {
    sessionId,
    turnCount: (existingInfo?.turnCount ?? 0) + 1,
    lastContextTokens: existingInfo?.lastContextTokens ?? 0,
    startTime: now,
    model: anthropicConfigDisplay(CLAUDE_MODEL),
    effort: anthropicConfigDisplay(CLAUDE_EFFORT),
    tool,
  });

  let cardId: string | null = null;
  cardId = await createCardKitCard(token, buildProgressCard("", { showStop: true, headerTitle: "生成中..." })).catch((err) => {
    console.error(`[${ts()}] [CARDIKT] createCard FAIL: chatId=${chatId} ${(err as Error).message}`);
    fileLog.flush();
    sendTextReply(token, chatId, "⚠️ 流式卡片创建失败（可能因限流），将使用文本回复。").catch(() => {});
    return null;
  });
  if (cardId) {
    const cEntry = chatSessionMap.get(chatId);
    if (cEntry) { cEntry.cardId = cardId; cEntry.sequence = 1; }
    const sendOk = await sendCardKitMessage(token, chatId, cardId).catch((err) => {
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
    chunkCount: 0,
  };

  let cardCreatedAt = Date.now();
  const CARD_ROTATE_MS = 9 * 60 * 1000;

  let dotCount = 0;
  let lastSentContent = "";
  let streamErrorNotified = false;
  let healthLogTicks = 0;
  const sendInterval = cardId ? setInterval(async () => {
    const cEntry = chatSessionMap.get(chatId);
    if (!cEntry || cEntry.stopped || cEntry.cardBusy) return;
    if (cEntry.cardId !== cardId) return;

    if (Date.now() - cardCreatedAt > CARD_ROTATE_MS) {
      cEntry.cardBusy = true;
      try {
        const oldSeqBase = cEntry.sequence;
        const oldDisplay = truncateContent(state.accumulatedContent + state.finalText) || "处理中...";
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
    const content = truncateContent(state.accumulatedContent + state.finalText + "\n" + "。".repeat(dotCount));
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
  }, 3000) : null;
  if (sendInterval) {
    const entry = chatSessionMap.get(chatId);
    if (entry) entry.spinnerTimer = sendInterval;
  }

  try {
    for await (const unifiedMsg of adapter.prompt(sessionId, userText, cwd, controller.signal)) {
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
  }

  const cEntry = chatSessionMap.get(chatId);
  if (!cEntry || cEntry.gen !== myGen) return;
  const wasStopped = cEntry.stopped;
  chatSessionMap.delete(chatId);

  if (cardId && state.accumulatedContent) {
    while (cEntry.cardBusy) {
      await new Promise(r => setTimeout(r, 20));
    }
    const nextSeq = cEntry.sequence + 1;
    if (wasStopped) {
      const stopCard = buildProgressCard(state.accumulatedContent || "已停止", { showStop: false, headerTitle: "已停止", headerTemplate: "red" });
      await updateCardKitCard(token, cardId, stopCard, nextSeq).catch((err) => {
        console.error(`[${ts()}] CardKit finalize: chatId=${chatId} cardId=${cardId} ${(err as Error).message}`);
        fileLog.flush();
      });
    } else {
      const doneCard = buildProgressCard(state.accumulatedContent, { showStop: false, headerTitle: "完成" });
      await updateCardKitCard(token, cardId, doneCard, nextSeq).catch((err) => {
        console.error(`[${ts()}] CardKit finalize: chatId=${chatId} cardId=${cardId} ${(err as Error).message}`);
        fileLog.flush();
        sendTextReply(token, chatId, "⚠️ 卡片最终更新失败。").catch(() => {});
      });
    }
  }

  if (wasStopped) {
    if (state.finalText.trim()) {
      await sendTextReply(token, chatId, state.finalText.trim()).catch((err) =>
        console.error(`[${ts()}] Failed to send partial text: ${(err as Error).message}`)
      );
    }
    console.log(`[${ts()}] Session ${sessionId} stopped by user (content chunks: ${state.chunkCount})`);
    return;
  }

  if (streamErrorNotified) {
    if (state.accumulatedContent.trim()) {
      const shortContent = truncateContent(state.accumulatedContent, 30, 4000);
      await sendTextReply(token, chatId, `[生成过程]\n${shortContent}`).catch((err) =>
        console.error(`[${ts()}] Failed to send content fallback: ${(err as Error).message}`)
      );
    }
    if (state.finalText.trim()) {
      await sendTextReply(token, chatId, state.finalText.trim()).catch((err) =>
        console.error(`[${ts()}] Failed to send text fallback: ${(err as Error).message}`)
      );
    }
  } else {
    if (state.finalText.trim()) {
      await sendTextReply(token, chatId, state.finalText.trim()).catch((err) =>
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
}

// ---------------------------------------------------------------------------
// Session status query (供 /status 命令使用)
// ---------------------------------------------------------------------------

export interface SessionStatus {
  sessionId: string;
  running: boolean;
  turnCount: number;
  lastContextTokens: number;
  startTime: number;
  model: string;
  effort: string;
  accumulatedLength: number;
}

export function getSessionStatus(chatId: string): SessionStatus | null {
  const info = sessionInfoMap.get(chatId);
  if (!info) return null;

  const active = chatSessionMap.get(chatId);
  return {
    sessionId: info.sessionId,
    running: active !== undefined && !active.stopped,
    turnCount: info.turnCount,
    lastContextTokens: info.lastContextTokens,
    startTime: info.startTime,
    model: anthropicConfigDisplay(info.model),
    effort: anthropicConfigDisplay(info.effort),
    accumulatedLength: active ? active.accumulatedContent.length + active.finalText.length : 0,
  };
}

export function getAllSessionsStatus(): Array<{
  chatId: string;
  sessionId: string;
  active: boolean;
  turnCount: number;
  startTime: number;
  model: string;
  effort: string;
  tool: string;
}> {
  const result: Array<{
    chatId: string;
    sessionId: string;
    active: boolean;
    turnCount: number;
    startTime: number;
    model: string;
    effort: string;
    tool: string;
  }> = [];
  for (const [chatId, info] of sessionInfoMap) {
    const active = chatSessionMap.get(chatId);
    result.push({
      chatId,
      sessionId: info.sessionId,
      active: active !== undefined && !active.stopped,
      turnCount: info.turnCount,
      startTime: info.startTime,
      model: info.model,
      effort: info.effort,
      tool: info.tool,
    });
  }
  return result;
}