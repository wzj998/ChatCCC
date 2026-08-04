/**
 * orchestrator.ts — 平台无关的消息命令处理
 *
 * Phase 1: 从 index.ts 抽出 handleCommand 及辅助函数。
 * 所有 IM 平台操作通过 PlatformAdapter 接口注入，不直接依赖 feishu-platform.ts。
 */

import { execSync, spawn, type ChildProcess } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";

import { makeTraceId, logTrace } from "./trace.ts";
import { appendStartupTrace } from "./shared.ts";
import {
  CLAUDE_EFFORT,
  CLAUDE_MODEL,
  CLAUDE_SUBAGENT_MODEL,
  CONFIG_FILE,
  GIT_TIMEOUT_MS,
  PROJECT_ROOT,
  anthropicConfigDisplay,
  config,
  fileLog,
  getAllEffortsForTool,
  getAllModelsForTool,
  getDefaultEffortForTool,
  getDefaultCwd,
  setDefaultCwd,
  getRecentDirs,
  addRecentDir,
  resolveDefaultAgentTool,
  sessionPrefixForTool,
  toolDisplayName,
  ts,
  type AgentTool,
} from "./config.ts";
import {
  buildHelpCard,
  buildEffortCard,
  buildFastModeCard,
  buildModelCard,
  buildStatusCard,
  buildCdContent,
  buildCdCard,
  buildSessionsCard,
  buildQueuedCard,
  buildQueueFullCard,
  buildCodexUsageCard,
} from "./cards.ts";
import {
  formatGitResult,
  gitResultHeaderTemplate,
  runGitCommand,
} from "./git-command.ts";
import {
  clearSessionModelOverride,
  clearSessionEffortOverride,
  getSessionStatus,
  getAllSessionsStatus,
  initClaudeSession,
  lastMsgTimestamps,
  resumeAndPrompt,
  sessionInfoMap,
  setSessionModelOverride,
  setSessionEffortOverride,
  switchChatBinding,
  recordSessionRegistry,
  getAdapterForTool,
  getEffectiveModelForTool,
  getEffectiveEffortForTool,
  getEffectiveFastModeForTool,
  setSessionFastModeOverride,
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
  enqueueMessage,
  cancelQueuedMessage,
} from "./session-chat-binding.ts";
import { getCodexUsageSummary, getTenantAccessToken, sendPostMessage } from "./feishu-platform.ts";
import { getCursorUsageSummary, type CursorUsageSummary } from "./cursor-usage.ts";
import { getChatGptSubscriptionStatus, type ChatGptSubscriptionResult } from "./chatgpt-subscription.ts";
import { applySharedPrefix } from "./shared-prefix.ts";
import { cwdDisplayName, sessionChatName } from "./session-name.ts";
import { reloadRuntimeConfig } from "./runtime-reload.ts";
import { acquireUpdateCommandGuard } from "./update-command-guard.ts";
import { createInternalRestartEnv } from "./startup-lifecycle.ts";
export { type PlatformAdapter } from "./platform-adapter.ts";
import type { ChatAvatarUsageHints, PlatformAdapter } from "./platform-adapter.ts";
import type { CodexUsageSummary } from "./feishu-api.ts";

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

/** 模型模糊匹配：精确匹配优先，否则找子串匹配（模型名越短越优先） */
function findModelMatch(input: string, models: string[]): string | null {
  if (models.length === 0) return null;
  const inputLower = input.toLowerCase();
  // 1) 精确匹配（忽略大小写）
  for (const m of models) {
    if (m.toLowerCase() === inputLower) return m;
  }
  // 2) 子串匹配：模型全名包含输入，按模型名长度升序（越短越优先）
  const candidates = models
    .filter(m => m.toLowerCase().includes(inputLower))
    .sort((a, b) => a.length - b.length);
  return candidates[0] ?? null;
}

function formatCodexUsageSummary(usage: CodexUsageSummary, chatGptSubscription: ChatGptSubscriptionResult | null = null): string {
  const progressBar = (usedPercent: number) => {
    const width = 20;
    const usedBlocks = Math.max(0, Math.min(width, Math.round((usedPercent / 100) * width)));
    return `[${"█".repeat(usedBlocks)}${"░".repeat(width - usedBlocks)}]`;
  };

  const formatDuration = (seconds: number | null) => {
    if (seconds === null) return "";
    if (seconds <= 0) return "（已到重置时间）";
    const totalMinutes = Math.max(1, Math.floor(seconds / 60));
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    const parts: string[] = [];
    if (days > 0) parts.push(`${days}天`);
    if (hours > 0) parts.push(`${hours}小时`);
    if (minutes > 0 || parts.length === 0) parts.push(`${minutes}分钟`);
    return `（约 ${parts.join("")}后）`;
  };

  const formatResetTime = (balance: NonNullable<CodexUsageSummary["fiveHour"]>) => {
    if (balance.resetAtEpochSeconds === null) return "暂无数据";
    const date = new Date(balance.resetAtEpochSeconds * 1000);
    const pad = (value: number) => String(value).padStart(2, "0");
    const absolute = [
      date.getFullYear(),
      "-",
      pad(date.getMonth() + 1),
      "-",
      pad(date.getDate()),
      " ",
      pad(date.getHours()),
      ":",
      pad(date.getMinutes()),
    ].join("");
    return `${absolute}${formatDuration(balance.resetAfterSeconds)}`;
  };

  const formatWindow = (label: string, balance: CodexUsageSummary["fiveHour"] | null) => {
    if (!balance) return `**${label}:** 暂无数据`;
    return [
      `**${label}:** 已用 ${balance.usedPercent}%，剩余 ${balance.remainingPercent}%，重置: ${formatResetTime(balance)}`,
      progressBar(balance.usedPercent),
    ].join("\n");
  };

  const formatResetCredits = () => {
    if (usage.rateLimitResetCreditsAvailable === null) return "**主动重置:** 暂无数据";
    const lines = [`**主动重置:** 剩余 ${usage.rateLimitResetCreditsAvailable} 次`];
    const credits = usage.rateLimitResetCredits ?? [];
    if (credits.length > 0) {
      const pad = (value: number) => String(value).padStart(2, "0");
      const formatExpiresAt = (value: string) => {
        const date = new Date(value);
        if (!Number.isFinite(date.getTime())) return value;
        return [
          date.getFullYear(),
          "-",
          pad(date.getMonth() + 1),
          "-",
          pad(date.getDate()),
          " ",
          pad(date.getHours()),
          ":",
          pad(date.getMinutes()),
          ":",
          pad(date.getSeconds()),
        ].join("");
      };
      lines.push("**过期时间:**");
      for (const credit of credits) {
        lines.push(`- ${formatExpiresAt(credit.expiresAt)}`);
      }
    }
    return lines.join("\n");
  };

  const formatSubscriptionFailureReason = (result: ChatGptSubscriptionResult) => {
    const port = result.chromeCdp.port;
    switch (result.code) {
      case "chrome_cdp_unreachable":
        return `Chrome CDP 端口 ${port} 不可访问。请确认常驻 Chrome 已启动，或重启 ChatCCC。`;
      case "chrome_cdp_occupied":
        return `${port} 端口可访问，但不是健康的 Chrome CDP。请释放该端口或修改 chromeDevtools.port。`;
      case "chatgpt_page_missing":
        return `没有可用的 ChatGPT 页面。请在 ${port} 端口对应的 Chrome 浏览器中打开 https://chatgpt.com/ 并登录。`;
      case "chatgpt_session_missing":
        return `请在 ${port} 端口对应的 Chrome 浏览器中登录 ChatGPT。`;
      case "chatgpt_subscription_failed":
        return "ChatGPT 订阅接口探测失败。可能是页面未加载完成、ChatGPT 接口变更或网络异常。";
      case "chrome_cdp_disabled":
        return "";
      case "ok":
        return "";
    }
  };

  const formatChatGptSubscriptionFailure = () => {
    if (!chatGptSubscription || chatGptSubscription.ok || !chatGptSubscription.chromeCdp.enabled) return "";
    const lines = [
      "**ChatGPT 订阅查询失败:**",
      `- 原因: ${formatSubscriptionFailureReason(chatGptSubscription) || "暂无数据"}`,
    ];
    const detail = chatGptSubscription.reason?.replace(/\s+/g, " ").trim();
    if (detail) {
      lines.push(`- 详情: ${detail.length > 240 ? `${detail.slice(0, 240)}...` : detail}`);
    }
    return lines.join("\n");
  };

  const formatChatGptSubscription = () => {
    if (!chatGptSubscription?.ok || !chatGptSubscription.subscription) return "";
    const subscription = chatGptSubscription.subscription;
    const pad = (value: number) => String(value).padStart(2, "0");
    const formatExpiresAt = (value: string | null) => {
      if (!value) return "暂无数据";
      const date = new Date(value);
      if (!Number.isFinite(date.getTime())) return value;
      return [
        date.getFullYear(),
        "-",
        pad(date.getMonth() + 1),
        "-",
        pad(date.getDate()),
        " ",
        pad(date.getHours()),
        ":",
        pad(date.getMinutes()),
      ].join("");
    };
    const remaining = typeof subscription.remainingDays === "number"
      ? `（剩余 ${subscription.remainingDays} 天）`
      : "";
    return [
      "**ChatGPT 订阅:**",
      `- 套餐: ${subscription.plan ?? "暂无数据"}`,
      `- 到期: ${formatExpiresAt(subscription.expiresAt)}${remaining}`,
      `- 自动续费: ${subscription.willRenew === null ? "暂无数据" : subscription.willRenew ? "是" : "否"}`,
    ].join("\n");
  };

  return [
    "Codex 用量：",
    "",
    formatChatGptSubscription(),
    formatChatGptSubscriptionFailure(),
    formatResetCredits(),
    "",
    usage.fiveHour ? formatWindow("5h", usage.fiveHour) : "",
    usage.weekly ? formatWindow("7天", usage.weekly) : "",
  ].filter((line, index, arr) => line !== "" || (index > 0 && arr[index - 1] !== "")).join("\n");
}

