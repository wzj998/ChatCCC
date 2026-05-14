/**
 * orchestrator.ts — 平台无关的消息命令处理
 *
 * Phase 1: 从 index.ts 抽出 handleCommand 及辅助函数。
 * 所有 IM 平台操作通过 PlatformAdapter 接口注入，不直接依赖 feishu-platform.ts。
 */

import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { resolve, dirname } from "node:path";

import { makeTraceId, logTrace } from "./trace.ts";
import {
  CLAUDE_EFFORT,
  CLAUDE_MODEL,
  GIT_TIMEOUT_MS,
  PROJECT_ROOT,
  anthropicConfigDisplay,
  fileLog,
  getDefaultCwd,
  setDefaultCwd,
  getRecentDirs,
  addRecentDir,
  sessionPrefixForTool,
  toolDisplayName,
  ts,
} from "./config.ts";
import {
  buildHelpCard,
  buildStatusCard,
  buildCdContent,
  buildCdCard,
  buildSessionsCard,
} from "./cards.ts";
import {
  formatGitResult,
  gitResultHeaderTemplate,
  runGitCommand,
} from "./git-command.ts";
import {
  getSessionStatus,
  getAllSessionsStatus,
  initClaudeSession,
  lastMsgTimestamps,
  resumeAndPrompt,
  sessionInfoMap,
  switchChatBinding,
  recordSessionRegistry,
  getAdapterForTool,
  stopSession,
  loadSessionRegistryForBinding,
  removeSessionRegistryRecord,
  saveSessionTool,
  recordChatPlatform,
} from "./session.ts";
import {
  bindChatToSession,
  unbindChatFromSession,
  isSessionRunning,
  displayCards,
  recordLastActiveChat,
} from "./session-chat-binding.ts";
export { type PlatformAdapter } from "./platform-adapter.ts";
import type { PlatformAdapter } from "./platform-adapter.ts";

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

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
// handleCommand — 平台无关的命令分发
// ---------------------------------------------------------------------------

