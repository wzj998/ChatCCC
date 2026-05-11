/**
 * ChatCCC — Feishu Bot Bridge for AI Coding Tools (TypeScript)
 * =================================================================
 * Supported tools: Claude Code, Cursor, Codex (OpenAI).
 *
 * When a user sends "/new [tool]" to the bot:
 *   1. Create an AI tool session via the corresponding adapter, get session ID
 *   2. Create a new Feishu group chat and add the user
 *   3. Rename the group (name + description) to the session ID
 *   4. Reply to the new group with session info and welcome message
 *
 * Auto-resume: when any message is received in a session group
 * (group description contains a tool-specific prefix), the bot extracts the
 * session ID, resumes the session, sends the user's text, and
 * streams the response to the session's jsonl file.
 *
 * Buttons: progress cards have a 停止 button; help messages have /new and /restart buttons.
 *
 * Usage:
 *   npm run dev
 *   npm run start
 *   npm run demo:create-group -- --local   (local relay mode)
 */

import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { resolve, dirname } from "node:path";

import { WSClient, EventDispatcher } from "@larksuiteoapi/node-sdk";
import WebSocket from "ws";

import { appendStartupTrace, attachRelayWebSocket, ensureSingleInstance, freeRelayListenPort, installCrashLogging } from "./shared.ts";
import { createUiRouter, setReloadConfigHook, startSetupMode } from "./web-ui.ts";
import {
  CHATCCC_PORT,
  APP_ID,
  APP_SECRET,
  BASE_URL,
  CLAUDE_EFFORT,
  CLAUDE_MODEL,
  GIT_TIMEOUT_MS,
  reloadConfigFromDisk,
  anthropicConfigDisplay,
  LOCAL_RELAY_URL,
  PID_FILE,
  PROJECT_ROOT,
  USE_LOCAL,
  appendChatLog,
  explainMissingFeishuCredentialsAndExit,
  fileLog,
  reportEnvironmentVariableReadout,
  getDefaultCwd,
  maskAppId,
  setDefaultCwd,
  getRecentDirs,
  addRecentDir,
  sessionPrefixForTool,
  toolDisplayName,
  ts,
} from "./config.ts";
import { printServiceDidNotStart, printServiceRunningHint } from "./exit-banner.ts";
import {
  addReaction,
  createGroupChat,
  extractSessionInfo,
  getChatInfo,
  getTenantAccessToken,
  recallMessage,
  sendCardReply,
  sendTextReply,
  setChatAvatar,
  updateCardMessage,
  updateChatInfo,
  sendRestartCard,
  verifyAllPermissions,
  reportPermissionResults,
} from "./feishu-api.ts";
import { buildHelpCard, buildStatusCard, buildProgressCard, buildCdContent, buildCdCard, buildSessionsCard } from "./cards.ts";
import { updateCardKitCard } from "./cardkit.ts";
import { formatGitResult, gitResultHeaderTemplate, runGitCommand } from "./git-command.ts";
import {
  MAX_PROCESSED,
  chatSessionMap,
  getSessionStatus,
  getAllSessionsStatus,
  initClaudeSession,
  processedMessages,
  resetState,
  resumeAndPrompt,
  sessionInfoMap,
  getAdapterForTool,
} from "./session.ts";

export function cwdDisplayName(cwd: string): string {
  const trimmed = cwd.trim().replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).filter(Boolean).pop() || trimmed || "cwd";
}

export function sessionChatName(left: string, cwd: string): string {
  return `${left}-${cwdDisplayName(cwd)}`;
}

function isUntitledSessionChatName(name: string): boolean {
  return name === "新会话" || name.startsWith("新会话-");
}

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

/**
 * 将飞书消息的原始 content JSON 结构转成可读文本，保留代码块等结构信息。
 * 未知类型直接返回 JSON 原文，让 AI 自行理解。
 */
function formatMessageContent(message: { message_type?: string; content?: string }): string {
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

  if (message.message_type === "post") {
    return formatPostContent(content);
  }

  // 其他类型（image, file, audio, media, sticker）直接给原始 JSON
  return contentStr;
}

