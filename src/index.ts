/**
 * ChatCCC — Feishu Bot Bridge for AI Coding Tools (TypeScript)
 * =================================================================
 * Supported tools: Claude Code, Cursor, Codex (OpenAI).
 *
 * When a user sends "/new [tool]" to the bot (omitting tool uses the configured default Agent):
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
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve, dirname } from "node:path";

import { WSClient, EventDispatcher } from "@larksuiteoapi/node-sdk";
import WebSocket from "ws";

import { appendStartupTrace, attachRelayWebSocket, ensureSingleInstance, freeRelayListenPort, installCrashLogging, waitForPortFree } from "./shared.ts";
import { createUiRouter, setExtraApiHandler, setReloadConfigHook, startSetupMode } from "./web-ui.ts";
import { makeTraceId, logTrace } from "./trace.ts";
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
  USE_SIMULATE,
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
  resolveDefaultAgentTool,
  toolDisplayName,
  ts,
} from "./config.ts";
import { printServiceDidNotStart, printServiceRunningHint } from "./exit-banner.ts";
import {
  addReaction,
  createGroupChat,
  extractSessionInfo,
  formatDelayNotice,
  getChatInfo,
  getTenantAccessToken,
  recallMessage,
  sendCardReply,
  sendRawCard,
  sendTextReply,
  setChatAvatar,
  updateCardMessage,
  updateChatInfo,
  disbandChat,
  getOrDownloadImage,
  sendRestartCard,
  verifyAllPermissions,
  reportPermissionResults,
  setPlatform,
} from "./feishu-platform.ts";
import { buildHelpCard, buildStatusCard, buildCdContent, buildCdCard, buildSessionsCard } from "./cards.ts";
import { handleAgentImageRequest } from "./agent-image-rpc.ts";
import { handleAgentFileRequest } from "./agent-file-rpc.ts";
import { SimulatedPlatform, SIM_DEFAULT_CHAT_ID } from "./sim-platform.ts";
import { setMessageHandler } from "./sim-store.ts";
import { formatGitResult, gitResultHeaderTemplate, runGitCommand } from "./git-command.ts";
import {
  MAX_PROCESSED,
  getSessionStatus,
  getAllSessionsStatus,
  initClaudeSession,
  lastMsgTimestamps,
  processedMessages,
  resetState,
  resumeAndPrompt,
  sessionInfoMap,
  recordSessionRegistry,
  getAdapterForTool,
  stopSession,
  loadSessionRegistryForBinding,
  removeSessionRegistryRecord,
  saveSessionTool,
} from "./session.ts";
import {
  bindChatToSession,
  unbindChatFromSession,
  getChatsForSession,
  isSessionRunning,
  activePrompts,
  rebuildSessionChatsFromRegistry,
  displayCards,
  recordLastActiveChat,
} from "./session-chat-binding.ts";
import { fixStaleStreamStates } from "./stream-state.ts";

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
  message?: { message_id?: string; message_type?: string; content?: string; chat_id?: string; chat_type?: string; create_time?: string };
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
async function formatMessageContent(message: { message_id?: string; message_type?: string; content?: string }): Promise<string> {
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

  if (message.message_type === "image") {
    const imageKey = content.image_key as string | undefined;
    const messageId = message.message_id;
    if (!imageKey || !messageId) return contentStr;
    try {
      const token = await getTenantAccessToken();
      const localPath = await getOrDownloadImage(token, messageId, imageKey);
      return `[图片] ${localPath}`;
    } catch (err) {
      console.error(`[${ts()}] [IMAGE] download failed for ${imageKey}: ${(err as Error).message}`);
      return `[图片: ${imageKey}]`;
    }
  }

  if (message.message_type === "media") {
    const fileKey = content.file_key as string | undefined;
    const fileName = (content.file_name as string) || "video.mp4";
    const messageId = message.message_id;
    if (!fileKey || !messageId) return contentStr;
    return `[视频] message_id=${messageId} file_key=${fileKey} file_name=${fileName}`;
  }

  // 其他类型（file, audio, sticker）直接给原始 JSON
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

  const CMD_MAP: Record<string, string> = { stop: "/stop", new: "/new", "new claude": "/new claude", "new cursor": "/new cursor", "new codex": "/new codex", restart: "/restart", status: "/status", cd: "/cd", sessions: "/sessions", newh: "/newh" };
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
// Simulate mode: inject message via HTTP
// ---------------------------------------------------------------------------

async function handleSimInjectMessage(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/api/sim/inject-message") return false;
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "Method not allowed, use POST" }));
    return true;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) { chunks.push(Buffer.from(chunk)); }
  const body = Buffer.concat(chunks).toString("utf-8");
  let parsed: { text?: string; chat_id?: string; open_id?: string; chat_type?: string };
  try { parsed = JSON.parse(body); } catch {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "Invalid JSON body" }));
    return true;
  }

  const text = parsed.text;
  if (!text) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "Missing 'text' field" }));
    return true;
  }

  const chatId = parsed.chat_id || SIM_DEFAULT_CHAT_ID;
  const openId = parsed.open_id || "sim_user_001";
  const chatType = parsed.chat_type || "group";

  console.log(`[${ts()}] [SIM:INJECT] chat=${chatId} text="${text.slice(0, 80)}"`);
  appendChatLog(chatId, openId, text);

  // Fire and forget: process command, respond 202 immediately
  handleCommand(text, chatId, openId, Date.now(), chatType).catch((err) =>
    console.error(`[${ts()}] [SIM:INJECT] handleCommand error: ${(err as Error).message}`)
  );

  res.writeHead(202, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: true, chat_id: chatId }));
  return true;
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

async function handleCommand(text: string, chatId: string, openId: string, msgTimestamp: number, chatType = "group", traceId?: string): Promise<void> {
  const tid = traceId ?? makeTraceId();
  const textLower = text.toLowerCase();
  if (textLower === "/restart") {
    logTrace(tid, "BRANCH", { cmd: "/restart" });
    const restartToken = await getTenantAccessToken();
    await sendTextReply(restartToken, chatId, "正在重启...").catch(() => {});
    logTrace(tid, "DONE", { outcome: "restart" });
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

  if (textLower === "/cd" || textLower.startsWith("/cd ")) {
    logTrace(tid, "BRANCH", { cmd: "/cd", arg: text.slice(3).trim() || "(none)" });
    const cdToken = await getTenantAccessToken();
    const currentDir = await getDefaultCwd(chatId);

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
        logTrace(tid, "DONE", { outcome: "cd_not_dir", targetDir });
        await sendCardReply(cdToken, chatId, "新会话工作路径", `路径存在但不是目录:\n\`${targetDir}\``, "red");
        return;
      }
    } catch {
      logTrace(tid, "DONE", { outcome: "cd_not_found", targetDir });
      await sendCardReply(cdToken, chatId, "新会话工作路径", `路径不存在:\n\`${targetDir}\``, "red");
      return;
    }

    // Change working dir if user provided a path
    const isUpdate = !!arg && targetDir !== currentDir;
    if (isUpdate) {
      await setDefaultCwd(targetDir, chatId);
      await addRecentDir(targetDir);
    }

    // Read directory entries
    let entries: string[];
    try {
      entries = await readdir(targetDir);
    } catch (err) {
      logTrace(tid, "DONE", { outcome: "cd_readdir_fail", error: (err as Error).message });
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
      const ok = await sendRawCard(cdToken, chatId, card);
      console.log(`[${ts()}] [CD] card sent, ok=${ok}, recentDirs=${recentDirs.length}`);
      logTrace(tid, "DONE", { outcome: "cd_card", ok });
    } else {
      // /cd <path>：切换目录，发送文本卡片
      const content = buildCdContent(targetDir, withStats, isUpdate, sessionCwd);
      await sendCardReply(cdToken, chatId, "新会话工作路径", content, "blue");
      logTrace(tid, "DONE", { outcome: "cd_path", targetDir, isUpdate });
    }
    return;
  }

  if (textLower === "/new" || textLower.startsWith("/new ")) {
    const toolArg = text.slice(5).trim().toLowerCase();
    const tool = toolArg || "claude";
    logTrace(tid, "BRANCH", { cmd: "/new", tool });
    const validTools = ["claude", "cursor", "codex"];
    if (!validTools.includes(tool)) {
      logTrace(tid, "DONE", { outcome: "new_invalid_tool", tool });
      const warnToken = await getTenantAccessToken();
      await sendCardReply(warnToken, chatId, "Error", `未知的工具类型: "${toolArg}"。支持: claude (Claude Code), cursor (Cursor), codex (Codex)。`, "red");
      return;
    }
    const toolLabel = toolDisplayName(tool);

    if (!openId) {
      logTrace(tid, "DONE", { outcome: "new_no_openid" });
      console.log(`[${ts()}] [WARN] Cannot get sender open_id`);
      const warnToken = await getTenantAccessToken();
      await sendCardReply(warnToken, chatId, "Error", "Cannot identify sender.", "red");
      return;
    }

    const freshToken = await getTenantAccessToken();

    let sessionId: string;
    let sessionCwd: string;
    try {
      const init = await initClaudeSession(tool, undefined, chatId);
      sessionId = init.sessionId;
      sessionCwd = init.cwd;
      console.log(`[${ts()}] [STEP 1/4] ${toolLabel} session created: ${sessionId} → OK`);
    } catch (err) {
      console.error(`[${ts()}] [STEP 1/4] FAIL: ${(err as Error).message}`);
      logTrace(tid, "DONE", { outcome: "new_session_fail", error: (err as Error).message });
      await sendCardReply(
        freshToken, chatId, "Error",
        `Failed to initialize ${toolLabel} session:\n${(err as Error).message}`,
        "red"
      );
      return;
    }

    const cwd = sessionCwd;
    const initialName = sessionChatName("新会话", cwd);

    // 私聊：不创建群，直接绑定 session 到当前私聊
    if (chatType === "p2p") {
      bindChatToSession(sessionId, chatId);
      sessionInfoMap.set(chatId, {
        sessionId,
        turnCount: 0,
        lastContextTokens: 0,
        startTime: Date.now(),
        tool,
      });
      await setDefaultCwd(cwd, chatId);
      await recordSessionRegistry({
        chatId,
        sessionId,
        tool,
        chatName: initialName,
        turnCount: 0,
        startTime: Date.now(),
        running: false,
      });
      await saveSessionTool(sessionId, tool, initialName);
      await sendCardReply(
        freshToken, chatId, `${toolLabel} Session Ready`,
        `这是你的 **${toolLabel}** 私聊会话。\n\n` +
          `**Session ID:** ${sessionId}\n` +
          `**工作目录:** \`${cwd}\`\n\n` +
          `直接在这里发消息即可与 ${toolLabel} 对话。\n\n` +
          `发送 **/sessions** 查看所有会话状态。\n` +
          `发送 \`/git <子命令>\` 在本会话工作目录执行 git，例如 \`/git status\`、\`/git log --oneline -n 5\`。`,
        "green"
      );
      console.log(`[${ts()}] [NEW] P2P session created: ${sessionId} (${toolLabel})`);
      logTrace(tid, "DONE", { outcome: "session_ready_p2p", chatId, sessionId, tool });
      return;
    }

    let newChatId: string;
    try {
      newChatId = await createGroupChat(freshToken, initialName, [openId]);
      console.log(`[${ts()}] [STEP 2/4] Created Feishu group: ${newChatId}  → OK`);
    } catch (err) {
      console.error(`[${ts()}] [STEP 2/4] FAIL: ${(err as Error).message}`);
      logTrace(tid, "DONE", { outcome: "new_group_fail", error: (err as Error).message });
      await sendCardReply(freshToken, chatId, "Error", `Failed to create group:\n${(err as Error).message}`, "red");
      return;
    }

    try {
      const descPrefix = sessionPrefixForTool(tool);
      await updateChatInfo(freshToken, newChatId, initialName, `${descPrefix} ${sessionId}`);
      console.log(`[${ts()}] [STEP 3/4] Renamed group → name="${initialName}" (${toolLabel}) → OK`);
    } catch (err) {
      console.error(`[${ts()}] [STEP 3/4] FAIL: ${(err as Error).message}`);
      logTrace(tid, "DONE", { outcome: "new_rename_fail", error: (err as Error).message });
      await sendCardReply(freshToken, chatId, "Error", `Group created but rename failed:\n${(err as Error).message}`, "yellow");
      return;
    }

    // 让新群的默认工作目录继承当前会话的 cwd
    await setDefaultCwd(cwd, newChatId);
    bindChatToSession(sessionId, newChatId);
    await recordSessionRegistry({
      chatId: newChatId,
      sessionId,
      tool,
      chatName: initialName,
      turnCount: 0,
      startTime: Date.now(),
      running: false,
    });
    await saveSessionTool(sessionId, tool, initialName);

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
    logTrace(tid, "DONE", { outcome: "session_ready", newChatId, sessionId, tool });
    setChatAvatar(freshToken, newChatId, tool, "new").catch(() => {});
    console.log(`${"=".repeat(60)}`);
    return;
  }

  // 检测会话上下文：群聊从 description 获取，私聊从 session-registry 获取
  let sessionId: string | null = null;
  let descriptionTool: string | null = null;
  let toolLabel: string | null = null;
  let chatInfo: Awaited<ReturnType<typeof getChatInfo>> | undefined;
  let description: string | undefined;

  if (chatType !== "p2p") {
    try {
      const token = await getTenantAccessToken();
      chatInfo = await getChatInfo(token, chatId);
      description = chatInfo.description;
      const sessionInfo = extractSessionInfo(description);
      if (sessionInfo) {
        sessionId = sessionInfo.sessionId;
        descriptionTool = sessionInfo.tool;
        toolLabel = toolDisplayName(descriptionTool);
      }
    } catch (err) {
      logTrace(tid, "BRANCH", { reason: "get_chat_info_failed", error: (err as Error).message });
      console.log(`[${ts()}] [INFO] Cannot get chat info for ${chatId}: ${(err as Error).message}`);
    }
  } else {
    // 私聊：从 session-registry.json 获取绑定的 session
    try {
      const registry = await loadSessionRegistryForBinding();
      const record = registry[chatId];
      if (record && record.sessionId && record.tool) {
        sessionId = record.sessionId;
        descriptionTool = record.tool;
        toolLabel = toolDisplayName(descriptionTool);
        // 确保 sessionInfoMap 中有该私聊的信息
        if (!sessionInfoMap.has(chatId)) {
          sessionInfoMap.set(chatId, {
            sessionId,
            turnCount: record.turnCount ?? 0,
            lastContextTokens: record.lastContextTokens ?? 0,
            startTime: record.startTime ?? Date.now(),
            tool: descriptionTool,
          });
        }
        bindChatToSession(sessionId, chatId);
      }
    } catch (err) {
      console.log(`[${ts()}] [INFO] Cannot load registry for p2p ${chatId}: ${(err as Error).message}`);
    }
  }

  if (sessionId && descriptionTool && toolLabel) {
    // 有会话上下文 — 路由到命令处理或 prompt
    logTrace(tid, "BRANCH", { sessionId, tool: descriptionTool });
    console.log(`[${ts()}] [RESUME] ${toolLabel} session group detected, session=${sessionId} tool=${descriptionTool}`);

      const freshToken = await getTenantAccessToken();

      if (chatType !== "p2p" && isUntitledSessionChatName(chatInfo!.name) && !textLower.startsWith("/")) {
        const MAX_PREFIX = 10;
        const prefix = text.slice(0, MAX_PREFIX);
        const adapter = getAdapterForTool(descriptionTool);
        const info = await adapter.getSessionInfo(sessionId).catch(() => undefined);
        const sessionCwd = info?.cwd ?? (await getDefaultCwd(chatId));
        const newName = sessionChatName(prefix, sessionCwd);
        try {
          await updateChatInfo(freshToken, chatId, newName, description!);
          console.log(`[${ts()}] [RENAME] First message → group renamed to "${newName}"`);
          await recordSessionRegistry({ chatId, sessionId, tool: descriptionTool, chatName: newName }).catch(() => {});
          await saveSessionTool(sessionId, descriptionTool, newName).catch(() => {});
        } catch (err) {
          console.error(`[${ts()}] [RENAME] Failed: ${(err as Error).message}`);
        }
      }

      if (textLower === "/stop") {
        logTrace(tid, "BRANCH", { cmd: "/stop" });
        if (stopSession(sessionId)) {
          console.log(`[${ts()}] [STOP] User sent /stop, session=${sessionId}`);
          await sendTextReply(freshToken, chatId, "会话已停止。").catch(() => {});
          logTrace(tid, "DONE", { outcome: "stopped" });
        } else {
          await sendTextReply(freshToken, chatId, "当前没有正在进行的会话。").catch(() => {});
          logTrace(tid, "DONE", { outcome: "stop_no_session" });
        }
        return;
      }

      if (textLower === "/status") {
        logTrace(tid, "BRANCH", { cmd: "/status" });
        const status = await getSessionStatus(chatId);
        const isActive = isSessionRunning(sessionId);
        const statusText = [
          `**群名:** ${status?.chatName || "—"}`,
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
        const ok = await sendRawCard(freshToken, chatId, card);
        console.log(`[${ts()}] [STATUS] card sent, ok=${ok}`);
        logTrace(tid, "DONE", { outcome: "status", ok });
        return;
      }

      if (textLower === "/sessions") {
        logTrace(tid, "BRANCH", { cmd: "/sessions" });
        const allSessions = await getAllSessionsStatus();
        const now = Date.now();
        const others = allSessions.filter(s => s.chatId !== chatId);
        const cardData = others.map(s => ({
          sessionId: s.sessionId,
          chatName: s.chatName,
          chatId: s.chatId,
          active: s.active,
          turnCount: s.turnCount,
          elapsedSeconds: s.active ? Math.floor((now - s.startTime) / 1000) : null,
          model: s.model,
          tool: s.tool,
        }));
        const card = buildSessionsCard(cardData);
        const ok = await sendRawCard(freshToken, chatId, card);
        console.log(`[${ts()}] [SESSIONS] card sent, ok=${ok}, count=${others.length}`);
        logTrace(tid, "DONE", { outcome: "sessions", ok, count: others.length });
        return;
      }

      if (textLower === "/newh") {
        logTrace(tid, "BRANCH", { cmd: "/newh" });
        const adapter = getAdapterForTool(descriptionTool);
        let cwd: string;
        try {
          const info = await adapter.getSessionInfo(sessionId);
          cwd = info?.cwd ?? (await getDefaultCwd(chatId));
        } catch {
          cwd = await getDefaultCwd(chatId);
        }

        // 不 abort 旧 session，只解绑当前 chat
        // 旧 session 如果正在跑，display loop 继续服务其他群
        unbindChatFromSession(sessionId, chatId);
        displayCards.delete(chatId);

        let newSessionId: string;
        try {
          const init = await initClaudeSession(descriptionTool, cwd);
          newSessionId = init.sessionId;
        } catch (err) {
          logTrace(tid, "DONE", { outcome: "newh_session_fail", error: (err as Error).message });
          await sendCardReply(freshToken, chatId, "Error", `Failed to create new session:\n${(err as Error).message}`, "red");
          return;
        }

        // 绑定新 session
        bindChatToSession(newSessionId, chatId);
        recordLastActiveChat(newSessionId, chatId);

        const descPrefix = sessionPrefixForTool(descriptionTool);
        const newName = sessionChatName("新会话", cwd);
        await updateChatInfo(freshToken, chatId, newName, `${descPrefix} ${newSessionId}`);
        console.log(`[${ts()}] [NEWH] Group updated: name="${newName}" desc="${descPrefix} ${newSessionId}"`);

        sessionInfoMap.set(chatId, {
          sessionId: newSessionId,
          turnCount: 0,
          lastContextTokens: 0,
          startTime: Date.now(),
          tool: descriptionTool,
        });
        await recordSessionRegistry({
          chatId,
          sessionId: newSessionId,
          tool: descriptionTool,
          chatName: newName,
          turnCount: 0,
          lastContextTokens: 0,
          startTime: Date.now(),
          running: false,
        });
        await saveSessionTool(newSessionId, descriptionTool, newName);

        setChatAvatar(freshToken, chatId, descriptionTool, "new").catch(() => {});

        // 如果新 session 有活跃 prompt，启动 display loop 让本群也能看到
        if (isSessionRunning(newSessionId)) {
          const { ensureDisplayLoop } = await import("./session.ts");
          ensureDisplayLoop(newSessionId);
        }

        await sendCardReply(
          freshToken, chatId, `${toolLabel} Session Reset`,
          `会话已重置为新的 **${toolLabel}** 会话。\n\n` +
            `**Session ID:** ${newSessionId}\n` +
            `**工作目录:** \`${cwd}\`\n\n` +
            `直接在这里发消息即可继续对话。`,
          "green"
        );

        console.log(`[${ts()}] [NEWH] Session ${sessionId} → ${newSessionId} (same cwd=${cwd})`);
        logTrace(tid, "DONE", { outcome: "newh", newSessionId, cwd });
        return;
      }

      if (textLower === "/deleteg") {
        logTrace(tid, "BRANCH", { cmd: "/deleteg" });
        if (chatType === "p2p") {
          await sendTextReply(freshToken, chatId, "私聊无法使用 /deleteg，该指令仅用于群聊。").catch(() => {});
          logTrace(tid, "DONE", { outcome: "deleteg_p2p" });
          return;
        }
        console.log(`[${ts()}] [DELETEG] Disbanding group chat ${chatId}, session=${sessionId}`);

        // 先解绑 session（不删除 Agent 会话）
        unbindChatFromSession(sessionId, chatId);
        displayCards.delete(chatId);
        sessionInfoMap.delete(chatId);
        await removeSessionRegistryRecord(chatId);

        await sendTextReply(freshToken, chatId, "群聊已解散，Agent 会话保留。").catch(() => {});

        // 解散群聊（飞书 API）
        try {
          await disbandChat(freshToken, chatId);
          console.log(`[${ts()}] [DELETEG] Group disbanded: ${chatId}`);
        } catch (err) {
          console.error(`[${ts()}] [DELETEG] Disband API failed: ${(err as Error).message}`);
        }

        logTrace(tid, "DONE", { outcome: "deleteg", chatId, sessionId });
        return;
      }

      // /session <number>：切换到 /sessions 列表中的指定会话
      const sessionMatch = textLower.match(/^\/session\s+(\d+)$/);
      if (sessionMatch) {
        const index = parseInt(sessionMatch[1], 10) - 1;
        logTrace(tid, "BRANCH", { cmd: "/session", index: index + 1 });
        const allSessions = await getAllSessionsStatus();
        // 与 buildSessionsCard 保持一致的排序：Claude Code → Cursor → Codex，组内保持 updatedAt 降序
        const claudeOrdered = allSessions.filter(s => s.tool !== "cursor" && s.tool !== "codex");
        const cursorOrdered = allSessions.filter(s => s.tool === "cursor");
        const codexOrdered = allSessions.filter(s => s.tool === "codex");
        const ordered = [...claudeOrdered, ...cursorOrdered, ...codexOrdered].filter(s => s.chatId !== chatId);
        if (ordered.length === 0) {
          await sendCardReply(freshToken, chatId, "/session", "暂无历史会话。", "yellow");
          logTrace(tid, "DONE", { outcome: "session_no_sessions" });
          return;
        }
        if (index < 0 || index >= ordered.length) {
          await sendCardReply(freshToken, chatId, "/session", `序号超出范围，当前共 ${ordered.length} 个会话。`, "yellow");
          logTrace(tid, "DONE", { outcome: "session_out_of_range", index: index + 1, total: ordered.length });
          return;
        }
        const target = ordered[index];

        // 不 abort 当前 chat 的旧 session，只解绑再重新绑定
        if (sessionId) {
          unbindChatFromSession(sessionId, chatId);
          displayCards.delete(chatId);
        }

        const targetAdapter = getAdapterForTool(target.tool);
        let cwd2: string;
        try {
          const targetInfo = await targetAdapter.getSessionInfo(target.sessionId);
          cwd2 = targetInfo?.cwd ?? (await getDefaultCwd(chatId));
        } catch {
          cwd2 = await getDefaultCwd(chatId);
        }

        // 绑定到新 session
        bindChatToSession(target.sessionId, chatId);
        recordLastActiveChat(target.sessionId, chatId);

        const descPrefix2 = sessionPrefixForTool(target.tool);
        const newName2 = target.chatName || sessionChatName("新会话", cwd2);
        await updateChatInfo(freshToken, chatId, newName2, `${descPrefix2} ${target.sessionId}`);
        console.log(`[${ts()}] [SESSION] Switched to session ${target.sessionId} (#${index + 1}), name="${newName2}"`);

        sessionInfoMap.set(chatId, {
          sessionId: target.sessionId,
          turnCount: target.turnCount,
          lastContextTokens: 0,
          startTime: Date.now(),
          tool: target.tool,
        });
        await recordSessionRegistry({
          chatId,
          sessionId: target.sessionId,
          tool: target.tool,
          chatName: newName2,
          running: false,
        });
        await saveSessionTool(target.sessionId, target.tool, newName2);

        setChatAvatar(freshToken, chatId, target.tool, "new").catch(() => {});

        // 如果新 session 有活跃 prompt，加上 display loop
        if (isSessionRunning(target.sessionId)) {
          const { ensureDisplayLoop } = await import("./session.ts");
          ensureDisplayLoop(target.sessionId);
        }

        const targetToolLabel = toolDisplayName(target.tool);
        const busyNote = isSessionRunning(target.sessionId) ? "\n\n⚠️ 该会话当前正在生成中，请等待完成后再发送消息。" : "";
        await sendCardReply(
          freshToken, chatId, `${targetToolLabel} Session Switched`,
          `已切换到 **${targetToolLabel}** 会话。\n\n` +
            `**序号:** ${index + 1}\n` +
            `**Session ID:** ${target.sessionId}\n` +
            `**工作目录:** \`${cwd2}\`\n\n` +
            `直接在这里发消息即可继续对话。${busyNote}`,
          "green"
        );

        logTrace(tid, "DONE", { outcome: "session_switch", sessionId: target.sessionId, index: index + 1, cwd: cwd2 });
        return;
      }

      // /git <args>：在「当前会话工作目录」执行 git 命令，把输出回发到群里。
      // 注意 cwd 必须取自 adapter.getSessionInfo（会话真实 cwd），而非
      // getDefaultCwd（下一次 /new 才会使用的默认路径）。
      if (textLower.startsWith("/git ") || textLower === "/git") {
        const args = text === "/git" ? "" : text.slice(5).trim();
        logTrace(tid, "BRANCH", { cmd: "/git", args: args || "(none)" });
        if (!args) {
          logTrace(tid, "DONE", { outcome: "git_no_args" });
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
          logTrace(tid, "DONE", { outcome: "git_no_cwd", tool: descriptionTool });
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
        logTrace(tid, "DONE", { outcome: "git_result", exitCode: result.exitCode, durationMs: result.durationMs });
        return;
      }

      const lastTs = lastMsgTimestamps.get(chatId);
      if (lastTs !== undefined && msgTimestamp <= lastTs) {
        logTrace(tid, "DONE", { outcome: "skip_old_message_no_session", msgTimestamp, lastTimestamp: lastTs });
        console.log(`[${ts()}] [SKIP] Older message (${msgTimestamp} <= ${lastTs}), no active session, ignoring`);
        return;
      }

      // 并发检查：同一 session 只能有一个活跃 prompt
      if (isSessionRunning(sessionId)) {
        logTrace(tid, "BLOCKED", { outcome: "session_busy", sessionId });
        console.log(`[${ts()}] [BLOCKED] Session ${sessionId} is already generating, rejecting message from chat ${chatId}`);
        await sendCardReply(
          freshToken, chatId, "生成中",
          "该会话正在生成回复中，请等待完成后再发送新消息。",
          "yellow"
        );
        return;
      }

      try {
        logTrace(tid, "RESUME", { sessionId, tool: descriptionTool });
        await resumeAndPrompt(sessionId, text, freshToken, chatId, msgTimestamp, descriptionTool, tid);
        logTrace(tid, "DONE", { outcome: "resume_done", sessionId });
        console.log(`[${ts()}] [RESUME] Session ${sessionId} done`);
      } catch (err) {
        logTrace(tid, "DONE", { outcome: "resume_fail", error: (err as Error).message });
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

  // 无会话上下文 → help card

  // 私聊或群聊无 session info → 发送 help card
  logTrace(tid, "SEND", { method: "help_card", chatId });
  const replyToken = await getTenantAccessToken();
  const card = buildHelpCard(text);
  const ok = await sendRawCard(replyToken, chatId, card);
  if (!ok) {
    console.error(`[${ts()}] [SEND] help_card FAIL: chatId=${chatId}`);
    logTrace(tid, "DONE", { outcome: "help_card_fail" });
  } else {
    console.log(`[${ts()}] [SEND] help_card OK: chatId=${chatId}`);
    logTrace(tid, "DONE", { outcome: "help_card_sent" });
  }
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
  console.log(`  Send "/new" to the bot to create a new group + ${toolDisplayName(resolveDefaultAgentTool())} session.`);
  console.log(`  In a session group, send any message to resume & prompt.`);
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
      const traceId = makeTraceId();
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

      const text = await formatMessageContent(message);
      const sender = event.sender;
      const openId = sender?.sender_id?.open_id ?? "";
      const chatId = message.chat_id ?? "";
      const chatType = message.chat_type ?? "group";

      console.log(`[MSG] sender=${openId} chat=${chatId} type=${chatType} text="${text}"`);
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
      logTrace(traceId, "RECV", { chatId, chatType, text: text.slice(0, 100) });
      const delayNotice = formatDelayNotice(msgTimestamp, text);
      if (delayNotice) {
        const delayToken = await getTenantAccessToken();
        await sendCardReply(delayToken, chatId, "延迟送达", delayNotice, "yellow").catch(() => {});
      }
      await handleCommand(text, chatId, openId, msgTimestamp, chatType, traceId);
      } catch (err) {
        logTrace(traceId, "ERROR", { message: (err as Error).message });
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
    ws.on("message", async (raw: Buffer) => {
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
        const text = await formatMessageContent(message);
        const openId = event.sender?.sender_id?.open_id ?? "";
        const chatId = message.chat_id ?? "";
        appendChatLog(chatId, openId, text);
        if (text.toLowerCase() === "/new" && openId) {
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
    // 启动时修正残留的 running 状态并重建 session→chat 映射
    fixStaleStreamStates().then(async () => {
      const registry = await loadSessionRegistryForBinding();
      rebuildSessionChatsFromRegistry(registry);
    }).catch((err) => console.error(`[${ts()}] Init bindings failed: ${(err as Error).message}`));

    const wsClient = new WSClient({
      appId: APP_ID,
      appSecret: APP_SECRET,
      onReady: async () => {
        resetState();
        const registry = await loadSessionRegistryForBinding();
        rebuildSessionChatsFromRegistry(registry);
      },
      onReconnected: async () => {
        resetState();
        const registry = await loadSessionRegistryForBinding();
        rebuildSessionChatsFromRegistry(registry);
      },
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

  // 模拟模式：独立端口 18079，不与 SDK 实例冲突，不走飞书凭证/权限/WSClient
  if (USE_SIMULATE) {
    const SIM_PORT = 18079;
    console.log("\n[Simulate] 模拟飞书环境模式");
    setPlatform(SimulatedPlatform);
    console.log("  已切换到 SimulatedPlatform（零飞书依赖）");
    appendStartupTrace("main: simulate mode", { port: SIM_PORT });

    // 注册消息处理器，让 SimAgent.sendMessage() 能进程内触发 handleCommand
    setMessageHandler(
      (text, chatId, openId, _ts, chatType, traceId) =>
        handleCommand(text, chatId, openId, Date.now(), chatType, traceId),
    );

    setExtraApiHandler(async (req, res) => {
      const injected = await handleSimInjectMessage(req, res);
      if (injected) return true;
      return (await handleAgentImageRequest(req, res)) || (await handleAgentFileRequest(req, res));
    });

    const simServer = createServer(createUiRouter());
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        simServer.removeListener("listening", onListening);
        rejectListen(err);
      };
      const onListening = (): void => {
        simServer.removeListener("error", onError);
        resolveListen();
      };
      simServer.once("error", onError);
      simServer.once("listening", onListening);
      simServer.listen(SIM_PORT, "127.0.0.1");
    }).catch((err: NodeJS.ErrnoException) => {
      console.error(`\n[启动] 监听失败：端口 ${SIM_PORT}（${err.code ?? "?"} — ${err.message}）`);
      process.exit(1);
    });

    console.log(`\n${"=".repeat(60)}`);
    console.log(`  ChatCCC — 模拟飞书环境模式`);
    console.log(`${"=".repeat(60)}`);
    console.log(`  发送消息: POST http://127.0.0.1:${SIM_PORT}/api/sim/inject-message`);
    console.log(`  消息日志: ~/.chatccc/sim/messages.jsonl`);
    console.log(`${"=".repeat(60)}\n`);

    installShutdownHandlers(simServer);
    return;
  }

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
  setExtraApiHandler(async (req, res) => {
    return (await handleAgentImageRequest(req, res)) || (await handleAgentFileRequest(req, res));
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
  const killed = freeRelayListenPort(CHATCCC_PORT);
  appendStartupTrace("main: after freeRelayListenPort", { CHATCCC_PORT, killed });
  if (killed > 0) {
    await waitForPortFree(CHATCCC_PORT);
    appendStartupTrace("main: port free confirmed", { CHATCCC_PORT });
  }
  const httpServer = createServer(createUiRouter());
  await listenWithRetry(httpServer, CHATCCC_PORT, "127.0.0.1").catch((err: NodeJS.ErrnoException) => {
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
 * 带重试的 server.listen，Windows 端口释放有延迟时自动重试。
 */
async function listenWithRetry(
  server: ReturnType<typeof createServer>,
  port: number,
  host: string,
  maxRetries = 3,
): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.once("listening", resolve);
        server.listen(port, host);
      });
      return;
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      server.removeAllListeners("listening");
      server.removeAllListeners("error");
      if (e.code === "EADDRINUSE" && i < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, 500 * (i + 1)));
        continue;
      }
      throw err;
    }
  }
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