export async function handleCommand(
  platform: PlatformAdapter,
  text: string,
  chatId: string,
  openId: string,
  msgTimestamp: number,
  chatType = "group",
  traceId?: string,
): Promise<void> {
  const tid = traceId ?? makeTraceId();
  const textLower = text.toLowerCase();
  recordChatPlatform(chatId, platform);

  if (textLower === "/restart") {
    logTrace(tid, "BRANCH", { cmd: "/restart" });
    await platform.sendText(chatId, "重启中...请几秒后发消息唤醒我").catch(() => {});
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
    logTrace(tid, "BRANCH", {
      cmd: "/cd",
      arg: text.slice(3).trim() || "(none)",
    });
    const currentDir = await getDefaultCwd(chatId);

    // 获取当前会话的实际工作路径（若在会话群内）
    let sessionCwd: string | undefined;
    try {
      const chatInfo = await platform.getChatInfo(chatId);
      const sessionInfoResult = platform.extractSessionInfo(
        chatInfo.description,
      );
      if (sessionInfoResult) {
        const adapter = getAdapterForTool(sessionInfoResult.tool);
        const info = await adapter.getSessionInfo(sessionInfoResult.sessionId);
        sessionCwd = info?.cwd;
      }
    } catch {
      /* 非会话群或获取失败，不显示 */
    }

    const arg = text.slice(3).trim();

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
        await platform.sendCard(
          chatId,
          "新会话工作路径",
          `路径存在但不是目录:\n\`${targetDir}\``,
          "red",
        );
        return;
      }
    } catch {
      logTrace(tid, "DONE", { outcome: "cd_not_found", targetDir });
      await platform.sendCard(
        chatId,
        "新会话工作路径",
        `路径不存在:\n\`${targetDir}\``,
        "red",
      );
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
      logTrace(tid, "DONE", {
        outcome: "cd_readdir_fail",
        error: (err as Error).message,
      });
      await platform.sendCard(
        chatId,
        "新会话工作路径",
        `无法读取目录:\n\`${targetDir}\`\n\n${(err as Error).message}`,
        "red",
      );
      return;
    }

    // Sort: directories first, then files, alphabetically within each group
    const withStats: { name: string; isDir: boolean }[] = [];
    for (const name of entries) {
      try {
        const s = await stat(resolve(targetDir, name));
        withStats.push({ name, isDir: s.isDirectory() });
      } catch {
        withStats.push({ name, isDir: false });
      }
    }
    withStats.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    if (!arg) {
      // /cd 无参数：展示卡片（含最近使用路径按钮）
      const recentDirs = await getRecentDirs();
      const card = buildCdCard(targetDir, withStats, recentDirs, sessionCwd);
      const ok = await platform.sendRawCard(chatId, card);
      console.log(
        `[${ts()}] [CD] card sent, ok=${ok}, recentDirs=${recentDirs.length}`,
      );
      logTrace(tid, "DONE", { outcome: "cd_card", ok });
    } else {
      // /cd <path>：切换目录，发送文本卡片
      const content = buildCdContent(targetDir, withStats, isUpdate, sessionCwd);
      await platform.sendCard(chatId, "新会话工作路径", content, "blue");
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
      await platform.sendCard(
        chatId,
        "Error",
        `未知的工具类型: "${toolArg}"。支持: claude (Claude Code), cursor (Cursor), codex (Codex)。`,
        "red",
      );
      return;
    }
    const toolLabel = toolDisplayName(tool);

    if (!openId) {
      logTrace(tid, "DONE", { outcome: "new_no_openid" });
      console.log(`[${ts()}] [WARN] Cannot get sender open_id`);
      await platform.sendCard(
        chatId,
        "Error",
        "Cannot identify sender.",
        "red",
      );
      return;
    }

    let sessionId: string;
    let sessionCwd: string;
    try {
      const init = await initClaudeSession(tool, undefined, chatId);
      sessionId = init.sessionId;
      sessionCwd = init.cwd;
      console.log(
        `[${ts()}] [STEP 1/4] ${toolLabel} session created: ${sessionId} → OK`,
      );
    } catch (err) {
      console.error(`[${ts()}] [STEP 1/4] FAIL: ${(err as Error).message}`);
      logTrace(tid, "DONE", {
        outcome: "new_session_fail",
        error: (err as Error).message,
      });
      await platform.sendCard(
        chatId,
        "Error",
        `Failed to initialize ${toolLabel} session:\n${(err as Error).message}`,
        "red",
      );
      return;
    }

    const cwd = sessionCwd;
    const initialName = sessionChatName("新会话", cwd);

    // 私聊：不创建群，直接绑定 session 到当前私聊
    if (chatType === "p2p") {
      // 先解绑旧 session（如果存在），避免旧 session 的 display loop
      // 继续往同一个 chat 推送内容（/newh 走 switchChatBinding 已有此逻辑，
      // 但 /new p2p 之前遗漏了解绑）。
      const oldRegistry = await loadSessionRegistryForBinding();
      const oldRecord = oldRegistry[chatId];
      if (oldRecord?.sessionId && oldRecord.sessionId !== sessionId) {
        unbindChatFromSession(oldRecord.sessionId, chatId);
        displayCards.delete(chatId);
      }
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
      await platform.sendCard(
        chatId,
        `${toolLabel} Session Ready`,
        `这是你的 **${toolLabel}** 私聊会话。\n\n` +
          `**Session ID:** ${sessionId}\n` +
          `**工作目录:** \`${cwd}\`\n\n` +
          `直接在这里发消息即可与 ${toolLabel} 对话。\n\n` +
          `发送 **/cd** 切换新建会话的默认目录。\n` +
          `发送 **/new** 创建新会话，**/newh** 重置当前会话（沿用工作目录）。\n` +
          `发送 **/sessions** 查看所有会话状态。\n` +
          `发送 \`/git <子命令>\` 在本会话工作目录执行 git，例如 \`/git status\`、\`/git log --oneline -n 5\`。`,
        "green",
      );
      console.log(
        `[${ts()}] [NEW] P2P session created: ${sessionId} (${toolLabel})`,
      );
      logTrace(tid, "DONE", {
        outcome: "session_ready_p2p",
        chatId,
        sessionId,
        tool,
      });
      return;
    }

    let newChatId: string;
    try {
      newChatId = await platform.createGroup(initialName, [openId]);
      console.log(
        `[${ts()}] [STEP 2/4] Created Feishu group: ${newChatId}  → OK`,
      );
    } catch (err) {
      console.error(`[${ts()}] [STEP 2/4] FAIL: ${(err as Error).message}`);
      logTrace(tid, "DONE", {
        outcome: "new_group_fail",
        error: (err as Error).message,
      });
      await platform.sendCard(
        chatId,
        "Error",
        `Failed to create group:\n${(err as Error).message}`,
        "red",
      );
      return;
    }

    try {
      const descPrefix = sessionPrefixForTool(tool);
      await platform.updateChatInfo(
        newChatId,
        initialName,
        `${descPrefix} ${sessionId}`,
      );
      console.log(
        `[${ts()}] [STEP 3/4] Renamed group → name="${initialName}" (${toolLabel}) → OK`,
      );
    } catch (err) {
      console.error(`[${ts()}] [STEP 3/4] FAIL: ${(err as Error).message}`);
      logTrace(tid, "DONE", {
        outcome: "new_rename_fail",
        error: (err as Error).message,
      });
      await platform.sendCard(
        chatId,
        "Error",
        `Group created but rename failed:\n${(err as Error).message}`,
        "yellow",
      );
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

    await platform.sendCard(
      newChatId,
      `${toolLabel} Session Ready`,
      `群聊已创建，这是你的 **${toolLabel}** 会话群。\n\n` +
        `**Session ID:** ${sessionId}\n` +
        `**工作目录:** \`${cwd}\`\n\n` +
        `直接在这里发消息即可与 ${toolLabel} 对话。\n\n` +
        `发送 **/cd** 切换新建会话的默认目录。\n` +
        `发送 **/new** 创建新会话，**/newh** 重置当前会话（沿用工作目录）。\n` +
        `发送 **/sessions** 查看所有会话状态。\n` +
        `发送 \`/git <子命令>\` 在本会话工作目录执行 git，例如 \`/git status\`、\`/git log --oneline -n 5\`。`,
      "green",
    );

    console.log(`[${ts()}] [STEP 4/4] Replied to new group → OK`);
    logTrace(tid, "DONE", {
      outcome: "session_ready",
      newChatId,
      sessionId,
      tool,
    });
    platform.setChatAvatar(newChatId, tool, "new").catch(() => {});
    console.log(`${"=".repeat(60)}`);
    return;
  }

  // 检测会话上下文：群聊从 description 获取，私聊从 session-registry 获取
  let sessionId: string | null = null;
  let descriptionTool: string | null = null;
  let toolLabel: string | null = null;
  let chatInfo: Awaited<ReturnType<PlatformAdapter["getChatInfo"]>> | undefined;
  let description: string | undefined;

  if (chatType !== "p2p") {
    try {
      chatInfo = await platform.getChatInfo(chatId);
      description = chatInfo.description;
      const sessionInfo = platform.extractSessionInfo(description);
      if (sessionInfo) {
        sessionId = sessionInfo.sessionId;
        descriptionTool = sessionInfo.tool;
        toolLabel = toolDisplayName(descriptionTool);
      }
    } catch (err) {
      logTrace(tid, "BRANCH", {
        reason: "get_chat_info_failed",
        error: (err as Error).message,
      });
      console.log(
        `[${ts()}] [INFO] Cannot get chat info for ${chatId}: ${(err as Error).message}`,
      );
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
      console.log(
        `[${ts()}] [INFO] Cannot load registry for p2p ${chatId}: ${(err as Error).message}`,
      );
    }
  }

  if (sessionId && descriptionTool && toolLabel) {
    // 有会话上下文 — 路由到命令处理或 prompt
    logTrace(tid, "BRANCH", { sessionId, tool: descriptionTool });
    console.log(
      `[${ts()}] [RESUME] ${toolLabel} session group detected, session=${sessionId} tool=${descriptionTool}`,
    );

    if (
      chatType !== "p2p" &&
      isUntitledSessionChatName(chatInfo!.name) &&
      !textLower.startsWith("/")
    ) {
      const MAX_PREFIX = 10;
      const prefix = text.slice(0, MAX_PREFIX);
      const adapter = getAdapterForTool(descriptionTool);
      const info = await adapter
        .getSessionInfo(sessionId)
        .catch(() => undefined);
      const sessionCwd = info?.cwd ?? (await getDefaultCwd(chatId));
      const newName = sessionChatName(prefix, sessionCwd);
      try {
        await platform.updateChatInfo(chatId, newName, description!);
        console.log(
          `[${ts()}] [RENAME] First message → group renamed to "${newName}"`,
        );
        await recordSessionRegistry({
          chatId,
          sessionId,
          tool: descriptionTool,
          chatName: newName,
        }).catch(() => {});
        await saveSessionTool(sessionId, descriptionTool, newName).catch(
          () => {},
        );
      } catch (err) {
        console.error(
          `[${ts()}] [RENAME] Failed: ${(err as Error).message}`,
        );
      }
    }

    // 微信 P2P：首条非指令消息 → 更新 registry 中的会话名
    if (
      chatType === "p2p" &&
      platform.kind === "wechat" &&
      !textLower.startsWith("/")
    ) {
      try {
        const reg = await loadSessionRegistryForBinding();
        const rec = reg[chatId];
        if (
          rec &&
          rec.sessionId === sessionId &&
          isUntitledSessionChatName(rec.chatName ?? "")
        ) {
          const MAX_PREFIX = 10;
          const prefix = text.slice(0, MAX_PREFIX);
          const adapter = getAdapterForTool(descriptionTool!);
          const info = await adapter
            .getSessionInfo(sessionId)
            .catch(() => undefined);
          const sessionCwd =
            info?.cwd ?? (await getDefaultCwd(chatId));
          const newName2 = sessionChatName(prefix, sessionCwd);
          await recordSessionRegistry({
            chatId,
            sessionId,
            tool: descriptionTool!,
            chatName: newName2,
          }).catch(() => {});
          await saveSessionTool(sessionId, descriptionTool!, newName2).catch(
            () => {},
          );
          console.log(
            `[${ts()}] [RENAME] WeChat P2P → "${newName2}"`,
          );
        }
      } catch (err) {
        console.error(
          `[${ts()}] [RENAME] WeChat P2P failed: ${(err as Error).message}`,
        );
      }
    }

    if (textLower === "/stop") {
      logTrace(tid, "BRANCH", { cmd: "/stop" });
      if (stopSession(sessionId)) {
        console.log(`[${ts()}] [STOP] User sent /stop, session=${sessionId}`);
        await platform.sendText(chatId, "会话已停止。").catch(() => {});
        logTrace(tid, "DONE", { outcome: "stopped" });
      } else {
        await platform
          .sendText(chatId, "当前没有正在进行的会话。")
          .catch(() => {});
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
      if (status?.effort != null) {
        statusText.push(`**Effort:** ${status.effort}`);
      }
      if (isActive) {
        const elapsed = Math.floor((Date.now() - status!.startTime) / 1000);
        const mins = Math.floor(elapsed / 60);
        const secs = elapsed % 60;
        statusText.push(`**本轮已运行:** ${mins}分${secs}秒`);
        statusText.push(
          `**已产出总字符:** ${status!.accumulatedLength.toLocaleString()}`,
        );
      }
      if (status?.lastContextTokens) {
        statusText.push(
          `**上下文 Token 数:** ~${status.lastContextTokens.toLocaleString()}`,
        );
      }
      const card = buildStatusCard(
        statusText.join("\n"),
        isActive ? "blue" : "green",
      );
      const ok = await platform.sendRawCard(chatId, card);
      console.log(`[${ts()}] [STATUS] card sent, ok=${ok}`);
      logTrace(tid, "DONE", { outcome: "status", ok });
      return;
    }

    if (textLower === "/sessions") {
      logTrace(tid, "BRANCH", { cmd: "/sessions" });
      const allSessions = await getAllSessionsStatus();
      const now = Date.now();
      const cardData = allSessions.map((s) => ({
        sessionId: s.sessionId,
        chatName: s.chatName,
        chatId: s.chatId,
        active: s.active,
        turnCount: s.turnCount,
        elapsedSeconds: s.active
          ? Math.floor((now - s.startTime) / 1000)
          : null,
        model: s.model,
        tool: s.tool,
      }));
      const card = buildSessionsCard(cardData);
      const ok = await platform.sendRawCard(chatId, card);
      console.log(
        `[${ts()}] [SESSIONS] card sent, ok=${ok}, count=${cardData.length}`,
      );
      logTrace(tid, "DONE", { outcome: "sessions", ok, count: cardData.length });
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

      // 第一步:创建新 session(此时尚未碰任何内存绑定,失败可直接返回,
      // 旧 session 状态完全保留)。
      let newSessionId: string;
      try {
        const init = await initClaudeSession(descriptionTool, cwd);
        newSessionId = init.sessionId;
      } catch (err) {
        logTrace(tid, "DONE", {
          outcome: "newh_session_fail",
          error: (err as Error).message,
        });
        await platform.sendCard(
          chatId,
          "Error",
          `Failed to create new session:\n${(err as Error).message}`,
          "red",
        );
        return;
      }

      // 第二步:事务式切换 chat 绑定
      const descPrefix = sessionPrefixForTool(descriptionTool);
      const newName = sessionChatName("新会话", cwd);
      const switchResult = await switchChatBinding({
        chatId,
        chatType,
        oldSessionId: sessionId,
        newSessionId,
        tool: descriptionTool,
        chatName: newName,
        newDescription: `${descPrefix} ${newSessionId}`,
        updateChatInfoFn: (cid, name, desc) =>
          platform.updateChatInfo(cid, name, desc),
      });
      if (!switchResult.ok) {
        logTrace(tid, "DONE", {
          outcome: "newh_update_chat_fail",
          error: switchResult.error?.message,
        });
        await platform.sendCard(
          chatId,
          "Error",
          `更新群描述失败,会话未切换(新 session 已创建但未启用):\n${switchResult.error?.message}`,
          "red",
        );
        return;
      }
      if (chatType !== "p2p") {
        console.log(
          `[${ts()}] [NEWH] Group updated: name="${newName}" desc="${descPrefix} ${newSessionId}"`,
        );
      }

      platform
        .setChatAvatar(chatId, descriptionTool, "new")
        .catch(() => {});

      if (isSessionRunning(newSessionId)) {
        const { ensureDisplayLoop } = await import("./session.ts");
        ensureDisplayLoop(newSessionId);
      }

      await platform.sendCard(
        chatId,
        `${toolLabel} Session Reset`,
        `会话已重置为新的 **${toolLabel}** 会话。\n\n` +
          `**Session ID:** ${newSessionId}\n` +
          `**工作目录:** \`${cwd}\`（沿用当前会话目录）\n\n` +
          `直接在这里发消息即可继续对话。\n` +
          `发送 **/cd** 可切换新建会话的默认目录。`,
        "green",
      );

      console.log(
        `[${ts()}] [NEWH] Session ${sessionId} → ${newSessionId} (same cwd=${cwd})`,
      );
      logTrace(tid, "DONE", { outcome: "newh", newSessionId, cwd });
      return;
    }

    if (textLower === "/deleteg") {
      logTrace(tid, "BRANCH", { cmd: "/deleteg" });
      if (chatType === "p2p") {
        await platform
          .sendText(chatId, "私聊无法使用 /deleteg，该指令仅用于群聊。")
          .catch(() => {});
        logTrace(tid, "DONE", { outcome: "deleteg_p2p" });
        return;
      }
      console.log(
        `[${ts()}] [DELETEG] Disbanding group chat ${chatId}, session=${sessionId}`,
      );

      // 先解绑 session（不删除 Agent 会话）
      unbindChatFromSession(sessionId, chatId);
      displayCards.delete(chatId);
      sessionInfoMap.delete(chatId);
      await removeSessionRegistryRecord(chatId);

      await platform
        .sendText(chatId, "群聊已解散，Agent 会话保留。")
        .catch(() => {});

      // 解散群聊
      try {
        await platform.disbandChat(chatId);
        console.log(`[${ts()}] [DELETEG] Group disbanded: ${chatId}`);
      } catch (err) {
        console.error(
          `[${ts()}] [DELETEG] Disband API failed: ${(err as Error).message}`,
        );
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
      const claudeOrdered = allSessions.filter(
        (s) => s.tool !== "cursor" && s.tool !== "codex",
      );
      const cursorOrdered = allSessions.filter((s) => s.tool === "cursor");
      const codexOrdered = allSessions.filter((s) => s.tool === "codex");
      const ordered = [
        ...claudeOrdered,
        ...cursorOrdered,
        ...codexOrdered,
      ];
      if (ordered.length === 0) {
        await platform.sendCard(
          chatId,
          "/session",
          "暂无历史会话。",
          "yellow",
        );
        logTrace(tid, "DONE", { outcome: "session_no_sessions" });
        return;
      }
      if (index < 0 || index >= ordered.length) {
        await platform.sendCard(
          chatId,
          "/session",
          `序号超出范围，当前共 ${ordered.length} 个会话。`,
          "yellow",
        );
        logTrace(tid, "DONE", {
          outcome: "session_out_of_range",
          index: index + 1,
          total: ordered.length,
        });
        return;
      }
      const target = ordered[index];

      // 切换到当前已在使用的会话：no-op，避免解绑再重绑的抖动
      if (target.sessionId === sessionId) {
        await platform.sendCard(
          chatId,
          "/session",
          "已经是当前会话。",
          "green",
        );
        logTrace(tid, "DONE", { outcome: "session_already_current", sessionId });
        return;
      }

      const targetAdapter = getAdapterForTool(target.tool);
      let cwd2: string;
      try {
        const targetInfo = await targetAdapter.getSessionInfo(
          target.sessionId,
        );
        cwd2 = targetInfo?.cwd ?? (await getDefaultCwd(chatId));
      } catch {
        cwd2 = await getDefaultCwd(chatId);
      }

      const descPrefix2 = sessionPrefixForTool(target.tool);
      const newName2 = target.chatName || sessionChatName("新会话", cwd2);
      const switchResult = await switchChatBinding({
        chatId,
        chatType,
        oldSessionId: sessionId,
        newSessionId: target.sessionId,
        tool: target.tool,
        chatName: newName2,
        newDescription: `${descPrefix2} ${target.sessionId}`,
        initialTurnCount: target.turnCount,
        initialContextTokens: 0,
        updateChatInfoFn: (cid, name, desc) =>
          platform.updateChatInfo(cid, name, desc),
      });
      if (!switchResult.ok) {
        logTrace(tid, "DONE", {
          outcome: "session_update_chat_fail",
          error: switchResult.error?.message,
        });
        await platform.sendCard(
          chatId,
          "Error",
          `更新群描述失败,会话未切换:\n${switchResult.error?.message}`,
          "red",
        );
        return;
      }
      if (chatType !== "p2p") {
        console.log(
          `[${ts()}] [SESSION] Switched to session ${target.sessionId} (#${index + 1}), name="${newName2}"`,
        );
      }

      platform.setChatAvatar(chatId, target.tool, "new").catch(() => {});

      if (isSessionRunning(target.sessionId)) {
        const { ensureDisplayLoop } = await import("./session.ts");
        ensureDisplayLoop(target.sessionId);
      }

      const targetToolLabel = toolDisplayName(target.tool);
      const busyNote = isSessionRunning(target.sessionId)
        ? "\n\n⚠️ 该会话当前正在生成中，请等待完成后再发送消息。"
        : "";
      await platform.sendCard(
        chatId,
        `${targetToolLabel} Session Switched`,
        `已切换到 **${targetToolLabel}** 会话。\n\n` +
          `**序号:** ${index + 1}\n` +
          `**Session ID:** ${target.sessionId}\n` +
          `**工作目录:** \`${cwd2}\`\n\n` +
          `直接在这里发消息即可继续对话。${busyNote}`,
        "green",
      );

      logTrace(tid, "DONE", {
        outcome: "session_switch",
        sessionId: target.sessionId,
        index: index + 1,
        cwd: cwd2,
      });
      return;
    }

    // /git <args>：在「当前会话工作目录」执行 git 命令
    if (textLower.startsWith("/git ") || textLower === "/git") {
      const args = text === "/git" ? "" : text.slice(5).trim();
      logTrace(tid, "BRANCH", { cmd: "/git", args: args || "(none)" });
      if (!args) {
        logTrace(tid, "DONE", { outcome: "git_no_args" });
        await platform.sendCard(
          chatId,
          "/git",
          "用法：`/git <子命令> [参数]`，例如 `/git status`、`/git log --oneline -n 5`。",
          "yellow",
        );
        return;
      }

      const adapter = getAdapterForTool(descriptionTool);
      let cwd: string | undefined;
      try {
        const info = await adapter.getSessionInfo(sessionId);
        cwd = info?.cwd;
      } catch (err) {
        console.error(
          `[${ts()}] [GIT] getSessionInfo FAIL: ${(err as Error).message}`,
        );
      }
      if (!cwd) {
        logTrace(tid, "DONE", { outcome: "git_no_cwd", tool: descriptionTool });
        const isCursor = descriptionTool === "cursor";
        const hint = isCursor
          ? "无法获取当前 Cursor 会话的工作目录（缺少 sessionId→cwd 持久化映射）。请先在本群发送一条普通消息（让 adapter 从 cursor-agent 流中自动补回 cwd），然后再试 /git；若仍失败，可用 /new 重建会话。"
          : `无法获取当前会话的工作目录（${toolLabel} adapter 未返回 cwd）。请先与 AI 对话一次再试，或检查会话是否仍存在。`;
        await platform.sendCard(chatId, "/git", hint, "red");
        return;
      }

      console.log(
        `[${ts()}] [GIT] chat=${chatId} cwd=${cwd} cmd="git ${args}" timeoutMs=${GIT_TIMEOUT_MS}`,
      );
      const result = await runGitCommand(args, cwd, {
        timeoutMs: GIT_TIMEOUT_MS,
      });
      console.log(
        `[${ts()}] [GIT] exitCode=${result.exitCode}, durationMs=${result.durationMs}, truncated=${result.truncated}, timedOut=${result.timedOut}`,
      );
      const content = formatGitResult(args, cwd, result);
      const template = gitResultHeaderTemplate(result);
      await platform.sendCard(chatId, "/git 输出", content, template);
      logTrace(tid, "DONE", {
        outcome: "git_result",
        exitCode: result.exitCode,
        durationMs: result.durationMs,
      });
      return;
    }

    const lastTs = lastMsgTimestamps.get(chatId);
    if (lastTs !== undefined && msgTimestamp <= lastTs) {
      logTrace(tid, "DONE", {
        outcome: "skip_old_message_no_session",
        msgTimestamp,
        lastTimestamp: lastTs,
      });
      console.log(
        `[${ts()}] [SKIP] Older message (${msgTimestamp} <= ${lastTs}), no active session, ignoring`,
      );
      return;
    }

    // 并发检查：同一 session 只能有一个活跃 prompt
    if (isSessionRunning(sessionId)) {
      logTrace(tid, "BLOCKED", {
        outcome: "session_busy",
        sessionId,
      });
      console.log(
        `[${ts()}] [BLOCKED] Session ${sessionId} is already generating, rejecting message from chat ${chatId}`,
      );
      await platform.sendCard(
        chatId,
        "生成中",
        "该会话正在生成回复中，请等待完成后再发送新消息。",
        "yellow",
      );
      return;
    }

    try {
      logTrace(tid, "RESUME", { sessionId, tool: descriptionTool });
      await resumeAndPrompt(
        sessionId,
        text,
        platform,
        chatId,
        msgTimestamp,
        descriptionTool,
        tid,
      );
      logTrace(tid, "DONE", { outcome: "resume_done", sessionId });
      console.log(`[${ts()}] [RESUME] Session ${sessionId} done`);
    } catch (err) {
      logTrace(tid, "DONE", {
        outcome: "resume_fail",
        error: (err as Error).message,
      });
      console.error(`[${ts()}] [RESUME] FAIL: ${(err as Error).message}`);
      fileLog.flush();
      await platform.sendCard(
        chatId,
        "Error",
        `Failed to resume ${toolLabel} session:\n${(err as Error).message}`,
        "red",
      );
    }
    return;
  }

  // 无会话上下文 → help card
  logTrace(tid, "SEND", { method: "help_card", chatId });
  const card = buildHelpCard(text);
  const ok = await platform.sendRawCard(chatId, card);
  if (!ok) {
    console.error(`[${ts()}] [SEND] help_card FAIL: chatId=${chatId}`);
    logTrace(tid, "DONE", { outcome: "help_card_fail" });
  } else {
    console.log(`[${ts()}] [SEND] help_card OK: chatId=${chatId}`);
    logTrace(tid, "DONE", { outcome: "help_card_sent" });
  }
}
