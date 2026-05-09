/**
 * ChatCCC — Feishu Bot Bridge for Claude Code (TypeScript)
 * =================================================================
 * When a user sends "/new" to the bot:
 *   1. Create a Claude session via Agent SDK, get session ID from init event
 *   2. Create a new Feishu group chat and add the user
 *   3. Rename the group (name + description) to the session ID
 *   4. Stream SDK output to logs/session-<session-id>.jsonl
 *   5. Reply to the user with session ID and resume instructions
 *
 * Auto-resume: when any message is received in a Claude session group
 * (group description contains "Claude Session:"), the bot extracts the
 * session ID, resumes the session via SDK, sends the user's text, and
 * streams the response to the session's jsonl file.
 *
 * Buttons: thinking cards have a 停止 button; help messages have /new and /restart buttons.
 *
 * Usage:
 *   npm run dev
 *   npm run start
 *   npm run demo:create-group -- --local   (local relay mode)
 */

import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { resolve, dirname, basename } from "node:path";

import { WSClient, EventDispatcher } from "@larksuiteoapi/node-sdk";
import WebSocket from "ws";

import { ensureSingleInstance, createRelayServer } from "./shared.ts";
import {
  APP_ID,
  APP_SECRET,
  BASE_URL,
  CLAUDE_MODEL,
  LOCAL_RELAY_URL,
  PID_FILE,
  PROJECT_ROOT,
  USE_LOCAL,
  appendChatLog,
  fileLog,
  getWorkingDir,
  setWorkingDir,
  ts,
} from "./config.ts";
import {
  addReaction,
  createGroupChat,
  extractSessionId,
  getChatInfo,
  getTenantAccessToken,
  recallMessage,
  sendCardReply,
  sendTextReply,
  updateCardMessage,
  updateChatInfo,
  sendRestartCard,
} from "./feishu-api.ts";
import { buildHelpCard, buildStatusCard, buildThinkingCardV2, buildCdContent } from "./cards.ts";
import { setCardKitSettings, updateCardKitCard } from "./cardkit.ts";
import {
  MAX_PROCESSED,
  chatSessionMap,
  getSessionStatus,
  initClaudeSession,
  processedMessages,
  resetState,
  resumeAndPrompt,
  sessionInfoMap,
} from "./session.ts";

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

interface InnerEvent {
  message?: { message_id?: string; message_type?: string; content?: string; chat_id?: string; create_time?: string };
  sender?: { sender_id?: { open_id?: string; union_id?: string } };
}

type Evt = { event?: InnerEvent } & InnerEvent;

function getInnerEvent(data: Evt): InnerEvent {
  return (data.event ?? data) as InnerEvent;
}

function extractText(message: { message_type?: string; content?: string }): string {
  const contentStr = message.content ?? "{}";
  let content: Record<string, unknown>;
  try { content = JSON.parse(contentStr); } catch { return ""; }

  if (message.message_type === "text") {
    let text = (content.text ?? "") as string;
    text = text.replace(/<\/?p[^>]*>/gi, "");
    text = text.replace(/<br\s*\/?>/gi, "\n");
    text = text.replace(/&nbsp;/gi, " ");
    return text.trim();
  }
  return "";
}

// ---------------------------------------------------------------------------
// Card action helper: parse button click into text command
// ---------------------------------------------------------------------------

interface CardActionResult {
  text: string;
  chatId: string;
  openId: string;
}

function parseCardAction(data: unknown): CardActionResult | null {
  const raw = (data as Record<string, unknown>)?.event ?? data;
  const action = (raw as Record<string, unknown>)?.action as { value?: unknown } | undefined;
  if (!action?.value) return null;

  let cmd: string | undefined;
  if (typeof action.value === "object" && action.value !== null) {
    cmd = (action.value as Record<string, string>).action;
  } else if (typeof action.value === "string") {
    try {
      let v: unknown = JSON.parse(action.value);
      if (typeof v === "string") v = JSON.parse(v);
      cmd = (v as { cmd?: string; action?: string }).cmd ?? (v as { action?: string }).action;
    } catch { return null; }
  }
  if (!cmd) return null;

  const CMD_MAP: Record<string, string> = { stop: "/stop", new: "/new", restart: "/restart", status: "/status", cd: "/cd" };
  const text = CMD_MAP[cmd] ?? "";
  if (!text) return null;

  const chatId =
    ((raw as Record<string, unknown>).open_chat_id as string) ??
    ((raw as Record<string, unknown>).context as Record<string, unknown>)?.open_chat_id as string ??
    ((raw as Record<string, unknown>).message as Record<string, unknown>)?.chat_id as string ??
    "";
  const openId =
    ((raw as Record<string, unknown>).operator as Record<string, unknown>)?.open_id as string ??
    "";

  return { text, chatId, openId };
}

