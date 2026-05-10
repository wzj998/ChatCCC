import { getSessionInfo, unstable_v2_createSession, unstable_v2_resumeSession } from "@anthropic-ai/claude-agent-sdk";

import {
  CLAUDE_EFFORT,
  CLAUDE_MODEL,
  anthropicConfigDisplay,
  fileLog,
  getDefaultCwd,
  isSdkAnthropicDefault,
  ts,
} from "./config.ts";
import { buildProgressCard, getToolEmoji, truncateContent } from "./cards.ts";
import {
  createCardKitCard,
  sendCardKitMessage,
  updateCardKitCard,
} from "./cardkit.ts";
import { sendTextReply } from "./feishu-api.ts";

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

// 持久化会话信息，流式结束后不清除，供 /status 查询
export const sessionInfoMap = new Map<string, {
  sessionId: string;
  turnCount: number;
  lastContextTokens: number;
  startTime: number;
  model: string;
  effort: string;
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
// Claude session management
// ---------------------------------------------------------------------------

function claudeSdkSessionOptions(cwd: string): Record<string, unknown> {
  const o: Record<string, unknown> = {
    cwd,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    autoCompactEnabled: true,
  };
  if (!isSdkAnthropicDefault(CLAUDE_MODEL)) o.model = CLAUDE_MODEL;
  if (!isSdkAnthropicDefault(CLAUDE_EFFORT)) o.effort = CLAUDE_EFFORT;
  return o;
}

export async function initClaudeSession(): Promise<string> {
  const cwd = await getDefaultCwd();
  console.log(
    `[${ts()}] [STEP 1/5] Creating Claude session via SDK (model=${anthropicConfigDisplay(CLAUDE_MODEL)}, effort=${anthropicConfigDisplay(CLAUDE_EFFORT)}, cwd=${cwd})`
  );

  const session = unstable_v2_createSession(claudeSdkSessionOptions(cwd) as any);

  await session.send("ok");

  const stream = session.stream();

  const first = await stream.next();
  if (first.done || !(first.value as { session_id?: string }).session_id) {
    session.close();
    throw new Error("No session ID in Claude init event");
  }

  const initMsg = first.value as { session_id: string };
  const sessionId = initMsg.session_id;
  console.log(`[${ts()}]   → sessionId: ${sessionId}`);

  (async () => {
    try {
      for await (const _msg of stream) {
        // 静默消费，不做额外处理
      }
    } catch {
      // stream 异常不阻塞主流程
    } finally {
      session.close();
    }
  })();

  return sessionId;
}

export async function resumeAndPrompt(
  sessionId: string,
  userText: string,
  token: string,
  chatId: string,
  msgTimestamp: number
): Promise<void> {
  const cwd = (await getSessionInfo(sessionId))?.cwd ?? (await getDefaultCwd());
  console.log(
    `[${ts()}] Resuming Claude session: ${sessionId} (model=${anthropicConfigDisplay(CLAUDE_MODEL)}, effort=${anthropicConfigDisplay(CLAUDE_EFFORT)}, cwd=${cwd})`
  );

  const session = unstable_v2_resumeSession(sessionId, claudeSdkSessionOptions(cwd) as any);

  let cardId: string | null = null;
  chatSessionMap.set(chatId, {
    gen: ++sessionGen,
    close: () => session.close(),
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

  // 更新持久化会话信息
  const now = Date.now();
  const existingInfo = sessionInfoMap.get(chatId);
  sessionInfoMap.set(chatId, {
    sessionId,
    turnCount: (existingInfo?.turnCount ?? 0) + 1,
    lastContextTokens: existingInfo?.lastContextTokens ?? 0,
    startTime: now,
    model: anthropicConfigDisplay(CLAUDE_MODEL),
    effort: anthropicConfigDisplay(CLAUDE_EFFORT),
  });

  await session.send(userText);

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

  const stream = session.stream();

  let chunkCount = 0;
  let accumulatedContent = "";
  let finalText = "";

  let cardCreatedAt = Date.now();
  const CARD_ROTATE_MS = 9 * 60 * 1000; // 飞书 CardKit 流式超时 10 分钟，提前 1 分钟切换

  let dotCount = 0;
  let lastSentContent = "";
  let streamErrorNotified = false;
  let healthLogTicks = 0;
  const sendInterval = cardId ? setInterval(async () => {
    const cEntry = chatSessionMap.get(chatId);
    if (!cEntry || cEntry.stopped || cEntry.cardBusy) return;
    if (cEntry.cardId !== cardId) return;

    // 9 分钟超时：主动结束当前卡片流，创建新卡片继续
    if (Date.now() - cardCreatedAt > CARD_ROTATE_MS) {
      cEntry.cardBusy = true;
      const oldCardId = cardId;
      try {
        // 1. 用当前累积内容更新旧卡片为静态版本
        const oldSeqBase = cEntry.sequence;
        const oldDisplay = truncateContent(accumulatedContent + finalText) || "处理中...";
        const oldCard = buildProgressCard(oldDisplay, { showStop: false, headerTitle: "生成中...（上轮）" });
        await updateCardKitCard(token, oldCardId!, oldCard, oldSeqBase + 1).catch(() => {});
        // 2. 创建新卡片并发送
        const newCardId = await createCardKitCard(token, buildProgressCard("", { showStop: true, headerTitle: "生成中..." }));
        if (!newCardId) throw new Error("createCardKitCard returned empty");
        await sendCardKitMessage(token, chatId, newCardId);
        // 3. 切换到新卡片
        cardId = newCardId;
        cEntry.cardId = newCardId;
        cEntry.sequence = 1;
        cardCreatedAt = Date.now();
        lastSentContent = "";
        streamErrorNotified = false;
        console.log(`[${ts()}] [CARDIKT] rotated: old=${oldCardId} new=${newCardId} (9min timeout)`);
      } catch (err) {
        console.error(`[${ts()}] [CARDIKT] rotation FAIL: ${(err as Error).message}`);
      } finally {
        cEntry.cardBusy = false;
      }
      return;
    }

    dotCount = (dotCount % 9) + 1;
    const content = truncateContent(accumulatedContent + finalText + "\n" + "。".repeat(dotCount));
    if (content === lastSentContent) return;

    lastSentContent = content;
    cEntry.cardBusy = true;
    const mySeq = cEntry.sequence + 1;
    try {
      const card = buildProgressCard(content, { showStop: true, headerTitle: "生成中..." });
      await updateCardKitCard(token, cardId!, card, mySeq);
      cEntry.sequence = mySeq;
      cEntry.accumulatedContent = accumulatedContent;
      streamErrorNotified = false;
      healthLogTicks++;
      if (healthLogTicks % 10 === 0) {
        console.log(`[${ts()}] [CARDIKT] update health: seq=${mySeq} content=${accumulatedContent.length}chars text=${finalText.length}chars cardAge=${Math.round((Date.now() - cardCreatedAt) / 1000)}s`);
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
    for await (const msg of stream) {
      const sdkMsg = msg as {
        type?: string;
        message?: { content?: Array<{ type: string; thinking?: string; text?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean }> };
      };
      if ((sdkMsg.type === "assistant" || sdkMsg.type === "user") && sdkMsg.message?.content) {
        for (const block of sdkMsg.message.content) {

          if (block.type === "thinking" && block.thinking) {
            chunkCount++;
            accumulatedContent += block.thinking;
          } else if (block.type === "tool_use") {
            const toolName = (block as { name?: string }).name ?? "unknown";
            const toolInput = (block as { input?: unknown }).input;
            const inputStr = typeof toolInput === "object" ? JSON.stringify(toolInput) : String(toolInput ?? "");
            const shortInput = inputStr.length > 300 ? inputStr.slice(0, 300) + "..." : inputStr;
            accumulatedContent += `\n\n${getToolEmoji(toolName)} **${toolName}**\n\`${shortInput}\`\n`;
          } else if (block.type === "tool_result") {
            const toolUseId = (block as { tool_use_id?: string }).tool_use_id ?? "";
            const resultContent = (block as { content?: unknown }).content;
            let resultStr = "";
            if (typeof resultContent === "string") {
              resultStr = resultContent;
            } else if (Array.isArray(resultContent)) {
              resultStr = resultContent.map((c: { type?: string; text?: string }) => c.text ?? "").join("");
            } else if (resultContent) {
              resultStr = JSON.stringify(resultContent);
            }
            const shortResult = resultStr.length > 200 ? resultStr.slice(0, 200) + "..." : resultStr;
            const isError = (block as { is_error?: boolean }).is_error;
            const icon = isError ? "❌" : "✅";
            accumulatedContent += `${icon} *${toolUseId.slice(-6)}*: ${shortResult}\n`;
          } else if (block.type === "redacted_thinking") {
            accumulatedContent += "\n\n⚠️ 内容被安全过滤\n";
          } else if (block.type === "search_result") {
            const searchQuery = (block as { query?: string }).query ?? "";
            accumulatedContent += `\n\n🔍 联网搜索: **${searchQuery}**\n`;
          } else if (block.type === "text" && block.text) {
            finalText += block.text;
            const entry = chatSessionMap.get(chatId);
            if (entry) entry.finalText = finalText;
          }
        }
      } else if (sdkMsg.type === "system" && (sdkMsg as { subtype?: string }).subtype === "compact_boundary") {
        const compactMeta = (sdkMsg as { compact_metadata?: { trigger?: string; pre_tokens?: number; post_tokens?: number } }).compact_metadata;
        if (compactMeta) {
          const triggerLabel = compactMeta.trigger === "manual" ? "手动" : "自动";
          accumulatedContent += `\n\n🔄 上下文压缩(${triggerLabel}): **${compactMeta.pre_tokens}** → **${compactMeta.post_tokens}** tokens\n`;
          // 更新持久化上下文 token 数
          if (compactMeta.post_tokens) {
            const info = sessionInfoMap.get(chatId);
            if (info) { info.lastContextTokens = compactMeta.post_tokens; }
          }
        }
      }
    }
  } catch (streamErr) {
    console.error(`[${ts()}] [STREAM] Error in stream loop: ${(streamErr as Error).message}`);
  } finally {
    if (sendInterval) clearInterval(sendInterval);
    session.close();
  }

  const cEntry = chatSessionMap.get(chatId);
  if (!cEntry || cEntry.gen !== myGen) return;
  const wasStopped = cEntry.stopped;
  chatSessionMap.delete(chatId);

  if (cardId && accumulatedContent) {
    while (cEntry.cardBusy) {
      await new Promise(r => setTimeout(r, 20));
    }
    const nextSeq = cEntry.sequence + 1;
    if (wasStopped) {
      const stopCard = buildProgressCard(accumulatedContent || "已停止", { showStop: false, headerTitle: "已停止", headerTemplate: "red" });
      await updateCardKitCard(token, cardId, stopCard, nextSeq).catch((err) => {
        console.error(`[${ts()}] CardKit finalize: chatId=${chatId} cardId=${cardId} ${(err as Error).message}`);
        fileLog.flush();
      });
    } else {
      const doneCard = buildProgressCard(accumulatedContent, { showStop: false, headerTitle: "完成" });
      await updateCardKitCard(token, cardId, doneCard, nextSeq).catch((err) => {
        console.error(`[${ts()}] CardKit finalize: chatId=${chatId} cardId=${cardId} ${(err as Error).message}`);
        fileLog.flush();
        sendTextReply(token, chatId, "⚠️ 卡片最终更新失败。").catch(() => {});
      });
    }
  }

  // Text fallback: if CardKit streaming broke, always send full result as text
  if (wasStopped) {
    if (finalText.trim()) {
      await sendTextReply(token, chatId, finalText.trim()).catch((err) =>
        console.error(`[${ts()}] Failed to send partial text: ${(err as Error).message}`)
      );
    }
    console.log(`[${ts()}] Session ${sessionId} stopped by user (content chunks: ${chunkCount})`);
    return;
  }

  if (streamErrorNotified) {
    // CardKit streaming failed — send everything as text to ensure user sees the result
    if (accumulatedContent.trim()) {
      const shortContent = truncateContent(accumulatedContent, 30, 4000);
      await sendTextReply(token, chatId, `[生成过程]\n${shortContent}`).catch((err) =>
        console.error(`[${ts()}] Failed to send content fallback: ${(err as Error).message}`)
      );
    }
    if (finalText.trim()) {
      await sendTextReply(token, chatId, finalText.trim()).catch((err) =>
        console.error(`[${ts()}] Failed to send text fallback: ${(err as Error).message}`)
      );
    }
  } else {
    // Normal path: card streaming worked fine
    if (finalText.trim()) {
      await sendTextReply(token, chatId, finalText.trim()).catch((err) =>
        console.error(`[${ts()}] Failed to send final text: ${(err as Error).message}`)
      );
    } else if (!cardId && accumulatedContent.trim()) {
      const shortContent = truncateContent(accumulatedContent, 30, 4000);
      await sendTextReply(token, chatId, `[生成过程]\n${shortContent}`).catch((err) =>
        console.error(`[${ts()}] Failed to send content text: ${(err as Error).message}`)
      );
    }
  }

  console.log(`[${ts()}] Session ${sessionId} stream complete (content chunks: ${chunkCount})`);
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

/**
 * 获取所有已记录的会话状态列表（供 /sessions 命令使用）
 */
export function getAllSessionsStatus(): Array<{
  chatId: string;
  sessionId: string;
  active: boolean;
  turnCount: number;
  startTime: number;
  model: string;
  effort: string;
}> {
  const result: Array<{
    chatId: string;
    sessionId: string;
    active: boolean;
    turnCount: number;
    startTime: number;
    model: string;
    effort: string;
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
    });
  }
  return result;
}