function formatPostContent(content: Record<string, unknown>): string {
  const paragraphs = content.content as unknown[][];
  if (!Array.isArray(paragraphs)) return "";

  const parts: string[] = [];
  for (const line of paragraphs) {
    if (!Array.isArray(line)) continue;
    for (const elem of line) {
      const el = elem as Record<string, unknown>;
      if (!el || typeof el !== "object") continue;
      const t = typeof el.text === "string" ? el.text : "";

      if (el.tag === "code_block") {
        const lang = typeof el.language === "string" ? el.language : "";
        parts.push("```" + lang + "\n" + t + "\n```");
      } else if (el.tag === "p" || el.tag === "text") {
        if (t) parts.push(t);
      }
    }
  }
  return parts.join("\n").trim();
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

  const CMD_MAP: Record<string, string> = { stop: "/stop", new: "/new", "new cursor": "/new cursor", "new codex": "/new codex", restart: "/restart", status: "/status", cd: "/cd", sessions: "/sessions", forget: "/forget" };
  let text = CMD_MAP[cmd] ?? "";
  if (cmd === "cd" && typeof action.value === "object" && action.value !== null) {
    const path = (action.value as Record<string, string>).path;
    if (path) text = `/cd ${path}`;
  }
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
    const child = spawn("npx", ["tsx", "src/index.ts"], {
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
    const currentDir = await getDefaultCwd();

    // 获取当前会话的实际工作路径（若在会话群内）
    let sessionCwd: string | undefined;
    try {
      const chatInfo = await getChatInfo(cdToken, chatId);
      const sessionInfoResult = extractSessionInfo(chatInfo.description);
      if (sessionInfoResult) {
        const adapter = getAdapterForTool(sessionInfoResult.tool);
        const info = await adapter.getSessionInfo(sessionInfoResult.sessionId);
        sessionCwd = info?.cwd;
      }
    } catch { /* 非会话群或获取失败，不显示 */ }

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
        await sendCardReply(cdToken, chatId, "新会话工作路径", `路径存在但不是目录:\n\`${targetDir}\``, "red");
        return;
      }
    } catch {
      await sendCardReply(cdToken, chatId, "新会话工作路径", `路径不存在:\n\`${targetDir}\``, "red");
      return;
    }

    // Change working dir if user provided a path
    const isUpdate = !!arg && targetDir !== currentDir;
    if (isUpdate) {
      await setDefaultCwd(targetDir);
      await addRecentDir(targetDir);
    }

    // Read directory entries
    let entries: string[];
    try {
      entries = await readdir(targetDir);
    } catch (err) {
      await sendCardReply(cdToken, chatId, "新会话工作路径", `无法读取目录:\n\`${targetDir}\`\n\n${(err as Error).message}`, "red");
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

    if (!arg) {
      // /cd 无参数：展示卡片（含最近使用路径按钮）
      const recentDirs = await getRecentDirs();
      const card = buildCdCard(targetDir, withStats, recentDirs, sessionCwd);
      const resp = await fetch(`${BASE_URL}/im/v1/messages?receive_id_type=chat_id`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cdToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ receive_id: chatId, msg_type: "interactive", content: card }),
      });
      const respData: Record<string, any> = await resp.json().catch(() => ({}));
      console.log(`[${ts()}] [CD] card sent, code=${respData.code}, msgId=${respData.data?.message_id ?? "N/A"}, recentDirs=${recentDirs.length}`);
    } else {
      // /cd <path>：切换目录，发送文本卡片
      const content = buildCdContent(targetDir, withStats, isUpdate, sessionCwd);
      await sendCardReply(cdToken, chatId, "新会话工作路径", content, "blue");
    }
    return;
  }

  if (text === "/new" || text.startsWith("/new ")) {
    const toolArg = text.slice(5).trim();
    const tool = toolArg || "claude";
    const validTools = ["claude", "cursor", "codex"];
    if (!validTools.includes(tool)) {
      const warnToken = await getTenantAccessToken();
      await sendCardReply(warnToken, chatId, "Error", `未知的工具类型: "${toolArg}"。支持: claude (Claude Code), cursor (Cursor), codex (Codex)。`, "red");
      return;
    }
    const toolLabel = toolDisplayName(tool);

    if (!openId) {
      console.log(`[${ts()}] [WARN] Cannot get sender open_id`);
      const warnToken = await getTenantAccessToken();
      await sendCardReply(warnToken, chatId, "Error", "Cannot identify sender.", "red");
      return;
    }

    const freshToken = await getTenantAccessToken();

    let sessionId: string;
    let sessionCwd: string;
    try {
      const init = await initClaudeSession(tool);
      sessionId = init.sessionId;
      sessionCwd = init.cwd;
      console.log(`[${ts()}] [STEP 1/4] ${toolLabel} session created: ${sessionId} → OK`);
    } catch (err) {
      console.error(`[${ts()}] [STEP 1/4] FAIL: ${(err as Error).message}`);
      await sendCardReply(
        freshToken, chatId, "Error",
        `Failed to initialize ${toolLabel} session:\n${(err as Error).message}`,
        "red"
      );
      return;
    }

    const cwd = sessionCwd;
    const initialName = sessionChatName("新会话", cwd);

    let newChatId: string;
    try {
      newChatId = await createGroupChat(freshToken, initialName, [openId]);
      console.log(`[${ts()}] [STEP 2/4] Created Feishu group: ${newChatId}  → OK`);
    } catch (err) {
      console.error(`[${ts()}] [STEP 2/4] FAIL: ${(err as Error).message}`);
      await sendCardReply(freshToken, chatId, "Error", `Failed to create group:\n${(err as Error).message}`, "red");
      return;
    }

    try {
      const descPrefix = sessionPrefixForTool(tool);
      await updateChatInfo(freshToken, newChatId, initialName, `${descPrefix} ${sessionId}`);
      console.log(`[${ts()}] [STEP 3/4] Renamed group → name="${initialName}" (${toolLabel}) → OK`);
    } catch (err) {
      console.error(`[${ts()}] [STEP 3/4] FAIL: ${(err as Error).message}`);
      await sendCardReply(freshToken, chatId, "Error", `Group created but rename failed:\n${(err as Error).message}`, "yellow");
      return;
    }

    const adapter = getAdapterForTool(tool);
    await sendCardReply(
      freshToken, newChatId, `${toolLabel} Session Ready`,
      `群聊已创建，这是你的 **${toolLabel}** 会话群。\n\n` +
        `**Session ID:** ${sessionId}\n` +
        `**工作目录:** \`${cwd}\`\n\n` +
        `直接在这里发消息即可与 ${toolLabel} 对话。\n\n` +
        `发送 **/sessions** 查看所有会话状态。\n` +
        `发送 \`/git <子命令>\` 在本会话工作目录执行 git，例如 \`/git status\`、\`/git log --oneline -n 5\`。`,
      "green"
    );

    console.log(`[${ts()}] [STEP 4/4] Replied to new group → OK`);
    setChatAvatar(freshToken, newChatId, "new").catch(() => {});
    console.log(`${"=".repeat(60)}`);
    return;
  }

  try {
    const token = await getTenantAccessToken();
    const chatInfo = await getChatInfo(token, chatId);
    const description = chatInfo.description;
    const sessionInfo = extractSessionInfo(description);

    if (sessionInfo) {
      const sessionId = sessionInfo.sessionId;
      const descriptionTool = sessionInfo.tool;
      const toolLabel = toolDisplayName(descriptionTool);
      console.log(`[${ts()}] [RESUME] ${toolLabel} session group detected, session=${sessionId} tool=${descriptionTool}`);

      const freshToken = await getTenantAccessToken();

      if (isUntitledSessionChatName(chatInfo.name)) {
        const MAX_PREFIX = 10;
        const prefix = text.slice(0, MAX_PREFIX);
        const adapter = getAdapterForTool(descriptionTool);
        const info = await adapter.getSessionInfo(sessionId).catch(() => undefined);
        const sessionCwd = info?.cwd ?? (await getDefaultCwd());
        const newName = sessionChatName(prefix, sessionCwd);
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
        const status = await getSessionStatus(chatId);
        const running = chatSessionMap.get(chatId);
        const isActive = running && !running.stopped;
        const statusText = [
          `**Session ID:** \`${status?.sessionId ?? sessionId}\``,
          `**工具:** ${toolLabel}`,
          `**状态:** ${isActive ? "🟢 运行中" : "⚪ 空闲"}`,
          `**已对话轮数:** ${status?.turnCount ?? 0}`,
          `**模型:** ${status?.model ?? anthropicConfigDisplay(CLAUDE_MODEL)}`,
        ];
        // effort 仅在该工具有此概念时显示（status?.effort 为 null 表示
        // 当前工具没有 effort，如 Cursor，应隐藏整行避免误导）
        if (status?.effort != null) {
          statusText.push(`**Effort:** ${status.effort}`);
        }
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

      if (text === "/sessions") {
        const allSessions = await getAllSessionsStatus();
        const now = Date.now();
        const cardData = allSessions.map(s => ({
          sessionId: s.sessionId,
          active: s.active,
          turnCount: s.turnCount,
          elapsedSeconds: s.active ? Math.floor((now - s.startTime) / 1000) : null,
          model: s.model,
          tool: s.tool,
        }));
        const card = buildSessionsCard(cardData);
        const sessionsResp = await fetch(`${BASE_URL}/im/v1/messages?receive_id_type=chat_id`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${freshToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ receive_id: chatId, msg_type: "interactive", content: card }),
        });
        const sessionsRespData: Record<string, any> = await sessionsResp.json().catch(() => ({}));
        console.log(`[${ts()}] [SESSIONS] card sent, code=${sessionsRespData.code}, count=${allSessions.length}`);
        return;
      }

      if (text === "/forget") {
        const adapter = getAdapterForTool(descriptionTool);
        let cwd: string;
        try {
          const info = await adapter.getSessionInfo(sessionId);
          cwd = info?.cwd ?? (await getDefaultCwd());
        } catch {
          cwd = await getDefaultCwd();
        }

        const existing = chatSessionMap.get(chatId);
        if (existing) {
          existing.stopped = true;
          if (existing.spinnerTimer) { clearInterval(existing.spinnerTimer); existing.spinnerTimer = null; }
          existing.close();
          chatSessionMap.delete(chatId);
        }

        let newSessionId: string;
        try {
          const init = await initClaudeSession(descriptionTool, cwd);
          newSessionId = init.sessionId;
        } catch (err) {
          await sendCardReply(freshToken, chatId, "Error", `Failed to create new session:\n${(err as Error).message}`, "red");
          return;
        }

        const descPrefix = sessionPrefixForTool(descriptionTool);
        const initialName = sessionChatName("新会话", cwd);
        await updateChatInfo(freshToken, chatId, initialName, `${descPrefix} ${newSessionId}`);
        console.log(`[${ts()}] [FORGET] Group updated: name="${initialName}" desc="${descPrefix} ${newSessionId}"`);

        sessionInfoMap.set(chatId, {
          sessionId: newSessionId,
          turnCount: 0,
          lastContextTokens: 0,
          startTime: Date.now(),
          tool: descriptionTool,
        });

        setChatAvatar(freshToken, chatId, "new").catch(() => {});

        await sendCardReply(
          freshToken, chatId, `${toolLabel} Session Reset`,
          `会话已重置为新的 **${toolLabel}** 会话。\n\n` +
            `**Session ID:** ${newSessionId}\n` +
            `**工作目录:** \`${cwd}\`\n\n` +
            `直接在这里发消息即可继续对话。`,
          "green"
        );

        console.log(`[${ts()}] [FORGET] Session ${sessionId} → ${newSessionId} (same cwd=${cwd})`);
        return;
      }

      // /git <args>：在「当前会话工作目录」执行 git 命令，把输出回发到群里。
      // 注意 cwd 必须取自 adapter.getSessionInfo（会话真实 cwd），而非
      // getDefaultCwd（下一次 /new 才会使用的默认路径）。
      if (text.startsWith("/git ") || text === "/git") {
        const args = text === "/git" ? "" : text.slice(5).trim();
        if (!args) {
          await sendCardReply(
            freshToken, chatId, "/git",
            "用法：`/git <子命令> [参数]`，例如 `/git status`、`/git log --oneline -n 5`。",
            "yellow"
          );
          return;
        }

        const adapter = getAdapterForTool(descriptionTool);
        let cwd: string | undefined;
        try {
          const info = await adapter.getSessionInfo(sessionId);
          cwd = info?.cwd;
        } catch (err) {
          console.error(`[${ts()}] [GIT] getSessionInfo FAIL: ${(err as Error).message}`);
        }
        if (!cwd) {
          // Cursor 会话的 cwd 依赖 state/cursor-session-meta.json 持久化映射；
          // 升级前创建的旧会话或映射文件丢失时，向会话发送一次普通消息即可触发
          // adapter 自动学习并补全（resume 流首条 init 事件携带 cwd）。
          const isCursor = descriptionTool === "cursor";
          const hint = isCursor
            ? "无法获取当前 Cursor 会话的工作目录（缺少 sessionId→cwd 持久化映射）。请先在本群发送一条普通消息（让 adapter 从 cursor-agent 流中自动补回 cwd），然后再试 /git；若仍失败，可用 /new 重建会话。"
            : `无法获取当前会话的工作目录（${toolLabel} adapter 未返回 cwd）。请先与 AI 对话一次再试，或检查会话是否仍存在。`;
          await sendCardReply(freshToken, chatId, "/git", hint, "red");
          return;
        }

        console.log(`[${ts()}] [GIT] chat=${chatId} cwd=${cwd} cmd="git ${args}" timeoutMs=${GIT_TIMEOUT_MS}`);
        const result = await runGitCommand(args, cwd, { timeoutMs: GIT_TIMEOUT_MS });
        console.log(`[${ts()}] [GIT] exitCode=${result.exitCode}, durationMs=${result.durationMs}, truncated=${result.truncated}, timedOut=${result.timedOut}`);
        const content = formatGitResult(args, cwd, result);
        const template = gitResultHeaderTemplate(result);
        await sendCardReply(freshToken, chatId, "/git 输出", content, template);
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
          const currentContent = existing.accumulatedContent;
          const interruptedCard = buildProgressCard(
            currentContent || "新问题已提交，当前回复已中断。",
            { showStop: false, headerTitle: "已中断", headerTemplate: "yellow" }
          );
          let nextSeq = existing.sequence + 1;
          await updateCardKitCard(freshToken, cardId, interruptedCard, nextSeq).catch((err) => {
            console.error(`[${ts()}] [INTERRUPT] CardKit update failed: ${(err as Error).message}`);
          });
        }
      }

      try {
        await resumeAndPrompt(sessionId, text, freshToken, chatId, msgTimestamp, descriptionTool);
        console.log(`[${ts()}] [RESUME] Session ${sessionId} done`);
      } catch (err) {
        console.error(`[${ts()}] [RESUME] FAIL: ${(err as Error).message}`);
        fileLog.flush();
        await sendCardReply(
          freshToken, chatId, "Error",
          `Failed to resume ${toolLabel} session:\n${(err as Error).message}`,
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
// startBotService — 飞书 service 的启动逻辑（独立于 main()）
// ---------------------------------------------------------------------------
//
// 抽出原因：setup → service「在线切换」需要原地（同进程）启动飞书 service，
// 不希望走 spawn 子进程那条 path（chatccc 主进程已经占着 PID 文件）。
//
// 设计契约：
//   - 入参 httpServer 必须**已经在监听 port**；本函数只负责把 WS 中继和
//     UI router 挂上去，再起 EventDispatcher / WSClient。
//   - 内部任何失败一律 throw，调用方决定是 process.exit(1)（main 模式）
//     还是把错误回报前端 toast（setup-activate 模式，不退出 chatccc 进程）。
//   - 成功返回后 service 就绪；调用方负责注册 SIGINT/SIGTERM 清理。

interface StartBotServiceOptions {
  httpServer: Server;
  port: number;
}

async function startBotService(opts: StartBotServiceOptions): Promise<void> {
  const { httpServer, port } = opts;

  console.log(`\n[启动 3/7] 在 http://127.0.0.1:${port} 上挂载本地 WebSocket 中继 …`);
  appendStartupTrace("startBotService: before attachRelayWebSocket", { port });
  const wsAttachment = attachRelayWebSocket(httpServer);
  broadcastToRelay = wsAttachment.broadcast;
  // UI router 在 setup 模式下已经挂在 httpServer 上；main 直入模式由 main() 负责挂
  // —— 这里不再额外 attach，避免重复触发 createUiRouter。
  console.log("  完成。\n");

  // setup-activate 模式下，token / permissions / wsClient 任一阶段失败都需要
  // 回滚已挂的 WSServer，否则用户重试 onActivate 时会重复挂载导致句柄泄漏。
  // 用 try / catch 统一 wrap 后续启动逻辑。
  try {
    await startBotServiceCore();
  } catch (err) {
    wsAttachment.close();
    broadcastToRelay = () => { /* noop after rollback */ };
    throw err;
  }
}

async function startBotServiceCore(): Promise<void> {
  const modeTag = USE_LOCAL ? " (local relay mode)" : "";
  console.log(`${"=".repeat(60)}`);
  console.log(`  ChatCCC — Feishu Bot Bridge for Claude Code${modeTag}`);
  console.log(`${"=".repeat(60)}`);
  console.log(`  Send "/new" to the bot to create a new group + Claude session.`);
  console.log(`  In a Claude session group, send any message to resume & prompt.`);
  console.log(`${"=".repeat(60)}`);

  console.log(`\n[启动 4/7] 向飞书开放平台申请 tenant_access_token …`);
  let token: string;
  try {
    token = await getTenantAccessToken();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("  失败：无法获取 tenant_access_token。");
    console.error(`  接口: POST ${BASE_URL}/auth/v3/tenant_access_token/internal`);
    console.error("  常见原因:");
    console.error(
      "    - 本机网络无法访问 open.feishu.cn（可尝试：关闭系统/终端代理、检查防火墙；Windows 可管理员运行 netsh winsock reset 后重启）",
    );
    console.error("    - App ID / App Secret 与开放平台「凭证与基础信息」不一致");
    console.error("    - 自建应用尚未创建/发布可用版本");
    console.error(`  详情: ${msg}`);
    throw new Error(`无法从飞书开放平台获取 tenant_access_token: ${msg}`);
  }
  console.log(`  完成。当前 App ID 摘要: ${maskAppId(APP_ID)}\n`);

  console.log(`\n[启动 5/7] 验证飞书应用权限（非破坏性探针）…`);
  const permResults = await verifyAllPermissions(token);
  const hasFailed = reportPermissionResults(permResults, (msg) => {
    console.log(msg);
  });
  if (hasFailed) {
    const failedScopes = permResults.filter((r) => !r.ok).map((r) => r.scope).join(", ");
    appendStartupTrace("startBotService: permissions check failed", { failed: failedScopes });
    throw new Error(`飞书权限不足: ${failedScopes}`);
  }
  appendStartupTrace("startBotService: permissions check ok");
  console.log(`  完成。所有必需权限已验证通过。\n`);

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

      const text = formatMessageContent(message);
      const sender = event.sender;
      const openId = sender?.sender_id?.open_id ?? "";
      const chatId = message.chat_id ?? "";

      console.log(`[MSG] sender=${openId} chat=${chatId} text="${text}"`);
      appendChatLog(chatId, openId, text);

      if (messageId) {
        getTenantAccessToken().then((freshToken) =>
          addReaction(freshToken, messageId).catch((err) =>
            console.error(`[${ts()}] Reaction failed: ${(err as Error).message}`)
          )
        ).catch((err) =>
          console.error(`[${ts()}] Reaction token failed: ${(err as Error).message}`)
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
    console.log(`\n[启动 6/7] 本地区 relay 模式：正在连接 ${LOCAL_RELAY_URL} …`);
    console.log("  若失败：请先在 SDK 模式下启动主进程，或确认本机中继已在该地址监听。");
    let localRelayOpened = false;
    const ws = new WebSocket(LOCAL_RELAY_URL);
    ws.on("open", () => {
      localRelayOpened = true;
      console.log("[WS] Connected to local relay");
      console.log("[启动 7/7] 已连接本地中继，可接收转发事件。\n");
      printServiceRunningHint("local", `http://127.0.0.1:${CHATCCC_PORT}`);
    });
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
        const text = formatMessageContent(message);
        const openId = event.sender?.sender_id?.open_id ?? "";
        const chatId = message.chat_id ?? "";
        appendChatLog(chatId, openId, text);
        if (text === "/new" && openId) {
          console.log(`[MSG] /new from ${openId}, but local relay does not handle /new yet. Use SDK mode.`);
        }
      } catch { /* ignore */ }
    });
    ws.on("close", () => { console.log("[WS] Local relay disconnected"); process.exit(0); });
    ws.on("error", (err: Error) => {
      if (!localRelayOpened) {
        console.error(`[启动 6/7] 失败：无法连接本地中继。`);
        console.error(`  ${err.message}`);
        console.error(`  目标: ${LOCAL_RELAY_URL}`);
        // 注意：local relay 模式下连接是异步的；此处 throw 出 startBotService
        // 已经返回的事件循环外，调用方拿不到。约定：local 模式连接失败一律
        // 直接退出进程（与 setup-activate 模式无关 —— setup 模式不会用 local relay）。
        printServiceDidNotStart(`无法连接本地中继 ${LOCAL_RELAY_URL}`);
        process.exit(1);
      }
      console.error(`[WS] Local relay error: ${err.message}`);
    });
  } else {
    resetState();

    const wsClient = new WSClient({
      appId: APP_ID,
      appSecret: APP_SECRET,
      onReady: () => { resetState(); },
      onReconnected: () => { resetState(); },
    });

    console.log(`\n[启动 6/7] 飞书长连接：正在通过 SDK 建立 WebSocket …`);
    try {
      await wsClient.start({ eventDispatcher });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("  失败：飞书 WebSocket 未能启动。");
      console.error("  常见原因: 应用权限未开通、事件订阅未配置、网络问题、或 SDK 内部错误。");
      console.error(`  详情: ${msg}`);
      throw new Error(`飞书 SDK WebSocket 未能建立: ${msg}`);
    }
    console.log("[WS] Feishu WebSocket connected (SDK)");
    console.log("[启动 7/7] 服务已就绪，等待飞书消息（群聊 / 卡片回调）。\n");
    printServiceRunningHint("sdk", `http://127.0.0.1:${CHATCCC_PORT}`);

    sendRestartCard(token).catch((err) =>
      console.error(`[${ts()}] [RESTART] sendRestartCard failed: ${(err as Error).message}`)
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  appendStartupTrace("main: entered", {
    argv: process.argv.join(" ").slice(0, 400),
    CHATCCC_PORT,
    PROJECT_ROOT,
  });

  // 黑匣子：所有未捕获异常 / 信号 / beforeExit 都同步写入 startup-trace.log（appendFileSync）。
  // 越早装越好——后续任何一行抛错都有兜底；它独立于 SIGINT 清理（见末尾的
  // server.close）——只负责诊断与默认致命退出，不替代清理逻辑。
  installCrashLogging({ flush: () => fileLog.flush() });

  if (Number.isNaN(CHATCCC_PORT) || CHATCCC_PORT < 1 || CHATCCC_PORT > 65535) {
    console.error("\n[启动] 预检失败: config.json 的 port 字段不是有效端口号（1–65535）。");
    console.error(`  当前配置: ${CHATCCC_PORT}`);
    reportEnvironmentVariableReadout();
    printServiceDidNotStart("config.json 的 port 字段配置无效（须为 1–65535 的整数）");
    process.exit(1);
  }

  console.log(`\n[启动 1/7] 单实例：按 PID 文件清理旧 ChatCCC 进程`);
  console.log(`  PID 文件: ${PID_FILE}`);
  appendStartupTrace("main: before ensureSingleInstance", { PID_FILE, CHATCCC_PORT });
  ensureSingleInstance(PID_FILE);
  appendStartupTrace("main: after ensureSingleInstance");
  console.log("  完成。\n");

  // 注册 reload hook：dashboard 模式（或 setup 激活后再点向导）下用户点
  // "保存并启动" 时，web-ui 会调用本回调，把磁盘上刚保存的 config.json
  // 刷进进程内的 export let 常量（live binding 让 CLAUDE_MODEL 等下次创建
  // 会话时自动看到新值）。setup 首次激活走 onActivate 路径，不依赖此 hook。
  setReloadConfigHook(() => {
    reloadConfigFromDisk();
    appendStartupTrace("reload-from-ui: config reloaded", {
      appIdMask: maskAppId(APP_ID),
    });
  });

  console.log(`[启动 2/7] 环境与凭证检查`);
  reportEnvironmentVariableReadout();
  console.log(`  工作目录: ${process.cwd()}`);
  console.log(`  包根目录: ${PROJECT_ROOT}`);
  appendStartupTrace("main: before feishu credential check", {
    hasAppId: Boolean(APP_ID.trim()),
    hasAppSecret: Boolean(APP_SECRET.trim()),
  });
  if (!APP_ID.trim() || !APP_SECRET.trim()) {
    // 凭证不全：进 setup 向导。注入 onActivate 回调让用户点"保存并启动"
    // 时，原地（同进程）调用 startBotService，复用 setup HTTP server。
    startSetupMode(CHATCCC_PORT, {
      onActivate: async (httpServer: Server) => {
        // 关键：用户刚把新凭证写入 config.json，需要先把进程内的 APP_ID 等
        // 常量同步到磁盘最新值，否则 startBotService 拿到的是 chatccc 启动时
        // 加载的（空）凭证。reloadConfigFromDisk 利用 ES module live binding
        // 让所有"export let"消费方自动看到新值。
        reloadConfigFromDisk();
        appendStartupTrace("setup-activate: reloaded config from disk", {
          appIdMaskAfterReload: maskAppId(APP_ID),
        });
        try {
          await startBotService({ httpServer, port: CHATCCC_PORT });
          // 切换成功：注册 SIGINT/SIGTERM 让 Ctrl-C 也能优雅退出
          installShutdownHandlers(httpServer);
          return { ok: true };
        } catch (err) {
          appendStartupTrace("setup-activate: startBotService failed", {
            message: (err as Error).message,
          });
          // 不退出 chatccc 进程——setup HTTP server 还在监听，让用户改完
          // config 再点一次。
          return { ok: false, error: (err as Error).message };
        }
      },
    });
    return;
  }
  console.log(`  必填项校验通过（App ID 摘要: ${maskAppId(APP_ID)}）。\n`);
  appendStartupTrace("main: feishu credentials ok", { appIdMask: maskAppId(APP_ID) });

  // 凭证齐全：自己起 HTTP server（同时挂 UI router），再调 startBotService
  // 把 WS 中继和飞书 SDK 挂上去。
  appendStartupTrace("main: before freeRelayListenPort", { CHATCCC_PORT });
  freeRelayListenPort(CHATCCC_PORT);
  appendStartupTrace("main: after freeRelayListenPort", { CHATCCC_PORT });
  const httpServer = createServer(createUiRouter());
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      httpServer.removeListener("listening", onListening);
      rejectListen(err);
    };
    const onListening = (): void => {
      httpServer.removeListener("error", onError);
      resolveListen();
    };
    httpServer.once("error", onError);
    httpServer.once("listening", onListening);
    httpServer.listen(CHATCCC_PORT, "127.0.0.1");
  }).catch((err: NodeJS.ErrnoException) => {
    console.error(`\n[启动] 本地中继 WebSocket 监听失败：端口 ${CHATCCC_PORT}（${err.code ?? "?"} — ${err.message}）`);
    console.error(
      "  处理建议: 关闭占用该端口的其它程序，或在 config.json 的 port 字段里改成其它未占用端口（如 18081）。"
    );
    printServiceDidNotStart(`本地中继端口 ${CHATCCC_PORT} 无法监听（${err.code ?? "?"} — ${err.message}）`);
    process.exit(1);
  });

  try {
    await startBotService({ httpServer, port: CHATCCC_PORT });
  } catch (err) {
    printServiceDidNotStart((err as Error).message);
    process.exit(1);
  }

  installShutdownHandlers(httpServer);
}

/**
 * 注册 SIGINT / SIGTERM 清理：把 relay/setup 共用的 httpServer 关掉再退出。
 *
 * Node EventEmitter 按注册顺序触发，installCrashLogging 装得更早 → 同步 trace
 * 先写盘，再走这里。
 */
function installShutdownHandlers(httpServer: Server): void {
  process.on("SIGINT", () => { console.log("\nShutting down..."); httpServer.close(); process.exit(0); });
  process.on("SIGTERM", () => { httpServer.close(); process.exit(0); });
}

main().catch((err: Error) => {
  appendStartupTrace("main: catch fatal", { message: err.message, stack: err.stack?.slice(0, 800) });
  console.error("\n[启动] 未捕获的致命错误（main 异步链）");
  console.error(`  ${err.message}`);
  if (err.stack) console.error(err.stack);
  printServiceDidNotStart(`main() 异常: ${err.message}`);
  process.exit(1);
});