function formatCursorUsageSummary(usage: CursorUsageSummary): string {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "shortOffset",
  });
  const formatDate = (value: string | undefined) => {
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp)) return "暂无数据";
    return dateFormatter.format(new Date(timestamp));
  };
  const formatMoney = (value: number | undefined) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return "暂无数据";
    return `$${(value / 100).toFixed(2)}`;
  };
  const formatPercent = (value: number | undefined) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return "暂无数据";
    return `${value}%`;
  };
  const plan = usage.planUsage;
  const spendLimit = usage.spendLimitUsage;

  return [
    "Cursor 用量：",
    "",
    `**计费周期:** ${formatDate(usage.billingCycleStart)} - ${formatDate(usage.billingCycleEnd)}`,
    "",
    "**Included usage:**",
    `- Total: ${formatMoney(plan?.totalSpend)} / ${formatMoney(plan?.limit)} (${formatPercent(plan?.totalPercentUsed)})`,
    `- Included: ${formatMoney(plan?.includedSpend)}`,
    `- Bonus: ${formatMoney(plan?.bonusSpend)}`,
    `- Auto: ${formatPercent(plan?.autoPercentUsed)}`,
    `- API: ${formatPercent(plan?.apiPercentUsed)}`,
    "",
    "**On-Demand / Spend limit:**",
    `- Individual used: ${formatMoney(spendLimit?.individualUsed)}`,
    `- Pool used: ${formatMoney(spendLimit?.pooledUsed)} / ${formatMoney(spendLimit?.pooledLimit)}`,
    `- Pool remaining: ${formatMoney(spendLimit?.pooledRemaining)}`,
    `- Limit type: ${spendLimit?.limitType ?? "暂无数据"}`,
    `- Display threshold: ${formatMoney(usage.displayThreshold)}`,
    "",
    `**Enabled:** ${usage.enabled === undefined ? "暂无数据" : String(usage.enabled)}`,
    usage.displayMessage ? `**Message:** ${usage.displayMessage}` : "",
    usage.autoModelSelectedDisplayMessage ? `**Auto model:** ${usage.autoModelSelectedDisplayMessage}` : "",
    usage.namedModelSelectedDisplayMessage ? `**Named model:** ${usage.namedModelSelectedDisplayMessage}` : "",
    usage.autoBucketModels?.length ? `**Auto bucket models:** ${usage.autoBucketModels.join(", ")}` : "",
  ].filter(Boolean).join("\n");
}

function usageHelpLine(tool: string): string {
  if (tool === "codex") return "\n发送 **/usage** 查看 Codex 实际存在的 5h/7天用量窗口，以及查询/使用主动重置卡。";
  if (tool === "cursor") return "\n发送 **/usage** 查看 Cursor 用量。";
  return "";
}

function fastHelpAfterModel(tool: string): string {
  return tool === "codex"
    ? "\n发送 **/fast** 查看或切换当前会话的 Fast 模式。"
    : "";
}

function setChatAvatarForSession(
  platform: PlatformAdapter,
  chatId: string,
  tool: string,
  status: string,
  sessionId?: string,
  usageHints?: ChatAvatarUsageHints,
): Promise<void> {
  const fastMode = getEffectiveFastModeForTool(tool, sessionId);
  if (!usageHints && !fastMode) return platform.setChatAvatar(chatId, tool, status);
  return platform.setChatAvatar(chatId, tool, status, {
    ...usageHints,
    ...(fastMode ? { fastMode: true } : {}),
  });
}

async function sendFastModeStatus(
  platform: PlatformAdapter,
  chatId: string,
  enabled: boolean,
): Promise<void> {
  if (platform.kind === "wechat") {
    const mode = enabled ? "ON (Fast)" : "OFF (Standard)";
    await platform.sendText(
      chatId,
      `Codex Fast 模式: ${mode}\n输入 /fast on 或 /fast off 切换。切换将在下一条消息生效，当前生成不中断。`,
    );
    return;
  }
  await platform.sendRawCard(chatId, buildFastModeCard(enabled));
}

async function resolveUsageTarget(chatId: string): Promise<{ tool: "codex" | "cursor" | "ccc"; sessionId?: string }> {
  try {
    const registry = await loadSessionRegistryForBinding();
    const record = registry[chatId];
    const tool = record?.tool;
    if (tool === "cursor") return { tool: "cursor", sessionId: record?.sessionId };
    if (tool === "ccc") return { tool: "ccc", sessionId: record?.sessionId };
    return { tool: "codex", sessionId: record?.sessionId };
  } catch {
    return { tool: "codex" };
  }
}

function isOfficialDeepSeek(baseURL: string): boolean {
  try {
    return new URL(baseURL).host === "api.deepseek.com";
  } catch {
    return false;
  }
}

interface DeepSeekBalance {
  is_available: boolean;
  balance_infos?: Array<{
    currency: string;
    total_balance: string;
    topped_up_balance: string;
    granted_balance: string;
  }>;
}

async function fetchDeepSeekBalance(apiKey: string, baseURL: string): Promise<DeepSeekBalance> {
  const apiOrigin = new URL(baseURL).origin;
  const resp = await fetch(`${apiOrigin}/user/balance`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!resp.ok) {
    throw new Error(`DeepSeek 余额查询失败: HTTP ${resp.status}`);
  }
  return (await resp.json()) as DeepSeekBalance;
}

function formatDeepSeekBalance(balance: DeepSeekBalance): string {
  if (!balance.is_available) return "**DeepSeek 余额:** 暂无数据";
  const infos = balance.balance_infos ?? [];
  if (infos.length === 0) return "**DeepSeek 余额:** 暂无数据";
  const lines = infos.map((info) => {
    const parts = [`**${info.currency}:**`];
    parts.push(`- 总余额: ${info.total_balance}`);
    if (info.topped_up_balance) parts.push(`- 充值余额: ${info.topped_up_balance}`);
    if (info.granted_balance) parts.push(`- 赠送余额: ${info.granted_balance}`);
    return parts.join("\n");
  });
  return `**DeepSeek 余额:**\n${lines.join("\n")}`;
}

function refreshUsageAvatar(
  platform: PlatformAdapter,
  chatId: string,
  tool: "codex" | "cursor",
  status: "busy" | "idle",
  usageHints: ChatAvatarUsageHints,
  sessionId?: string,
): void {
  setChatAvatarForSession(platform, chatId, tool, status, sessionId, usageHints).catch((err) => {
    console.warn(`[${ts()}] [AVATAR] usage refresh failed: chatId=${chatId} tool=${tool} ${(err as Error).message}`);
  });
}

async function sendUsageSummary(
  platform: PlatformAdapter,
  chatId: string,
  tool: "codex" | "cursor" | "ccc",
  avatarStatus: "busy" | "idle" = "idle",
  sessionId?: string,
): Promise<void> {
  if (tool === "ccc") {
    const baseURL = config.ccc.DEEPSEEK_BASE_URL;
    if (!isOfficialDeepSeek(baseURL)) {
      const msg = "CCC 用量查询仅支持官方 DeepSeek API (api.deepseek.com)，当前使用的非官方接口不支持余额查询。";
      if (platform.kind === "wechat") {
        await platform.sendText(chatId, msg).catch(() => {});
      } else {
        await platform.sendCard(chatId, "CCC Usage", msg, "blue");
      }
      return;
    }
    const balance = await fetchDeepSeekBalance(config.ccc.DEEPSEEK_API_KEY, baseURL);
    const content = formatDeepSeekBalance(balance);
    if (platform.kind === "wechat") {
      await platform.sendText(chatId, content).catch(() => {});
    } else {
      await platform.sendCard(chatId, "CCC Usage", content, "blue");
    }
    return;
  }

  if (tool === "cursor") {
    const usage = await getCursorUsageSummary();
    const content = formatCursorUsageSummary(usage);
    if (platform.kind === "wechat") {
      await platform.sendText(chatId, content).catch(() => {});
    } else {
      await platform.sendCard(chatId, "Cursor Usage", content, "blue");
    }
    refreshUsageAvatar(platform, chatId, tool, avatarStatus, { cursorUsage: usage }, sessionId);
    return;
  }

  const [usage, chatGptSubscription] = await Promise.all([
    getCodexUsageSummary(),
    getChatGptSubscriptionStatus().catch(() => null),
  ]);
  const content = formatCodexUsageSummary(usage, chatGptSubscription);
  if (platform.kind === "wechat") {
    await platform.sendText(chatId, content).catch(() => {});
  } else if (platform.kind === "feishu") {
    await platform.sendRawCard(chatId, buildCodexUsageCard(content, usage.rateLimitResetCreditsAvailable));
  } else {
    await platform.sendCard(chatId, "Codex Usage", content, "blue");
  }
  refreshUsageAvatar(platform, chatId, tool, avatarStatus, { codexUsage: usage }, sessionId);
}

async function sendUsageError(platform: PlatformAdapter, chatId: string, tool: "codex" | "cursor" | "ccc", err: unknown): Promise<void> {
  const toolLabel = tool === "cursor" ? "Cursor" : tool === "ccc" ? "CCC" : "Codex";
  const message = `${toolLabel} 用量获取失败：${(err as Error).message}`;
  if (platform.kind === "wechat") {
    await platform.sendText(chatId, message).catch(() => {});
  } else {
    await platform.sendCard(chatId, `${toolLabel} Usage`, message, "red");
  }
}