// ---------------------------------------------------------------------------
// WebSocket relay broadcast
// ---------------------------------------------------------------------------

let broadcastToRelay: (data: unknown) => void = () => {};

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

async function handleCommand(text: string, chatId: string, openId: string, msgTimestamp: number): Promise<void> {
  if (text === "/restart") {
    const restartToken = await getTenantAccessToken();
    await sendTextReply(restartToken, chatId, "正在重启...").catch(() => {});
    console.log(`[${ts()}] [RESTART] Spawning new process...`);
    const child = spawn("npx", ["tsx", "--env-file=.env", "src/index.ts"], {
      cwd: PROJECT_ROOT,
      detached: true,
      stdio: "ignore",
      shell: true,
    });
    child.unref();
    setTimeout(() => process.exit(0), 200);
    return;
  }

  if (text === "/cd" || text.startsWith("/cd ")) {
    const cdToken = await getTenantAccessToken();
    const currentDir = await getWorkingDir();
    const arg = text.slice(3).trim(); // everything after "/cd" (may be empty)

    // Resolve target directory
    let targetDir: string;
    if (!arg) {
      targetDir = currentDir;
    } else if (arg === "..") {
      targetDir = dirname(currentDir);
    } else {
      targetDir = resolve(currentDir, arg);
    }

    // Verify the target exists and is a directory
    try {
      const s = await stat(targetDir);
      if (!s.isDirectory()) {
        await sendCardReply(cdToken, chatId, "工作路径", `路径存在但不是目录:\n\`${targetDir}\``, "red");
        return;
      }
    } catch {
      await sendCardReply(cdToken, chatId, "工作路径", `路径不存在:\n\`${targetDir}\``, "red");
      return;
    }

    // Change working dir if user provided a path
    const isUpdate = !!arg && targetDir !== currentDir;
    if (isUpdate) {
      await setWorkingDir(targetDir);
    }

    // Read directory entries
    let entries: string[];
    try {
      entries = await readdir(targetDir);
    } catch (err) {
      await sendCardReply(cdToken, chatId, "工作路径", `无法读取目录:\n\`${targetDir}\`\n\n${(err as Error).message}`, "red");
      return;
    }

    // Sort: directories first, then files, alphabetically within each group
    const withStats: { name: string; isDir: boolean }[] = [];
    for (const name of entries) {
      try {
        const s = await stat(resolve(targetDir, name));
        withStats.push({ name, isDir: s.isDirectory() });
      } catch { withStats.push({ name, isDir: false }); }
    }
    withStats.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const content = buildCdContent(targetDir, withStats, isUpdate);
    await sendCardReply(cdToken, chatId, "工作路径", content, "blue");
    return;
  }

  if (text === "/new") {
    if (!openId) {
      console.log(`[${ts()}] [WARN] Cannot get sender open_id`);
      const warnToken = await getTenantAccessToken();
      await sendCardReply(warnToken, chatId, "Error", "Cannot identify sender.", "red");
      return;
    }

    const freshToken = await getTenantAccessToken();

    let sessionId: string;
    try {
      sessionId = await initClaudeSession();
      console.log(`[${ts()}] [STEP 1/4] Claude SDK session created: ${sessionId} → OK`);
    } catch (err) {
      console.error(`[${ts()}] [STEP 1/4] FAIL: ${(err as Error).message}`);
      await sendCardReply(
        freshToken, chatId, "Error",
        `Failed to initialize Claude session:\n${(err as Error).message}`,
        "red"
      );
      return;
    }

    let newChatId: string;
    try {
      newChatId = await createGroupChat(freshToken, `新会话-${sessionId}`, [openId]);
      console.log(`[${ts()}] [STEP 2/4] Created Feishu group: ${newChatId}  → OK`);
    } catch (err) {
      console.error(`[${ts()}] [STEP 2/4] FAIL: ${(err as Error).message}`);
      await sendCardReply(freshToken, chatId, "Error", `Failed to create group:\n${(err as Error).message}`, "red");
      return;
    }

    try {
      const initialName = `新会话-${sessionId}`;
      await updateChatInfo(freshToken, newChatId, initialName, `Claude Session: ${sessionId}`);
      console.log(`[${ts()}] [STEP 3/4] Renamed group → name="${initialName}"  → OK`);
    } catch (err) {
      console.error(`[${ts()}] [STEP 3/4] FAIL: ${(err as Error).message}`);
      await sendCardReply(freshToken, chatId, "Error", `Group created but rename failed:\n${(err as Error).message}`, "yellow");
      return;
    }

    await sendCardReply(
      freshToken, newChatId, "Claude Session Ready",
      `群聊已创建，这是你的 Claude 会话群。\n\n**Session ID:** ${sessionId}\n\n直接在这里发消息即可与 Claude 对话。`,
      "green"
    );

    const resumeCmd = `claude --resume ${sessionId}`;
    await sendCardReply(
      freshToken, chatId, "Group + Claude Session Ready",
      `**Session ID:** ${sessionId}\n` +
      `**Group:** created (check your chat list)\n\n` +
      `Resume Claude session:\n\`\`\`\n${resumeCmd}\n\`\`\``,
      "green"
    );
    console.log(`[${ts()}] [STEP 4/4] Replied to user  → OK`);
    console.log(`${"=".repeat(60)}`);
    return;
  }

  try {
    const token = await getTenantAccessToken();
    const chatInfo = await getChatInfo(token, chatId);
    const description = chatInfo.description;
    const sessionId = extractSessionId(description);

    if (sessionId) {
      console.log(`[${ts()}] [RESUME] 克劳德会话群 detected, session=${sessionId}`);

      const freshToken = await getTenantAccessToken();

      if (chatInfo.name === `新会话-${sessionId}`) {
        const MAX_PREFIX = 20;
        const prefix = text.slice(0, MAX_PREFIX);
        const newName = `${prefix} ${sessionId}`;
        try {
          await updateChatInfo(freshToken, chatId, newName, description);
          console.log(`[${ts()}] [RENAME] First message → group renamed to "${newName}"`);
        } catch (err) {
          console.error(`[${ts()}] [RENAME] Failed: ${(err as Error).message}`);
        }
      }

      if (text === "/stop") {
        const cEntry = chatSessionMap.get(chatId);
        if (cEntry) {
          cEntry.stopped = true;
          if (cEntry.spinnerTimer) { clearInterval(cEntry.spinnerTimer); cEntry.spinnerTimer = null; }
          cEntry.close();
          console.log(`[${ts()}] [STOP] User sent /stop, session=${sessionId}`);
          await sendTextReply(freshToken, chatId, "会话已停止。").catch(() => {});
        } else {
          await sendTextReply(freshToken, chatId, "当前没有正在进行的会话。").catch(() => {});
        }
        return;
      }

      if (text === "/status") {
        const status = getSessionStatus(chatId);
        const running = chatSessionMap.get(chatId);
        const isActive = running && !running.stopped;
        const statusText = [
          `**Session ID:** \`${status?.sessionId ?? sessionId}\``,
          `**状态:** ${isActive ? "🟢 运行中" : "⚪ 空闲"}`,
          `**已对话轮数:** ${status?.turnCount ?? 0}`,
          `**模型:** ${status?.model ?? CLAUDE_MODEL}`,
          `**Effort:** ${status?.effort ?? "N/A"}`,
        ];
        if (isActive) {
          const elapsed = Math.floor((Date.now() - (status!.startTime)) / 1000);
          const mins = Math.floor(elapsed / 60);
          const secs = elapsed % 60;
          statusText.push(`**本轮已运行:** ${mins}分${secs}秒`);
          statusText.push(`**已产出总字符:** ${status!.accumulatedLength.toLocaleString()}`);
        }
        if (status?.lastContextTokens) {
          statusText.push(`**上下文 Token 数:** ~${status.lastContextTokens.toLocaleString()}`);
        }
        const card = buildStatusCard(statusText.join("\n"), isActive ? "blue" : "green");
        const statusResp = await fetch(`${BASE_URL}/im/v1/messages?receive_id_type=chat_id`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${freshToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ receive_id: chatId, msg_type: "interactive", content: card }),
        });
        const statusRespData: Record<string, any> = await statusResp.json().catch(() => ({}));
        console.log(`[${ts()}] [STATUS] card sent, code=${statusRespData.code}, msgId=${statusRespData.data?.message_id ?? "N/A"}`);
        return;
      }

      const existing = chatSessionMap.get(chatId);
      if (existing && !existing.stopped) {
        if (msgTimestamp <= existing.msgTimestamp) {
          console.log(`[${ts()}] [SKIP] Older message (${msgTimestamp} <= ${existing.msgTimestamp}), ignoring`);
          return;
        }
        existing.stopped = true;
        if (existing.spinnerTimer) { clearInterval(existing.spinnerTimer); existing.spinnerTimer = null; }
        existing.close();
        chatSessionMap.delete(chatId);
        console.log(`[${ts()}] [INTERRUPT] New message arrived, cancelled previous session ${sessionId}`);
        if (existing.cardId) {
          while (existing.cardBusy) {
            await new Promise(r => setTimeout(r, 20));
          }
          const cardId = existing.cardId;
          const thinking = existing.accumulatedThinking;
          const interruptedCard = buildThinkingCardV2(
            thinking || "新问题已提交，当前回复已中断。",
            { showStop: false, headerTitle: "已中断", headerTemplate: "yellow" }
          );
          let nextSeq = existing.sequence + 1;
          await setCardKitSettings(freshToken, cardId, { streaming_mode: false }, nextSeq++).catch(() => {});
          await updateCardKitCard(freshToken, cardId, interruptedCard, nextSeq).catch((err) => {
            console.error(`[${ts()}] [INTERRUPT] CardKit update failed: ${(err as Error).message}`);
          });
        }
      }

      try {
        await resumeAndPrompt(sessionId, text, freshToken, chatId, msgTimestamp);
        console.log(`[${ts()}] [RESUME] Session ${sessionId} done`);
      } catch (err) {
        console.error(`[${ts()}] [RESUME] FAIL: ${(err as Error).message}`);
        await sendCardReply(
          freshToken, chatId, "Error",
          `Failed to resume Claude session:\n${(err as Error).message}`,
          "red"
        );
      }
      return;
    }
  } catch (err) {
    console.log(`[${ts()}] [INFO] Cannot get chat info for ${chatId}: ${(err as Error).message}`);
  }

  const replyToken = await getTenantAccessToken();
  const card = buildHelpCard(text);
  await fetch(`${BASE_URL}/im/v1/messages?receive_id_type=chat_id`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${replyToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ receive_id: chatId, msg_type: "interactive", content: card }),
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  ensureSingleInstance(PID_FILE, 18080);

  if (!APP_ID || !APP_SECRET) {
    console.log("ERROR: FEISHU_CLAUDER_APP_ID / FEISHU_CLAUDER_APP_SECRET not set");
    process.exit(1);
  }

  const { server: relayServer, broadcast } = createRelayServer(18080);
  broadcastToRelay = broadcast;

  const modeTag = USE_LOCAL ? " (local relay mode)" : "";
  console.log(`${"=".repeat(60)}`);
  console.log(`  ChatCCC — Feishu Bot Bridge for Claude Code${modeTag}`);
  console.log(`${"=".repeat(60)}`);
  console.log(`  Send "/new" to the bot to create a new group + Claude session.`);
  console.log(`  In a Claude session group, send any message to resume & prompt.`);
  console.log(`${"=".repeat(60)}`);

  const token = await getTenantAccessToken();
  console.log(`[${ts()}] [AUTH] Token obtained`);

  const eventDispatcher = new EventDispatcher({});
  eventDispatcher.register({
    "im.message.receive_v1": async (data: Evt) => {
      try {
      broadcastToRelay(data);

      const event = getInnerEvent(data);
      const message = event.message;
      if (!message) return;

      const messageId = message.message_id;
      if (messageId) {
        if (processedMessages.has(messageId)) {
          console.log(`[MSG] Duplicate message ignored: ${messageId}`);
          return;
        }
        processedMessages.add(messageId);
        if (processedMessages.size > MAX_PROCESSED) {
          const it = processedMessages.values();
          for (let i = 0; i < 1000; i++) processedMessages.delete(it.next().value as string);
        }
      }

      const text = extractText(message);
      const sender = event.sender;
      const openId = sender?.sender_id?.open_id ?? "";
      const chatId = message.chat_id ?? "";

      console.log(`[MSG] sender=${openId} chat=${chatId} text="${text}"`);
      appendChatLog(chatId, openId, text);

      if (messageId) {
        addReaction(token, messageId).catch((err) =>
          console.error(`[${ts()}] Reaction failed: ${(err as Error).message}`)
        );
      }

      if (!text) return;
      const msgTimestamp = parseInt(message.create_time ?? "0", 10) || Date.now();
      await handleCommand(text, chatId, openId, msgTimestamp);
      } catch (err) {
        console.error(`[${ts()}] [FATAL] im.message.receive_v1 handler crashed: ${(err as Error).message}`);
      }
    },

    "card.action.trigger": async (data: Evt) => {
      try {
      // 拦截关闭按钮：先置空内容，再尝试撤回（撤回结果不影响后续流程）
      const raw2 = (data as Record<string, unknown>).event ?? data;
      const action2 = (raw2 as Record<string, unknown>)?.action as { value?: unknown } | undefined;
      const actionVal2 = action2?.value as Record<string, unknown> | undefined;
      if (actionVal2?.action === "close") {
        console.log(`[${ts()}] [CLOSE] close button clicked, raw keys: ${Object.keys(raw2 as object).join(", ")}`);
        const messageId = (raw2 as Record<string, unknown>)?.open_message_id as string | undefined
          ?? ((raw2 as Record<string, unknown>)?.context as Record<string, unknown>)?.open_message_id as string | undefined;
        console.log(`[${ts()}] [CLOSE] open_message_id=${messageId ?? "MISSING"}`);
        if (messageId) {
          const closeToken = await getTenantAccessToken();
          updateCardMessage(closeToken, messageId, JSON.stringify({
            config: { wide_screen_mode: true },
            elements: [{ tag: "markdown", content: " " }],
          })).catch((err) => {
            console.error(`[${ts()}] [CLOSE] updateCardMessage failed: ${(err as Error).message}`);
          });
          recallMessage(closeToken, messageId).then((recalled) => {
            console.log(`[${ts()}] [CLOSE] recall result: ${recalled ? "OK" : "FAILED"}`);
          }).catch((err) => {
            console.error(`[${ts()}] [CLOSE] recall failed: ${(err as Error).message}`);
          });
        } else {
          console.error(`[${ts()}] [CLOSE] no open_message_id in event, cannot close`);
        }
        return;
      }

      const result = parseCardAction(data);
      if (!result) return;
      console.log(`[BTN] chat=${result.chatId} text="${result.text}"`);
      handleCommand(result.text, result.chatId, result.openId, Date.now()).catch((err) =>
        console.error(`[${ts()}] [BTN] handleCommand failed: ${(err as Error).message}`)
      );
      } catch (err) {
        console.error(`[${ts()}] [FATAL] card.action.trigger handler crashed: ${(err as Error).message}`);
      }
    },
  });

  if (USE_LOCAL) {
    console.log(`[WS] Connecting to local relay: ${LOCAL_RELAY_URL}`);
    const ws = new WebSocket(LOCAL_RELAY_URL);
    ws.on("open", () => console.log("[WS] Connected to local relay"));
    ws.on("message", (raw: Buffer) => {
      try {
        const data = JSON.parse(raw.toString()) as Evt;
        const action = parseCardAction(data);
        if (action) {
          handleCommand(action.text, action.chatId, action.openId, Date.now()).catch((err) =>
            console.error(`[${ts()}] [BTN] handleCommand failed: ${(err as Error).message}`)
          );
          return;
        }
        const event = getInnerEvent(data);
        const message = event.message;
        if (!message) return;
        const text = extractText(message);
        const openId = event.sender?.sender_id?.open_id ?? "";
        const chatId = message.chat_id ?? "";
        appendChatLog(chatId, openId, text);
        if (text === "/new" && openId) {
          console.log(`[MSG] /new from ${openId}, but local relay does not handle /new yet. Use SDK mode.`);
        }
      } catch { /* ignore */ }
    });
    ws.on("close", () => { console.log("[WS] Local relay disconnected"); process.exit(0); });
    ws.on("error", (err: Error) => console.error(`[WS] Local relay error: ${err.message}`));
  } else {
    resetState();

    const wsClient = new WSClient({
      appId: APP_ID,
      appSecret: APP_SECRET,
      onReady: () => resetState(),
      onReconnected: () => resetState(),
    });

    await wsClient.start({ eventDispatcher });
    console.log("[WS] Feishu WebSocket connected (SDK)");

    sendRestartCard(token).catch((err) =>
      console.error(`[${ts()}] [RESTART] sendRestartCard failed: ${(err as Error).message}`)
    );
  }

  process.on("SIGINT", () => { console.log("\nShutting down..."); relayServer.close(); process.exit(0); });
  process.on("SIGTERM", () => { relayServer.close(); process.exit(0); });

  process.on("uncaughtException", (err) => {
    console.error(`[FATAL] uncaughtException: ${err.message}\n${err.stack}`);
    fileLog.flush();
  });
  process.on("unhandledRejection", (reason) => {
    console.error(`[FATAL] unhandledRejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
    fileLog.flush();
  });
}

main().catch((err: Error) => {
  console.error("Fatal error:", err);
  process.exit(1);
});