function isUntitledSessionChatName(name: string): boolean {
  return name === "新会话" || name.startsWith("新会话-");
}

function shouldSendWechatProcessingAck(
  platform: PlatformAdapter,
  isCommandText: boolean,
  chatType: string,
): boolean {
  return platform.kind === "wechat" && chatType === "p2p" && !isCommandText;
}

/** 飞书私聊是专属会话容器；显式 /new 才创建独立群聊。 */
function isFeishuP2p(platform: PlatformAdapter, chatType: string): boolean {
  return chatType === "p2p" && platform.kind === "feishu";
}

async function sendStateCard(
  platform: PlatformAdapter,
  chatId: string,
  sessionId: string | null,
  toolLabel: string,
  traceId: string,
): Promise<void> {
  const status = sessionId ? await getSessionStatus(chatId) : null;
  const isActive = sessionId ? isSessionRunning(sessionId) : false;
  const stateLabel = sessionId
    ? (isActive ? "🟢 运行中" : "⚪ 空闲")
    : "⚪ 未建立会话";
  const statusText = [
    `**群名:** ${status?.chatName || "—"}`,
    `**Session ID:** ${sessionId ? `\`${status?.sessionId ?? sessionId}\`` : "—"}`,
    `**工具:** ${toolLabel}`,
    `**状态:** ${stateLabel}`,
    `**已对话轮数:** ${status?.turnCount ?? 0}`,
    `**模型:** ${sessionId ? (status?.model ?? anthropicConfigDisplay(CLAUDE_MODEL)) : "—"}`,
  ];
  if (status?.effort != null) {
    statusText.push(`**Effort:** ${status.effort}`);
  }
  if (isActive && status) {
    const elapsed = Math.floor((Date.now() - status.startTime) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    statusText.push(`**本轮已运行:** ${mins}分${secs}秒`);
    statusText.push(`**已产出总字符:** ${status.accumulatedLength.toLocaleString()}`);
  }
  if (status?.lastContextTokens) {
    statusText.push(`**上下文 Token 数:** ~${status.lastContextTokens.toLocaleString()}`);
  }
  const card = buildStatusCard(statusText.join("\n"), isActive ? "blue" : "green");
  const ok = await platform.sendRawCard(chatId, card);
  console.log(`[${ts()}] [STATUS] card sent, ok=${ok}`);
  logTrace(traceId, "DONE", {
    outcome: sessionId ? "status" : "status_no_session",
    ok,
  });
}

interface FeishuP2pRegistryRecord {
  sessionId: string;
  tool: string;
  chatType?: string;
  chatName?: string;
}

type FeishuP2pAgentResolution =
  | { kind: "ready"; sessionId: string; tool: string }
  | { kind: "waiting"; sessionId: string; tool: string; desiredTool: AgentTool }
  | { kind: "error"; previousTool: string; desiredTool: AgentTool; error: Error };

// 同一个飞书私聊可能短时间收到多条消息。切换期间共享同一个 Promise，避免
// 为同一次默认 Agent 变化创建多个空会话。
const feishuP2pAgentSwitches = new Map<string, Promise<FeishuP2pAgentResolution>>();

async function resolveFeishuP2pAgent(
  platform: PlatformAdapter,
  chatId: string,
  text: string,
  record: FeishuP2pRegistryRecord,
  traceId: string,
): Promise<FeishuP2pAgentResolution> {
  const desiredTool = resolveDefaultAgentTool();
  if (record.tool === desiredTool) {
    return { kind: "ready", sessionId: record.sessionId, tool: record.tool };
  }

  if (isSessionRunning(record.sessionId)) {
    return {
      kind: "waiting",
      sessionId: record.sessionId,
      tool: record.tool,
      desiredTool,
    };
  }

  const existingSwitch = feishuP2pAgentSwitches.get(chatId);
  if (existingSwitch) return existingSwitch;

  const switchOperation = (async (): Promise<FeishuP2pAgentResolution> => {
    try {
      // 异步创建开始前重新读取一次，防止另一个请求刚完成了绑定切换。
      const latestRecord = (await loadSessionRegistryForBinding())[chatId];
      if (!latestRecord?.sessionId || !latestRecord.tool || latestRecord.chatType !== "p2p") {
        return {
          kind: "error",
          previousTool: record.tool,
          desiredTool,
          error: new Error("飞书私聊绑定在切换前已发生变化"),
        };
      }
      if (latestRecord.tool === desiredTool) {
        return { kind: "ready", sessionId: latestRecord.sessionId, tool: latestRecord.tool };
      }
      if (isSessionRunning(latestRecord.sessionId)) {
        return {
          kind: "waiting",
          sessionId: latestRecord.sessionId,
          tool: latestRecord.tool,
          desiredTool,
        };
      }

      const cwd = homedir();
      const init = await initClaudeSession(desiredTool, cwd);
      const chatName = sessionChatName(text.slice(0, 10) || "私聊会话", cwd);
      const switchResult = await switchChatBinding({
        chatId,
        chatType: "p2p",
        oldSessionId: latestRecord.sessionId,
        newSessionId: init.sessionId,
        tool: desiredTool,
        chatName,
        newDescription: `${sessionPrefixForTool(desiredTool)} ${init.sessionId}`,
        updateChatInfoFn: (id, name, desc) => platform.updateChatInfo(id, name, desc),
      });
      if (!switchResult.ok) {
        return {
          kind: "error",
          previousTool: latestRecord.tool,
          desiredTool,
          error: switchResult.error ?? new Error("更新飞书私聊绑定失败"),
        };
      }

      const previousLabel = toolDisplayName(latestRecord.tool);
      const desiredLabel = toolDisplayName(desiredTool);
      logTrace(traceId, "BRANCH", {
        reason: "switch_feishu_p2p_default_agent",
        chatId,
        oldSessionId: latestRecord.sessionId,
        newSessionId: init.sessionId,
        oldTool: latestRecord.tool,
        newTool: desiredTool,
      });
      await platform.sendCard(
        chatId,
        "默认 Agent 已切换",
        `检测到默认 Agent 已变化：**${previousLabel} → ${desiredLabel}**。\n\n已创建新的空白 ${desiredLabel} 私聊会话，并从本条消息开始使用。`,
        "green",
      ).catch(() => {});
      setChatAvatarForSession(platform, chatId, desiredTool, "new", init.sessionId).catch(() => {});
      return { kind: "ready", sessionId: init.sessionId, tool: desiredTool };
    } catch (err) {
      return {
        kind: "error",
        previousTool: record.tool,
        desiredTool,
        error: err as Error,
      };
    }
  })();

  feishuP2pAgentSwitches.set(chatId, switchOperation);
  try {
    return await switchOperation;
  } finally {
    if (feishuP2pAgentSwitches.get(chatId) === switchOperation) {
      feishuP2pAgentSwitches.delete(chatId);
    }
  }
}

/** 检测当前进程是否从 npm 全局安装启动 */
function isRunningFromGlobalNpm(): boolean {
  try {
    const globalRoot = execSync("npm root -g", { encoding: "utf8", timeout: 5000, windowsHide: true }).trim();
    return resolve(PROJECT_ROOT).startsWith(resolve(globalRoot));
  } catch {
    return false;
  }
}

const UPDATE_LOG = join(homedir(), ".chatccc", "logs", "update-watcher.log");

function updLog(msg: string): void {
  const ts = new Date().toISOString();
  try { appendFileSync(UPDATE_LOG, `${ts} [UPDATE-SYNC] ${msg}\n`, "utf-8"); } catch {}
}

/** 同步更新 npm 全局包并 spawn 新进程重启。不依赖 systemd 或任何服务管理器。 */
function syncUpdateAndRestart(): ChildProcess | undefined {
  updLog(`sync update start, pid=${process.pid}`);
  appendStartupTrace("update: sync update start", { pid: process.pid });

  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

  // 1. npm update
  updLog(`running: ${npmCmd} update -g chatccc`);
  appendStartupTrace("update: npm update begin", { npmCmd });
  const t0 = Date.now();
  try {
    const out = execSync(`${npmCmd} update -g chatccc 2>&1`, { encoding: "utf8", timeout: 120000, windowsHide: true });
    const elapsed = Date.now() - t0;
    updLog(`npm update OK (${elapsed}ms): ${out.slice(0, 500)}`);
    appendStartupTrace("update: npm update OK", { elapsedMs: elapsed, outputLen: out.length });
  } catch (e) {
    const elapsed = Date.now() - t0;
    const err = e as Error & { stderr?: string; stdout?: string; status?: number };
    updLog(`npm update failed (${elapsed}ms): message=${err.message}, stderr=${(err.stderr || "").slice(0, 500)}, stdout=${(err.stdout || "").slice(0, 200)}`);
    appendStartupTrace("update: npm update failed", { elapsedMs: elapsed, message: err.message, stderrLen: (err.stderr || "").length });

    // fallback
    updLog(`fallback: ${npmCmd} install -g chatccc@latest`);
    appendStartupTrace("update: npm install fallback begin", { npmCmd });
    const t1 = Date.now();
    try {
      const out2 = execSync(`${npmCmd} install -g chatccc@latest 2>&1`, { encoding: "utf8", timeout: 120000, windowsHide: true });
      const elapsed2 = Date.now() - t1;
      updLog(`npm install fallback OK (${elapsed2}ms): ${out2.slice(0, 500)}`);
      appendStartupTrace("update: npm install fallback OK", { elapsedMs: elapsed2, outputLen: out2.length });
    } catch (e2) {
      const elapsed2 = Date.now() - t1;
      const err2 = e2 as Error & { stderr?: string; stdout?: string };
      updLog(`npm install fallback also failed (${elapsed2}ms): message=${err2.message}, stderr=${(err2.stderr || "").slice(0, 500)}`);
      appendStartupTrace("update: npm install fallback failed", { elapsedMs: elapsed2, message: err2.message });
    }
  }

  // 2. resolve bin path
  const npmPrefix = process.env.NPM_PREFIX || "";
  const binName = process.platform === "win32" ? "chatccc.cmd" : "chatccc";
  const binPath = npmPrefix ? join(npmPrefix, binName) : "chatccc";
  updLog(`bin path: npmPrefix=${npmPrefix || "(empty)"}, binPath=${binPath}`);
  appendStartupTrace("update: spawn begin", { npmPrefix: npmPrefix || "(empty)", binPath });

  // 3. spawn new chatccc：优先 node + 全局包入口绝对路径（不依赖 PATH/shell），
  //    避免继承环境 PATH 异常时秒退；失败时回退到 binPath（走 shell）。
  try {
    let spawnSpec: { command: string; args: string[] } | null = null;
    if (npmPrefix) {
      const entry = join(npmPrefix, "node_modules", "chatccc", "bin", "chatccc.mjs");
      if (existsSync(entry)) {
        spawnSpec = { command: process.execPath, args: [entry] };
      }
    }
    const child = spawnSpec
      ? spawn(spawnSpec.command, spawnSpec.args, {
          detached: true,
          stdio: "ignore",
          shell: false,
          env: createInternalRestartEnv(),
        })
      : spawn(binPath, [], {
          detached: true,
          stdio: "ignore",
          shell: true,
          env: createInternalRestartEnv(),
        });
    child.unref();
    const spawnedAs = spawnSpec ? `${spawnSpec.command} ${spawnSpec.args.join(" ")}` : binPath;
    updLog(`spawn new chatccc OK, childPid=${child.pid}, bin=${spawnedAs}`);
    appendStartupTrace("update: spawn OK", {
      childPid: child.pid,
      binPath: spawnSpec ? spawnSpec.args[0] : binPath,
    });
    return child;
  } catch (e) {
    const errMsg = (e as Error).message;
    updLog(`spawn new chatccc failed: ${errMsg}`);
    appendStartupTrace("update: spawn failed", { error: errMsg });
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// /restart — 自重启子进程（不经过 npx/npm，避免 PATH 注入秒退；防空窗兜底）
// ---------------------------------------------------------------------------

/** 父进程等待子进程稳定启动的时间窗口（毫秒）。 */
export const RESTART_CHILD_READY_MS = 3000;

/**
 * 构建自重启的 spawn 参数：直接使用 node 可执行文件 + 本地 tsx CLI 绝对路径，
 * 不经过 npx/npm。原实现 spawn("npx", ["tsx", "src/index.ts"], { shell: true })
 * 在继承环境 PATH 异常（npm 子进程找不到 node/tsx）时会秒退，且错误被
 * stdio:"ignore" 吞掉，导致 restart 静默失败、服务空窗。
 */
export function buildRestartSpawnSpec(
  projectRoot: string = PROJECT_ROOT,
): { command: string; args: string[] } {
  const tsxCli = join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
  return { command: process.execPath, args: [tsxCli, "src/index.ts"] };
}

export interface RestartSpawnDeps {
  projectRoot?: string;
  spawnImpl?: typeof spawn;
  trace?: typeof appendStartupTrace;
}

/**
 * spawn 自重启子进程。stdio 第三位用 pipe 收集 stderr（原 "ignore" 会吞掉
 * 所有错误，导致失败原因不可见），退出时把收集到的 stderr 写入 startup-trace。
 */
export function spawnRestartChild(deps: RestartSpawnDeps = {}): ChildProcess {
  const projectRoot = deps.projectRoot ?? PROJECT_ROOT;
  const spawnImpl = deps.spawnImpl ?? spawn;
  const trace = deps.trace ?? appendStartupTrace;
  const { command, args } = buildRestartSpawnSpec(projectRoot);
  const child = spawnImpl(command, args, {
    cwd: projectRoot,
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
    shell: false,
    env: createInternalRestartEnv(),
  });
  let stderrBuf = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderrBuf.length < 4096) {
      stderrBuf += chunk.toString("utf8");
    }
  });
  child.on("error", (err) => {
    trace("restart: spawn error", { error: err.message, stderr: stderrBuf.slice(0, 2000) });
  });
  child.on("exit", (code, signal) => {
    trace("restart: child exit", {
      childPid: child.pid,
      code,
      signal,
      stderr: stderrBuf.slice(0, 2000),
    });
  });
  return child;
}

/**
 * 决定父进程是否应退出（防空窗兜底）：
 * - 窗口内子进程已退出（死亡或信号终止）→ 返回 false，父进程留下继续服务；
 * - 子进程存活满整个窗口 → 返回 true，父进程退出并把端口让给新进程。
 */
export async function decideRestartParentExit(
  child: Pick<ChildProcess, "pid" | "exitCode" | "signalCode">,
  timeoutMs: number,
  pollMs = 500,
  trace: typeof appendStartupTrace = appendStartupTrace,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      trace("restart: child died during window, keeping parent", {
        childPid: child.pid,
        exitCode: child.exitCode,
        signalCode: child.signalCode,
      });
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  trace("restart: child alive after window, parent exiting", { childPid: child.pid });
  return true;
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
  commandId?: string,
): Promise<void> {
  const tid = traceId ?? makeTraceId();
  const sharedPrefix = applySharedPrefix(text);
  const promptText = sharedPrefix.text;
  text = sharedPrefix.body;
  const textLower = text.toLowerCase();
  const isCommandText = !sharedPrefix.matched && textLower.startsWith("/");
  recordChatPlatform(chatId, platform);

  if (isCommandText && textLower === "/reload") {
    logTrace(tid, "BRANCH", { cmd: "/reload" });
    try {
      const result = await reloadRuntimeConfig("chat-command");
      await platform.sendText(
        chatId,
        [
          "配置已重新加载。",
          `默认 Agent: ${toolDisplayName(result.defaultAgent)}`,
          `配置文件: ${result.configPath}`,
          "后续新会话会使用最新配置；飞书私聊会在下一条普通消息时跟随默认 Agent，正在生成的会话不会被中断。",
        ].join("\n"),
      ).catch(() => {});
      logTrace(tid, "DONE", { outcome: "reload", defaultAgent: result.defaultAgent });
    } catch (err) {
      await platform.sendText(chatId, `配置重载失败：${(err as Error).message}`).catch(() => {});
      logTrace(tid, "DONE", { outcome: "reload_fail", error: (err as Error).message });
    }
    return;
  }

  if (isCommandText && textLower === "/restart") {
    logTrace(tid, "BRANCH", { cmd: "/restart" });
    await platform.sendText(chatId, "重启中...请几秒后发消息唤醒我").catch(() => {});
    logTrace(tid, "DONE", { outcome: "restart" });

    appendStartupTrace("restart: spawn begin", { fromPid: process.pid });
    const child = spawnRestartChild();
    child.unref();

    // 子进程存活满窗口才退出父进程；若子进程在窗口内死亡，父进程留下继续
    // 服务（防空窗），并已把子进程 stderr 写入 startup-trace 供排查。
    void decideRestartParentExit(child, RESTART_CHILD_READY_MS).then((shouldExit) => {
      if (!shouldExit) return;
      appendStartupTrace("restart: parent exit", { childPid: child.pid });
      process.exit(0);
    });
    return;
  }

  if (isCommandText && textLower === "/update") {
    logTrace(tid, "BRANCH", { cmd: "/update" });
    const isGlobal = isRunningFromGlobalNpm();
    appendStartupTrace("update: command received", { isGlobal, chatId });
    if (!isGlobal) {
      await platform.sendText(chatId, "当前进程非 npm 全局安装，无法使用 /update 更新。请通过 npm install -g chatccc 安装后使用。").catch(() => {});
      logTrace(tid, "DONE", { outcome: "update_not_global" });
      return;
    }

    // `/update` 会主动重启进程，内存 processedMessages 随之丢失。必须在发送
    // “正在更新”以及执行 npm 命令之前同步落盘，才能挡住新进程收到的飞书重投。
    // 该护栏只位于此分支，不改变普通消息和 `/restart` 的现有去重行为。
    const updateGuard = acquireUpdateCommandGuard({ commandId });
    appendStartupTrace("update: command guard checked", {
      allowed: updateGuard.allowed,
      reason: updateGuard.reason,
      hasCommandId: Boolean(commandId),
    });
    if (!updateGuard.allowed) {
      if (updateGuard.reason === "duplicate_id") {
        // 同一条飞书消息的重投静默丢弃，避免用户再次看到重复提示。
        logTrace(tid, "DONE", { outcome: "update_duplicate_id" });
        return;
      }
      await platform.sendText(
        chatId,
        "无法写入更新保护状态。为避免连续更新和重启，本次 /update 未执行。",
      ).catch(() => {});
      logTrace(tid, "DONE", { outcome: "update_guard_write_failed" });
      return;
    }

    await platform.sendText(chatId, "正在更新并重启，请稍候...").catch(() => {});
    logTrace(tid, "DONE", { outcome: "update" });
    appendStartupTrace("update: sync update begin", { fromPid: process.pid });
    const child = syncUpdateAndRestart();
    if (child) {
      // 子进程存活满窗口才退出父进程；若子进程在窗口内死亡，父进程留下继续
      // 服务（防空窗）。
      void decideRestartParentExit(child, RESTART_CHILD_READY_MS).then((shouldExit) => {
        if (!shouldExit) return;
        appendStartupTrace("update: parent exit", { childPid: child.pid });
        process.exit(0);
      });
    } else {
      // spawn 失败：没有子进程可等，给残留日志写入时间后退出
      setTimeout(() => process.exit(0), 2000);
    }
    return;
  }

  if (isCommandText && textLower === "/usage") {
    const usageTarget = await resolveUsageTarget(chatId);
    const usageTool = usageTarget.tool;
    const avatarStatus = usageTarget.sessionId && isSessionRunning(usageTarget.sessionId) ? "busy" : "idle";
    logTrace(tid, "BRANCH", { cmd: "/usage", tool: usageTool });
    try {
      await sendUsageSummary(platform, chatId, usageTool, avatarStatus, usageTarget.sessionId);
      logTrace(tid, "DONE", { outcome: "usage", tool: usageTool });
    } catch (err) {
      await sendUsageError(platform, chatId, usageTool, err);
      logTrace(tid, "DONE", { outcome: "usage_fail", tool: usageTool, error: (err as Error).message });
    }
    return;
  }

  if (isCommandText && (textLower === "/cd" || textLower.startsWith("/cd "))) {
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
        const adapter = getAdapterForTool(sessionInfoResult.tool, sessionInfoResult.sessionId);
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

      // 微信模式下，若用户没有活跃会话，自动创建新会话
      if (platform.kind === "wechat" && !sessionInfoMap.has(chatId)) {
        logTrace(tid, "BRANCH", { cmd: "/new", trigger: "auto_after_cd" });
        await handleCommand(platform, "/new", chatId, openId, msgTimestamp, chatType, traceId);
      }
    }
    return;
  }

  if (isCommandText && (textLower === "/new" || textLower.startsWith("/new "))) {
    const toolArg = text.slice(5).trim().toLowerCase();
    const tool = toolArg || resolveDefaultAgentTool();
    logTrace(tid, "BRANCH", { cmd: "/new", tool });
    const validTools = ["claude", "cursor", "codex", "ccc"];
    if (!validTools.includes(tool)) {
      logTrace(tid, "DONE", { outcome: "new_invalid_tool", tool });
      await platform.sendCard(
        chatId,
        "Error",
        `未知的工具类型: "${toolArg}"。支持: claude (Claude Code), cursor (Cursor), codex (Codex), ccc (CCC Agent)。`,
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

    // /new 的平台语义保持不同：微信在当前私聊新建 session；飞书显式
    // /new 始终创建独立群聊。飞书私聊自己的常驻 session 不在这里切换。
    if (chatType === "p2p" && platform.kind === "wechat") {
      // 先解绑旧 session（如果存在），避免旧 session 的 display loop
      // 继续往同一个 chat 推送内容（/newh 走 switchChatBinding 已有此逻辑，
      // 但 /new p2p 之前遗漏了解绑）。
      const oldRegistry = await loadSessionRegistryForBinding();
      const oldRecord = oldRegistry[chatId];
      if (oldRecord?.sessionId && oldRecord.sessionId !== sessionId) {
        unbindChatFromSession(oldRecord.sessionId, chatId);
        displayCards.delete(chatId);
        cancelQueuedMessage(oldRecord.sessionId);
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
        chatType,
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
          `发送 **/model** 查看或切换当前会话的模型。${fastHelpAfterModel(tool)}\n` +
          `发送 **/new** 创建新会话，**/newh** 重置当前会话（沿用工作目录）。\n` +
          `发送 **/sessions** 查看所有会话状态。\n` +
          `发送 \`/git <子命令>\` 在本会话工作目录执行 git，例如 \`/git status\`、\`/git log --oneline -n 5\`。` +
          usageHelpLine(tool),
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
      chatType: "group",
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
        `发送 **/model** 查看或切换当前会话的模型。${fastHelpAfterModel(tool)}\n` +
        `发送 **/new** 创建新会话，**/newh** 重置当前会话（沿用工作目录）。\n` +
        `发送 **/sessions** 查看所有会话状态。\n` +
        `发送 \`/git <子命令>\` 在本会话工作目录执行 git，例如 \`/git status\`、\`/git log --oneline -n 5\`。` +
        usageHelpLine(tool),
      "green",
    );

    console.log(`[${ts()}] [STEP 4/4] Replied to new group → OK`);
    logTrace(tid, "DONE", {
      outcome: "session_ready",
      newChatId,
      sessionId,
      tool,
    });
    setChatAvatarForSession(platform, newChatId, tool, "new", sessionId).catch(() => {});
    console.log(`${"=".repeat(60)}`);
    return;
  }

  // 检测会话上下文：群聊从 description 获取，飞书/微信私聊都从
  // session-registry 获取。私聊 chatId 是稳定容器，进程重启后仍恢复绑定。
  let sessionId: string | null = null;
  let descriptionTool: string | null = null;
  let toolLabel: string | null = null;
  let pendingFeishuP2pDefaultTool: AgentTool | null = null;
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

        // 群描述是群聊会话路由的权威来源。历史群可能早于 registry 创建，
        // 或在冷启动时没有被重建进内存映射；若只解析 sessionId 而不补绑定，
        // prompt 虽能启动，却找不到生成卡片目标，收尾也无法清除 running。
        const registry = await loadSessionRegistryForBinding();
        const record = registry[chatId];
        if (record?.sessionId && record.sessionId !== sessionId) {
          unbindChatFromSession(record.sessionId, chatId);
        }
        bindChatToSession(sessionId, chatId);

        const memoryInfo = sessionInfoMap.get(chatId);
        if (!memoryInfo || memoryInfo.sessionId !== sessionId) {
          sessionInfoMap.set(chatId, {
            sessionId,
            tool: descriptionTool,
            turnCount: record?.sessionId === sessionId ? record.turnCount : 0,
            lastContextTokens:
              record?.sessionId === sessionId ? record.lastContextTokens : 0,
            startTime:
              record?.sessionId === sessionId
                ? record.startTime
                : Date.now(),
          });
        }

        // 同步自愈持久化记录，使下一次重启可以直接重建绑定。running 取实际
        // 内存状态，顺便修复旧故障遗留的 stale running=true。
        await recordSessionRegistry({
          chatId,
          sessionId,
          tool: descriptionTool,
          chatType,
          chatName: chatInfo.name,
          running: isSessionRunning(sessionId),
        });
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
  } else if (platform.kind === "wechat" || platform.kind === "feishu") {
    // 私聊没有可写的群描述，因此会话绑定只持久化在 session-registry.json。
    try {
      const registry = await loadSessionRegistryForBinding();
      const record = registry[chatId];
      // 旧版飞书曾把私聊视为建群入口，并会清理私聊 registry。没有 p2p
      // 标记的残留记录不能证明它是在固定用户目录创建的，因此只迁移一次：
      // 先解除旧绑定；若本条是普通消息，随后在用户目录创建新的私聊 session。
      if (platform.kind === "feishu" && record?.sessionId && record.chatType !== "p2p") {
        unbindChatFromSession(record.sessionId, chatId);
        displayCards.delete(chatId);
        cancelQueuedMessage(record.sessionId);
        sessionInfoMap.delete(chatId);
        await removeSessionRegistryRecord(chatId);
        logTrace(tid, "BRANCH", {
          reason: "migrate_legacy_feishu_p2p_binding",
          chatId,
          oldSessionId: record.sessionId,
        });
      } else if (record && record.sessionId && record.tool) {
        let resolvedRecord: { sessionId: string; tool: string } = record;
        if (platform.kind === "feishu" && !isCommandText && record.chatType === "p2p") {
          const resolution = await resolveFeishuP2pAgent(platform, chatId, text, record, tid);
          if (resolution.kind === "error") {
            const previousLabel = toolDisplayName(resolution.previousTool);
            const desiredLabel = toolDisplayName(resolution.desiredTool);
            console.error(
              `[${ts()}] [P2P-SWITCH] ${previousLabel} -> ${desiredLabel} FAIL: ${resolution.error.message}`,
            );
            logTrace(tid, "DONE", {
              outcome: "switch_feishu_p2p_default_agent_fail",
              oldTool: resolution.previousTool,
              newTool: resolution.desiredTool,
              error: resolution.error.message,
            });
            await platform.sendCard(
              chatId,
              "Agent 切换失败",
              `无法从 ${previousLabel} 切换到 ${desiredLabel}：\n${resolution.error.message}`,
              "red",
            ).catch(() => {});
            return;
          }
          resolvedRecord = resolution;
          if (resolution.kind === "waiting") {
            pendingFeishuP2pDefaultTool = resolution.desiredTool;
          }
        }

        sessionId = resolvedRecord.sessionId;
        descriptionTool = resolvedRecord.tool;
        toolLabel = toolDisplayName(descriptionTool);
        // 确保内存状态在冷启动后恢复；bindChatToSession 是幂等的。
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
    const routeKind = isCommandText ? "command" : "prompt";
    const chatKind = chatType === "p2p" ? "p2p chat" : "session group";
    console.log(
      `[${ts()}] [ROUTE] ${toolLabel} ${chatKind} ${routeKind} detected, session=${sessionId} tool=${descriptionTool}`,
    );

    if (
      chatType !== "p2p" &&
      isUntitledSessionChatName(chatInfo!.name) &&
      !isCommandText
    ) {
      const MAX_PREFIX = 10;
      const prefix = text.slice(0, MAX_PREFIX);
      const adapter = getAdapterForTool(descriptionTool, sessionId);
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

    // P2P：首条非指令消息只更新 registry 中的展示名，不修改私聊信息。
    if (
      chatType === "p2p" &&
      (platform.kind === "wechat" || platform.kind === "feishu") &&
      !isCommandText
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
          const adapter = getAdapterForTool(descriptionTool!, sessionId);
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
            `[${ts()}] [RENAME] ${platform.kind} P2P → "${newName2}"`,
          );
        }
      } catch (err) {
        console.error(
          `[${ts()}] [RENAME] ${platform.kind} P2P failed: ${(err as Error).message}`,
        );
      }
    }

    if (isCommandText && textLower === "/stop") {
      logTrace(tid, "BRANCH", { cmd: "/stop" });
      if (stopSession(sessionId)) {
        console.log(`[${ts()}] [STOP] User sent /stop, session=${sessionId}`);
        logTrace(tid, "DONE", { outcome: "stop_requested" });
      } else {
        await platform
          .sendText(chatId, "当前没有正在进行的会话。")
          .catch(() => {});
        logTrace(tid, "DONE", { outcome: "stop_no_session" });
      }
      return;
    }

    if (isCommandText && textLower === "/cancel") {
      logTrace(tid, "BRANCH", { cmd: "/cancel" });
      if (cancelQueuedMessage(sessionId)) {
        console.log(`[${ts()}] [CANCEL] Queue cancelled for session=${sessionId}`);
        await platform.sendText(chatId, "已取消缓存队列中的消息。").catch(() => {});
        logTrace(tid, "DONE", { outcome: "cancelled" });
      } else {
        await platform.sendText(chatId, "当前缓存队列中没有消息。").catch(() => {});
        logTrace(tid, "DONE", { outcome: "cancel_no_queue" });
      }
      return;
    }

    if (isCommandText && textLower === "/test") {
      logTrace(tid, "BRANCH", { cmd: "/test" });
      const tableHeaders = ["名称", "版本", "状态"];
      const tableRows = [
        ["ChatCCC", "0.2.96", "运行中"],
        ["Claude SDK", "0.50.0", "已连接"],
        ["Feishu API", "v1", "正常"],
      ];
      const mdTable = [
        `| ${tableHeaders.join(" | ")} |`,
        `| ${tableHeaders.map(() => "---").join(" | ")} |`,
        ...tableRows.map((row) => `| ${row.join(" | ")} |`),
      ].join("\n");

      if (platform.kind === "feishu") {
        try {
          const token = await getTenantAccessToken();
          const postContent: unknown[][] = [
            // 先尝试富文本表格
            [{ tag: "table", cells: [tableHeaders, ...tableRows] }],
            // 再用代码块包起来
            [{ tag: "text", text: `\n表格（代码块格式）：\n\`\`\`\n${mdTable}\n\`\`\`` }],
          ];
          await sendPostMessage(token, chatId, "测试表格", postContent);
        } catch (err) {
          console.error(`[${ts()}] [TEST] post message failed: ${(err as Error).message}`);
          // Fallback to markdown card
          await platform.sendText(chatId, `表格（代码块格式）：\n\`\`\`\n${mdTable}\n\`\`\``).catch(() => {});
        }
      } else {
        // WeChat / other platforms: just send code block
        await platform.sendText(chatId, `表格（代码块格式）：\n\`\`\`\n${mdTable}\n\`\`\``).catch(() => {});
      }
      logTrace(tid, "DONE", { outcome: "test" });
      return;
    }

    if (isCommandText && textLower === "/state") {
      logTrace(tid, "BRANCH", { cmd: "/state" });
      await sendStateCard(platform, chatId, sessionId, toolLabel, tid);
      return;
    }

    if (isCommandText && textLower === "/sessions") {
      logTrace(tid, "BRANCH", { cmd: "/sessions" });
      const allSessions = await getAllSessionsStatus();
      const now = Date.now();
      const cardData = allSessions.map((s) => ({
        sessionId: s.sessionId,
        chatName: s.chatName,
        chatId: s.chatId,
        chatType: s.chatType,
        active: s.active,
        turnCount: s.turnCount,
        elapsedSeconds: s.active
          ? Math.floor((now - s.startTime) / 1000)
          : null,
        model: s.model,
        tool: s.tool,
      }));
      const card = buildSessionsCard(cardData, {
        defaultToolLabel: toolDisplayName(resolveDefaultAgentTool()),
        fixedPrivateSession: isFeishuP2p(platform, chatType),
      });
      const ok = await platform.sendRawCard(chatId, card);
      console.log(
        `[${ts()}] [SESSIONS] card sent, ok=${ok}, count=${cardData.length}`,
      );
      logTrace(tid, "DONE", { outcome: "sessions", ok, count: cardData.length });
      return;
    }

    if (isCommandText && textLower === "/newh") {
      logTrace(tid, "BRANCH", { cmd: "/newh" });
      let cwd: string;
      if (isFeishuP2p(platform, chatType)) {
        // 飞书私聊不支持切换工作目录。即使 /cd 已为后续 /new 群聊
        // 保存了其他默认目录，/newh 仍必须在运行 ChatCCC 的用户目录重建。
        cwd = homedir();
      } else {
        const adapter = getAdapterForTool(descriptionTool, sessionId);
        try {
          const info = await adapter.getSessionInfo(sessionId);
          cwd = info?.cwd ?? (await getDefaultCwd(chatId));
        } catch {
          cwd = await getDefaultCwd(chatId);
        }
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

      setChatAvatarForSession(platform, chatId, descriptionTool, "new", newSessionId).catch(() => {});

      await platform.sendCard(
        chatId,
        `${toolLabel} Session Reset`,
        `会话已重置为新的 **${toolLabel}** 会话。\n\n` +
          `**Session ID:** ${newSessionId}\n` +
          `**工作目录:** \`${cwd}\`${isFeishuP2p(platform, chatType) ? "（飞书私聊固定使用系统用户目录）" : "（沿用当前会话目录）"}\n\n` +
          `直接在这里发消息即可继续对话。\n` +
          `发送 **/cd** 可切换新建会话的默认目录。\n` +
          `发送 **/model** 查看或切换当前会话的模型。${fastHelpAfterModel(descriptionTool)}`,
        "green",
      );

      console.log(
        `[${ts()}] [NEWH] Session ${sessionId} → ${newSessionId} (same cwd=${cwd})`,
      );
      logTrace(tid, "DONE", { outcome: "newh", newSessionId, cwd });
      return;
    }

    if (isCommandText && textLower === "/deleteg") {
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
    const sessionMatch = isCommandText ? textLower.match(/^\/session\s+(\d+)$/) : null;
    if (sessionMatch) {
      // 飞书私聊有自己唯一的常驻 session；历史群聊 session 只能回到对应群聊
      // 继续，禁止通过 /session 把它们重新绑定进私聊。
      if (isFeishuP2p(platform, chatType)) {
        await platform.sendCard(
          chatId,
          "/session",
          "飞书私聊不能通过 /session 切换到历史群聊会话；它会在下一条普通消息时跟随默认 Agent。请回到对应群聊继续，或发送 /new 新建群聊。",
          "yellow",
        );
        logTrace(tid, "DONE", { outcome: "session_switch_disabled_feishu_p2p" });
        return;
      }

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

      const targetAdapter = getAdapterForTool(target.tool, target.sessionId);
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

      setChatAvatarForSession(platform, chatId, target.tool, "new", target.sessionId).catch(() => {});

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
          `直接在这里发消息即可继续对话。\n` +
          `发送 **/model** 查看或切换当前会话的模型。${fastHelpAfterModel(descriptionTool)}${busyNote}`,
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

    if (isCommandText && (textLower === "/fast" || textLower.startsWith("/fast "))) {
      const fastArg = text.slice(5).trim().toLowerCase();
      logTrace(tid, "BRANCH", { cmd: "/fast", arg: fastArg, sessionId, tool: descriptionTool });

      if (descriptionTool !== "codex") {
        const msg = `当前 ${toolLabel} 会话不支持 Fast 模式；/fast 仅适用于 Codex。`;
        await (platform.kind === "wechat"
          ? platform.sendText(chatId, msg)
          : platform.sendCard(chatId, "Codex Fast 模式", msg, "yellow")
        ).catch(() => {});
        logTrace(tid, "DONE", { outcome: "fast_unsupported", tool: descriptionTool });
        return;
      }

      if (fastArg && fastArg !== "on" && fastArg !== "off") {
        const msg = "用法: /fast、/fast on 或 /fast off";
        await (platform.kind === "wechat"
          ? platform.sendText(chatId, msg)
          : platform.sendCard(chatId, "Codex Fast 模式", msg, "yellow")
        ).catch(() => {});
        logTrace(tid, "DONE", { outcome: "fast_invalid", arg: fastArg });
        return;
      }

      if (fastArg) {
        setSessionFastModeOverride(sessionId, fastArg === "on");
      }
      const enabled = getEffectiveFastModeForTool("codex", sessionId);
      await sendFastModeStatus(platform, chatId, enabled).catch(() => {});
      if (fastArg) {
        const avatarStatus = isSessionRunning(sessionId) ? "busy" : "idle";
        await platform.setChatAvatar(chatId, "codex", avatarStatus, { fastMode: enabled }).catch((err) => {
          console.warn(`[${ts()}] [AVATAR] Fast mode refresh failed: chatId=${chatId} ${(err as Error).message}`);
        });
      }
      logTrace(tid, "DONE", {
        outcome: fastArg ? "fast_switched" : "fast_query",
        enabled,
        sessionId,
      });
      return;
    }

    // /model clear — 清除当前 session 的模型覆盖
    if (isCommandText && textLower === "/model clear") {
      logTrace(tid, "BRANCH", { cmd: "/model clear", sessionId });
      clearSessionModelOverride(sessionId);
      const defaultModel = getEffectiveModelForTool(descriptionTool);
      const toolLabel = toolDisplayName(descriptionTool);
      const msg = `已清除当前 ${toolLabel} 会话的模型覆盖，恢复使用: \`${defaultModel || "(未指定)"}\``;
      await (platform.kind === "wechat"
        ? platform.sendText(chatId, msg)
        : platform.sendCard(chatId, "模型切换", msg, "green")
      ).catch(() => {});
      logTrace(tid, "DONE", { outcome: "model_cleared", sessionId, tool: descriptionTool });
      return;
    }

    // /model <name> — 切换当前 session 的模型（支持所有 agent，模糊匹配）
    if (isCommandText && textLower.startsWith("/model ")) {
      const modelArg = text.slice(7).trim();
      if (!modelArg) return; // 纯 "/model " 不处理，交给上面的 /model 分支
      logTrace(tid, "BRANCH", { cmd: "/model", arg: modelArg, sessionId, tool: descriptionTool });

      const models = getAllModelsForTool(descriptionTool as AgentTool);
      const toolLabel = toolDisplayName(descriptionTool);

      // 查找目标模型：精确匹配优先，否则子串匹配（模型名越短越优先）
      const target = findModelMatch(modelArg, models);

      if (!target) {
        const msg = models.length > 0
          ? `未找到匹配 "${modelArg}" 的模型。当前 ${toolLabel} 可选模型:\n${models.map(m => `  \`${m}\``).join("\n")}`
          : `当前 ${toolLabel} 没有可切换的模型。请在 config.json 中配置模型字段。`;
        await (platform.kind === "wechat"
          ? platform.sendText(chatId, msg)
          : platform.sendCard(chatId, "模型切换", msg, "red")
        ).catch(() => {});
        logTrace(tid, "DONE", { outcome: "model_not_found", arg: modelArg, tool: descriptionTool });
        return;
      }

      setSessionModelOverride(sessionId, target);
      const msg = `已切换当前 ${toolLabel} 会话模型为: \`${target}\``;
      await (platform.kind === "wechat"
        ? platform.sendText(chatId, msg)
        : platform.sendCard(chatId, "模型切换", msg, "green")
      ).catch(() => {});
      logTrace(tid, "DONE", { outcome: "model_switched", arg: modelArg, target, sessionId, tool: descriptionTool });
      return;
    }

    // /model — 查看当前会话的可用模型（根据会话 Agent 类型）
    if (isCommandText && textLower === "/model") {
      logTrace(tid, "BRANCH", { cmd: "/model", sessionId, tool: descriptionTool });
      const models = getAllModelsForTool(descriptionTool as AgentTool);
      const currentModel = getEffectiveModelForTool(descriptionTool, sessionId);

      if (platform.kind === "wechat") {
        const lines = [currentModel ? `当前模型 (${toolLabel}): ${currentModel}` : `当前模型 (${toolLabel}): 未指定`];
        if (models.length > 0) {
          lines.push("", "可切换模型:");
          for (const m of models) lines.push(`  ${m}`);
          lines.push("", "输入 /model <模型名> 切换模型");
        } else {
          lines.push("", "没有可切换的模型。请在 config.json 中配置模型字段。");
        }
        if (descriptionTool === "codex") {
          lines.push("输入 /fast 查看或切换当前会话的 Fast 模式");
        }
        await platform.sendText(chatId, lines.join("\n")).catch(() => {});
      } else {
        const card = buildModelCard(currentModel, models, descriptionTool);
        await platform.sendRawCard(chatId, card);
      }
      logTrace(tid, "DONE", { outcome: "model_query", tool: descriptionTool });
      return;
    }

    // /git <args>：在「当前会话工作目录」执行 git 命令
    if (isCommandText && textLower === "/effort clear") {
      logTrace(tid, "BRANCH", { cmd: "/effort clear", sessionId, tool: descriptionTool });
      const efforts = getAllEffortsForTool(descriptionTool as AgentTool);
      const toolLabel = toolDisplayName(descriptionTool);
      if (efforts.length === 0) {
        const msg = `当前 ${toolLabel} 不支持 effort 切换。`;
        await (platform.kind === "wechat"
          ? platform.sendText(chatId, msg)
          : platform.sendCard(chatId, "Effort 切换", msg, "red")
        ).catch(() => {});
        logTrace(tid, "DONE", { outcome: "effort_unsupported", tool: descriptionTool });
        return;
      }

      clearSessionEffortOverride(sessionId);
      const defaultEffort = getDefaultEffortForTool(descriptionTool as AgentTool);
      const msg = `已清除当前 ${toolLabel} 会话的 effort 覆盖，恢复使用: \`${defaultEffort || "(未指定)"}\``;
      await (platform.kind === "wechat"
        ? platform.sendText(chatId, msg)
        : platform.sendCard(chatId, "Effort 切换", msg, "green")
      ).catch(() => {});
      logTrace(tid, "DONE", { outcome: "effort_cleared", sessionId, tool: descriptionTool });
      return;
    }

    if (isCommandText && textLower.startsWith("/effort ")) {
      const effortArg = text.slice(8).trim();
      if (!effortArg) return;
      logTrace(tid, "BRANCH", { cmd: "/effort", arg: effortArg, sessionId, tool: descriptionTool });

      const efforts = getAllEffortsForTool(descriptionTool as AgentTool);
      const toolLabel = toolDisplayName(descriptionTool);
      if (efforts.length === 0) {
        const msg = `当前 ${toolLabel} 不支持 effort 切换。`;
        await (platform.kind === "wechat"
          ? platform.sendText(chatId, msg)
          : platform.sendCard(chatId, "Effort 切换", msg, "red")
        ).catch(() => {});
        logTrace(tid, "DONE", { outcome: "effort_unsupported", tool: descriptionTool });
        return;
      }

      const target = findModelMatch(effortArg, efforts);
      if (!target) {
        const msg = `未找到匹配 "${effortArg}" 的 effort。当前 ${toolLabel} 可选 effort:\n${efforts.map(e => `  \`${e}\``).join("\n")}`;
        await (platform.kind === "wechat"
          ? platform.sendText(chatId, msg)
          : platform.sendCard(chatId, "Effort 切换", msg, "red")
        ).catch(() => {});
        logTrace(tid, "DONE", { outcome: "effort_not_found", arg: effortArg, tool: descriptionTool });
        return;
      }

      setSessionEffortOverride(sessionId, target);
      const msg = `已切换当前 ${toolLabel} 会话 effort 为: \`${target}\``;
      await (platform.kind === "wechat"
        ? platform.sendText(chatId, msg)
        : platform.sendCard(chatId, "Effort 切换", msg, "green")
      ).catch(() => {});
      logTrace(tid, "DONE", { outcome: "effort_switched", arg: effortArg, target, sessionId, tool: descriptionTool });
      return;
    }

    if (isCommandText && textLower === "/effort") {
      logTrace(tid, "BRANCH", { cmd: "/effort", sessionId, tool: descriptionTool });
      const efforts = getAllEffortsForTool(descriptionTool as AgentTool);
      const currentEffort = getEffectiveEffortForTool(descriptionTool, sessionId);
      const toolLabel = toolDisplayName(descriptionTool);

      if (efforts.length === 0) {
        const msg = `当前 ${toolLabel} 不支持 effort 切换。`;
        await (platform.kind === "wechat"
          ? platform.sendText(chatId, msg)
          : platform.sendCard(chatId, "Effort 切换", msg, "red")
        ).catch(() => {});
      } else if (platform.kind === "wechat") {
        const lines = [currentEffort ? `当前 effort (${toolLabel}): ${currentEffort}` : `当前 effort (${toolLabel}): 未指定`];
        lines.push("", "可切换 effort:");
        for (const e of efforts) lines.push(`  ${e}`);
        lines.push("", "输入 /effort <effort> 切换 effort");
        await platform.sendText(chatId, lines.join("\n")).catch(() => {});
      } else {
        const card = buildEffortCard(currentEffort, efforts, descriptionTool);
        await platform.sendRawCard(chatId, card);
      }
      logTrace(tid, "DONE", { outcome: "effort_query", tool: descriptionTool });
      return;
    }

    if (isCommandText && (textLower.startsWith("/git ") || textLower === "/git")) {
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

      const adapter = getAdapterForTool(descriptionTool, sessionId);
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

    // 并发检查：同一 session 只能有一个活跃 prompt，多余消息进入队列
    if (isSessionRunning(sessionId)) {
      const queued = enqueueMessage(sessionId, {
        text: promptText, chatId, openId, msgTimestamp, chatType, traceId: tid,
      });
      if (queued) {
        logTrace(tid, "QUEUED", { sessionId });
        console.log(
          `[${ts()}] [QUEUED] Session ${sessionId} is busy, message from chat ${chatId} enqueued`,
        );
        if (platform.kind === "wechat") {
          await platform.sendText(chatId, "当前会话正在生成中，你的消息已进入缓存队列，生成完成后会立即处理。发送 /cancel 可取消缓存。").catch(() => {});
        } else {
          if (isFeishuP2p(platform, chatType) && pendingFeishuP2pDefaultTool) {
            const currentLabel = toolDisplayName(descriptionTool);
            const desiredLabel = toolDisplayName(pendingFeishuP2pDefaultTool);
            await platform.sendCard(
              chatId,
              "Agent 切换等待中",
              `当前 ${currentLabel} 正在生成；完成后会切换到 ${desiredLabel}，并用新的空会话处理这条消息。\n\n发送 **/cancel** 可取消缓存。`,
              "blue",
            ).catch(() => {});
          } else {
            await platform.sendRawCard(chatId, buildQueuedCard(text)).catch(() => {});
          }
        }
      } else {
        logTrace(tid, "QUEUE_FULL", { sessionId });
        console.log(
          `[${ts()}] [QUEUE_FULL] Session ${sessionId} queue full, rejecting message from chat ${chatId}`,
        );
        if (platform.kind === "wechat") {
          await platform.sendText(chatId, "当前缓存队列中已有消息等待处理，请等待或发送 /stop（停止生成）或 /cancel（取消缓存）。").catch(() => {});
        } else {
          await platform.sendRawCard(chatId, buildQueueFullCard()).catch(() => {});
        }
      }
      return;
    }

    if (shouldSendWechatProcessingAck(platform, isCommandText, chatType)) {
      await platform.sendText(chatId, "生成中...").catch(() => {});
    }

    try {
      logTrace(tid, "RESUME", { sessionId, tool: descriptionTool });
      await resumeAndPrompt(
        sessionId,
        promptText,
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

  if (isCommandText && (textLower === "/fast" || textLower.startsWith("/fast "))) {
    const defaultTool = resolveDefaultAgentTool();
    const fastArg = text.slice(5).trim().toLowerCase();
    if (defaultTool !== "codex") {
      const msg = `当前默认 Agent (${toolDisplayName(defaultTool)}) 不支持 Fast 模式；/fast 仅适用于 Codex。`;
      await (platform.kind === "wechat"
        ? platform.sendText(chatId, msg)
        : platform.sendCard(chatId, "Codex Fast 模式", msg, "yellow")
      ).catch(() => {});
      logTrace(tid, "DONE", { outcome: "fast_unsupported", defaultTool });
      return;
    }
    if (fastArg) {
      const msg = "当前没有绑定 Codex 会话，无法设置会话覆盖。请先创建或进入 Codex 会话；全局默认值可在 Web UI 中设置。";
      await (platform.kind === "wechat"
        ? platform.sendText(chatId, msg)
        : platform.sendCard(chatId, "Codex Fast 模式", msg, "yellow")
      ).catch(() => {});
      logTrace(tid, "DONE", { outcome: "fast_no_session", arg: fastArg });
      return;
    }
    const enabled = getEffectiveFastModeForTool("codex");
    await sendFastModeStatus(platform, chatId, enabled).catch(() => {});
    logTrace(tid, "DONE", { outcome: "fast_query", enabled, defaultTool });
    return;
  }

  // 无会话上下文 → 检查是否是 /model 查询
  if (isCommandText && textLower === "/model") {
    const defaultTool = resolveDefaultAgentTool();
    const models = getAllModelsForTool(defaultTool);
    let currentModel = "";
    if (defaultTool === "cursor") currentModel = config.cursor.model;
    else if (defaultTool === "codex") currentModel = config.codex.model;
    else if (defaultTool === "ccc") currentModel = config.ccc.model;
    else currentModel = CLAUDE_MODEL;

    if (platform.kind === "wechat") {
      const lines = [currentModel ? `当前模型 (${defaultTool}): ${currentModel}` : `当前模型 (${defaultTool}): 未指定`];
      if (models.length > 0) {
        lines.push("", "可切换模型:");
        for (const m of models) lines.push(`  ${m}`);
        lines.push("", "在会话中输入 /model <模型名> 切换模型");
      } else {
        lines.push("", "没有可切换的模型。请在 config.json 中配置模型字段。");
      }
      if (defaultTool === "codex") {
        lines.push("输入 /fast 查看当前 Codex Fast 模式");
      }
      await platform.sendText(chatId, lines.join("\n")).catch(() => {});
    } else {
      const card = buildModelCard(currentModel, models, defaultTool);
      await platform.sendRawCard(chatId, card);
    }
    logTrace(tid, "DONE", { outcome: "model_query", defaultTool });
    return;
  }

  // A private /state query is useful even before the first Agent session exists.
  // Keep it read-only and render the same status-card shape as established chats.
  if (isCommandText && textLower === "/state" && isFeishuP2p(platform, chatType)) {
    logTrace(tid, "BRANCH", { cmd: "/state", scope: "unbound_p2p" });
    await sendStateCard(
      platform,
      chatId,
      null,
      toolDisplayName(resolveDefaultAgentTool()),
      tid,
    );
    return;
  }

  // 无会话上下文 → /sessions 仍是有效指令，不触发飞书私聊自动建群。
  if (isCommandText && textLower === "/effort") {
    const defaultTool = resolveDefaultAgentTool();
    const efforts = getAllEffortsForTool(defaultTool);
    const currentEffort = getDefaultEffortForTool(defaultTool);
    const toolLabel = toolDisplayName(defaultTool);

    if (efforts.length === 0) {
      const msg = `当前默认 agent (${toolLabel}) 不支持 effort 切换。`;
      await (platform.kind === "wechat"
        ? platform.sendText(chatId, msg)
        : platform.sendCard(chatId, "Effort 切换", msg, "red")
      ).catch(() => {});
    } else if (platform.kind === "wechat") {
      const lines = [currentEffort ? `当前默认 effort (${toolLabel}): ${currentEffort}` : `当前默认 effort (${toolLabel}): 未指定`];
      lines.push("", "可切换 effort:");
      for (const e of efforts) lines.push(`  ${e}`);
      lines.push("", "在会话中输入 /effort <effort> 切换 effort");
      await platform.sendText(chatId, lines.join("\n")).catch(() => {});
    } else {
      const card = buildEffortCard(currentEffort, efforts, defaultTool);
      await platform.sendRawCard(chatId, card);
    }
    logTrace(tid, "DONE", { outcome: "effort_query", defaultTool });
    return;
  }

  if (isCommandText && textLower.startsWith("/effort ")) {
    const defaultTool = resolveDefaultAgentTool();
    const toolLabel = toolDisplayName(defaultTool);
    const msg = `当前没有绑定会话。请先进入 Claude/Codex 会话，再输入 /effort <effort> 切换当前会话的 effort。当前默认 agent: ${toolLabel}`;
    await (platform.kind === "wechat"
      ? platform.sendText(chatId, msg)
      : platform.sendCard(chatId, "Effort 切换", msg, "yellow")
    ).catch(() => {});
    logTrace(tid, "DONE", { outcome: "effort_no_session", defaultTool });
    return;
  }

  if (isCommandText && textLower === "/sessions") {
    logTrace(tid, "BRANCH", { cmd: "/sessions", scope: "global" });
    const allSessions = await getAllSessionsStatus();
    const now = Date.now();
    const cardData = allSessions.map((s) => ({
      sessionId: s.sessionId,
      chatName: s.chatName,
      chatId: s.chatId,
      chatType: s.chatType,
      active: s.active,
      turnCount: s.turnCount,
      elapsedSeconds: s.active
        ? Math.floor((now - s.startTime) / 1000)
        : null,
      model: s.model,
      tool: s.tool,
    }));
    const card = buildSessionsCard(cardData, {
      defaultToolLabel: toolDisplayName(resolveDefaultAgentTool()),
      fixedPrivateSession: isFeishuP2p(platform, chatType),
    });
    const ok = await platform.sendRawCard(chatId, card);
    console.log(
      `[${ts()}] [SESSIONS] card sent, ok=${ok}, count=${cardData.length}`,
    );
    logTrace(tid, "DONE", { outcome: "sessions", ok, count: cardData.length });
    return;
  }

  // 飞书私聊普通消息：首次使用时在当前私聊创建并持久化一个专属 session，
  // 随后的消息会在上面的 registry 路由中继续该 session。只有显式 /new 才建群。
  if (isFeishuP2p(platform, chatType) && !isCommandText) {
    const tool = resolveDefaultAgentTool();
    const toolLabel = toolDisplayName(tool);
    // 私聊 cwd 故意不读取 /cd 的 chatId 默认值：/cd 只为之后显式
    // /new 创建的群聊服务，飞书私聊始终从 ChatCCC 运行账号的用户目录启动。
    const cwd = homedir();
    logTrace(tid, "BRANCH", { cmd: "auto_new_feishu_p2p", tool, cwd });

    try {
      const init = await initClaudeSession(tool, cwd);
      const sessionId = init.sessionId;
      const chatName = sessionChatName(text.slice(0, 10) || "私聊会话", cwd);
      const switchResult = await switchChatBinding({
        chatId,
        chatType,
        oldSessionId: null,
        newSessionId: sessionId,
        tool,
        chatName,
        newDescription: `${sessionPrefixForTool(tool)} ${sessionId}`,
        updateChatInfoFn: (cid, name, desc) =>
          platform.updateChatInfo(cid, name, desc),
      });
      if (!switchResult.ok) {
        throw switchResult.error ?? new Error("Failed to bind Feishu private session");
      }

      await resumeAndPrompt(
        sessionId,
        promptText,
        platform,
        chatId,
        msgTimestamp,
        tool,
        tid,
      );
      logTrace(tid, "DONE", {
        outcome: "auto_new_feishu_p2p_prompt_done",
        chatId,
        sessionId,
        tool,
        cwd,
      });
    } catch (err) {
      console.error(`[${ts()}] [AUTO-P2P] FAIL: ${(err as Error).message}`);
      logTrace(tid, "DONE", {
        outcome: "auto_new_feishu_p2p_fail",
        error: (err as Error).message,
      });
      await platform.sendCard(
        chatId,
        "Error",
        `Failed to create ${toolLabel} private session:\n${(err as Error).message}`,
        "red",
      );
    }
    return;
  }

  // 无会话上下文 → help card
  logTrace(tid, "SEND", { method: "help_card", chatId });
  const card = buildHelpCard(text, { defaultToolLabel: toolDisplayName(resolveDefaultAgentTool()) });
  const ok = await platform.sendRawCard(chatId, card);
  if (!ok) {
    console.error(`[${ts()}] [SEND] help_card FAIL: chatId=${chatId}`);
    logTrace(tid, "DONE", { outcome: "help_card_fail" });
  } else {
    console.log(`[${ts()}] [SEND] help_card OK: chatId=${chatId}`);
    logTrace(tid, "DONE", { outcome: "help_card_sent" });
  }
}
