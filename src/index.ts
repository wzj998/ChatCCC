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

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { WSClient, EventDispatcher, Domain } from "@larksuiteoapi/node-sdk";
import WebSocket from "ws";

import { appendStartupTrace, attachRelayWebSocket, ensureSingleInstance, freeRelayListenPort, installCrashLogging, waitForPortFree } from "./shared.ts";
import { createUiRouter, setExtraApiHandler, setReloadConfigHook, startSetupMode } from "./web-ui.ts";
import { buildPlatformStartupPlan } from "./platform-startup.ts";
import { makeTraceId, logTrace } from "./trace.ts";
import {
  CHATCCC_PORT,
  APP_ID,
  APP_SECRET,
  FEISHU_ENABLED,
  FEISHU_PLATFORM_TYPE,
  ILINK_ENABLED,
  ILINK_REUSE_TOKEN_ON_START,
  BASE_URL,
  LOCAL_RELAY_URL,
  PID_FILE,
  PROJECT_ROOT,
  USE_LOCAL,
  USE_SIMULATE,
  appendChatLog,
  fileLog,
  reloadConfigFromDisk,
  reportEnvironmentVariableReadout,
  maskAppId,
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
  sendRestartCard,
  verifyAllPermissions,
  reportPermissionResults,
  setPlatform,
  consumeCodexRateLimitResetCredit,
} from "./feishu-platform.ts";
import { SimulatedPlatform, SIM_DEFAULT_CHAT_ID } from "./sim-platform.ts";
import { setMessageHandler } from "./sim-store.ts";
import { handleAgentImageRequest } from "./agent-image-rpc.ts";
import { handleAgentFileRequest } from "./agent-file-rpc.ts";
import { handleAgentDelegateTaskRequest } from "./agent-delegate-task-rpc.ts";
import { handleAgentStopStuckRequest } from "./agent-stop-stuck.ts";
import { handleChatGptSubscriptionRequest } from "./chatgpt-subscription-rpc.ts";
import { applyPrivacy } from "./privacy.ts";
import {
  createCardKitCard,
  sendCardKitMessage,
  updateCardKitCard,
} from "./cardkit.ts";
import {
  MAX_PROCESSED,
  clearAdapterCache,
  loadSessionRegistryForBinding,
  processedMessages,
  rebuildBindingsFromRegistry,
  resetState,
  setSessionPlatform,
  startUnifiedDisplayLoop,
} from "./session.ts";
import { startChromeDevtoolsGuard, stopChromeDevtoolsGuard } from "./chrome-devtools-guard.ts";
import {
  rebuildSessionChatsFromRegistry,
  setQueueConsumer,
} from "./session-chat-binding.ts";
import { fixStaleStreamStates } from "./stream-state.ts";
import { handleCommand, type PlatformAdapter } from "./orchestrator.ts";
import { createWechatAdapter, startWechatPlatform } from "./wechat-platform.ts";
import { handleCodexResetCardAction } from "./codex-reset-actions.ts";

// ---------------------------------------------------------------------------
// Feishu 平台适配器
// ---------------------------------------------------------------------------

function createFeishuAdapter(): PlatformAdapter {
  const auth = () => getTenantAccessToken();
  return {
    kind: "feishu",

    // ---- 基础消息 ----
    async sendText(chatId, text) {
      return sendTextReply(await auth(), chatId, text);
    },
    async sendCard(chatId, title, content, template) {
      return sendCardReply(await auth(), chatId, title, content, template);
    },
    async sendRawCard(chatId, cardJson) {
      return sendRawCard(await auth(), chatId, cardJson);
    },

    // ---- 群聊管理 ----
    async createGroup(name, userIds) {
      return createGroupChat(await auth(), name, userIds);
    },
    async updateChatInfo(chatId, name, description) {
      return updateChatInfo(await auth(), chatId, name, description);
    },
    async getChatInfo(chatId) {
      return getChatInfo(await auth(), chatId);
    },
    async disbandChat(chatId) {
      return disbandChat(await auth(), chatId);
    },
    async setChatAvatar(chatId, tool, status, usageHints) {
      return setChatAvatar(await auth(), chatId, tool, status, usageHints);
    },

    extractSessionInfo(description) {
      return extractSessionInfo(description);
    },

    // ---- 进度展示（CardKit 委托） ----
    async cardCreate(cardJson) {
      return createCardKitCard(await auth(), applyPrivacy(cardJson));
    },
    async cardSend(chatId, cardId) {
      return sendCardKitMessage(await auth(), chatId, cardId);
    },
    async cardUpdate(cardId, cardJson, sequence) {
      return updateCardKitCard(await auth(), cardId, applyPrivacy(cardJson), sequence);
    },
  };
}

const feishuPlatform = createFeishuAdapter();
const wechatPlatform = createWechatAdapter();
setSessionPlatform(feishuPlatform);

// 注册队列消费回调：session 生成完成后自动处理缓存消息
setQueueConsumer((platform, msg) => {
  handleCommand(platform, msg.text, msg.chatId, msg.openId, msg.msgTimestamp, msg.chatType, msg.traceId).catch(err =>
    console.error(`[${ts()}] Queue consume failed: ${(err as Error).message}`)
  );
});

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

import { formatMessageContent } from "./format-message.ts";

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

  const CMD_MAP: Record<string, string> = { stop: "/stop", cancel: "/cancel", new: "/new", "new claude": "/new claude", "new cursor": "/new cursor", "new codex": "/new codex", restart: "/restart", update: "/update", state: "/state", cd: "/cd", sessions: "/sessions", newh: "/newh" };
  let text = CMD_MAP[cmd] ?? "";
  if (cmd === "cd" && typeof action.value === "object" && action.value !== null) {
    const path = (action.value as Record<string, string>).path;
    if (path) text = `/cd ${path}`;
  }
  // cmd 本身就是以 / 开头的完整指令时，直接使用（如 /model <name> 动态按钮）
  if (!text && cmd.startsWith("/")) text = cmd;
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
const wechatSignal = { stopped: false };

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
  handleCommand(feishuPlatform, text, chatId, openId, Date.now(), chatType).catch((err) =>
    console.error(`[${ts()}] [SIM:INJECT] handleCommand error: ${(err as Error).message}`)
  );

  res.writeHead(202, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: true, chat_id: chatId }));
  return true;
}

// ---------------------------------------------------------------------------
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
    const apiHost = BASE_URL.replace("https://", "").replace("/open-apis", "");
    console.error("  常见原因:");
    console.error(
      `    - 本机网络无法访问 ${apiHost}（可尝试：关闭系统/终端代理、检查防火墙；Windows 可管理员运行 netsh winsock reset 后重启）`,
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
      await handleCommand(feishuPlatform, text, chatId, openId, msgTimestamp, chatType, traceId);
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

      const handledCodexReset = await handleCodexResetCardAction(data, {
        getTenantAccessToken,
        sendRawCard,
        sendTextReply,
        sendCardReply,
        updateCardMessage,
        recallMessage,
        consumeCodexRateLimitResetCredit,
      });
      if (handledCodexReset) return;

      const result = parseCardAction(data);
      if (!result) return;
      console.log(`[BTN] chat=${result.chatId} text="${result.text}"`);
      handleCommand(feishuPlatform, result.text, result.chatId, result.openId, Date.now()).catch((err) =>
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
          handleCommand(feishuPlatform, action.text, action.chatId, action.openId, Date.now()).catch((err) =>
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
    // 进程首次启动:此时所有 Map 都是空的,resetState 主要是打个 LOG 标识"开始
    // 干净状态"。修正残留的 running stream-state 并重建 session→chat 映射。
    resetState();
    startUnifiedDisplayLoop();
    fixStaleStreamStates().then(async () => {
      const registry = await loadSessionRegistryForBinding();
      rebuildSessionChatsFromRegistry(registry);
    }).catch((err) => console.error(`[${ts()}] Init bindings failed: ${(err as Error).message}`));

    // ⚠️ 关键设计:onReady / onReconnected 只重建只读映射,**绝不**清空运行时
    // 状态(activePrompts、sessionInfoMap、processedMessages)。
    // SDK 重连只是底层 WebSocket 抖动,业务层不受影响:
    //   - 后台 generator 仍在跑、stream-state 仍在被写
    //   - display loop 仍在向群推送
    //   - 已处理消息的去重 set 必须保留,避免 SDK 重推老消息时 prompt 跑两遍
    // 历史 bug:此处曾误调 resetState() 导致重连即让所有后台任务变孤儿,
    // 同一 session 还可能双开 prompt(详见 session.ts::resetState 注释)。
    const wsClient = new WSClient({
      appId: APP_ID,
      appSecret: APP_SECRET,
      domain: FEISHU_PLATFORM_TYPE === "lark" ? Domain.Lark : Domain.Feishu,
      onReady: async () => {
        await rebuildBindingsFromRegistry().catch((err) =>
          console.error(`[${ts()}] [SDK READY] rebuild bindings failed: ${(err as Error).message}`)
        );
      },
      onReconnected: async () => {
        await rebuildBindingsFromRegistry().catch((err) =>
          console.error(`[${ts()}] [SDK RECONNECT] rebuild bindings failed: ${(err as Error).message}`)
        );
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
// WeChat iLink supervisor — 自动重连
// ---------------------------------------------------------------------------

async function startWechatSupervisor(): Promise<void> {
  if (!ILINK_ENABLED) {
    console.log("[WX] 微信 iLink 未启用（platforms.ilink.enabled 不为 true），跳过。");
    return;
  }

  console.log("\n[WX] 启动微信 iLink 平台...");

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const MAX_QR_RETRIES = 3;
  let qrTimeoutCount = 0;

  while (!wechatSignal.stopped) {
    let isQrTimeout = false;
    try {
      await startWechatPlatform(
        (text, chatId, openId, msgTimestamp, chatType, traceId) =>
          handleCommand(wechatPlatform, text, chatId, openId, msgTimestamp, chatType, traceId),
        wechatSignal,
        ILINK_REUSE_TOKEN_ON_START,
      );
      // 登录成功后重置计数
      qrTimeoutCount = 0;
    } catch (err) {
      const msg = (err as Error).message ?? "";
      isQrTimeout = msg.includes("QR 登录超时");
      if (isQrTimeout) {
        qrTimeoutCount++;
        console.error(
          `[WX] QR 登录超时 (${qrTimeoutCount}/${MAX_QR_RETRIES}): ${msg}`,
        );
        if (qrTimeoutCount >= MAX_QR_RETRIES) {
          console.error(
            `[WX] 已连续 ${MAX_QR_RETRIES} 次 QR 登录超时，放弃重试。如需重新尝试请重启 ChatCCC。`,
          );
          break;
        }
      } else {
        console.error(`[WX] 微信 iLink 崩溃: ${msg}`);
      }
    }
    if (wechatSignal.stopped) break;
    const delaySeconds = isQrTimeout ? 300 : 30;
    const delayDesc = isQrTimeout ? "5 分钟" : "30 秒";
    console.log(`[WX] ${delayDesc}后重试...`);
    await sleep(delaySeconds * 1000);
  }
  console.log("[WX] 微信 iLink 平台已停止。");
}

async function startConfiguredPlatforms(
  httpServer: Server,
  options: { failOnFeishuError: boolean },
): Promise<void> {
  const plan = buildPlatformStartupPlan({
    feishuEnabled: FEISHU_ENABLED,
    ilinkEnabled: ILINK_ENABLED,
  });

  if (plan.startFeishu) {
    try {
      await startBotService({ httpServer, port: CHATCCC_PORT });
    } catch (err) {
      if (options.failOnFeishuError) throw err;
      console.error(`\n[飞书] 启动失败: ${(err as Error).message}`);
      console.error("[飞书] 微信等其他平台不受影响，将继续启动。\n");
    }
  } else {
    console.log("[飞书] 平台未启用，跳过飞书启动。");
  }

  if (plan.startIlink) {
    startWechatSupervisor().catch((err) =>
      console.error(`[WX] 微信 supervisor 异常退出: ${(err as Error).message}`),
    );
  } else {
    console.log("[WX] 微信 iLink 未启用，跳过微信启动。");
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
        handleCommand(feishuPlatform, text, chatId, openId, Date.now(), chatType, traceId),
    );

    setExtraApiHandler(async (req, res) => {
      const injected = await handleSimInjectMessage(req, res);
      if (injected) return true;
      return (await handleAgentImageRequest(req, res))
        || (await handleAgentFileRequest(req, res))
        || (await handleAgentDelegateTaskRequest(req, res, feishuPlatform))
        || (await handleAgentStopStuckRequest(req, res))
        || (await handleChatGptSubscriptionRequest(req, res));
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
    clearAdapterCache();
    startChromeDevtoolsGuard();
    appendStartupTrace("reload-from-ui: config reloaded", {
      appIdMask: maskAppId(APP_ID),
    });
  });
  setExtraApiHandler(async (req, res) => {
    return (await handleAgentImageRequest(req, res))
      || (await handleAgentFileRequest(req, res))
      || (await handleAgentDelegateTaskRequest(req, res, feishuPlatform))
      || (await handleAgentStopStuckRequest(req, res))
      || (await handleChatGptSubscriptionRequest(req, res));
  });

  console.log(`[启动 2/7] 环境与凭证检查`);
  reportEnvironmentVariableReadout();
  console.log(`  工作目录: ${process.cwd()}`);
  console.log(`  包根目录: ${PROJECT_ROOT}`);

  if (FEISHU_ENABLED) {
    appendStartupTrace("main: before feishu credential check", {
      hasAppId: Boolean(APP_ID.trim()),
      hasAppSecret: Boolean(APP_SECRET.trim()),
    });
    if (!APP_ID.trim() || !APP_SECRET.trim()) {
      // 凭证不全：进 setup 向导。注入 onActivate 回调让用户点"保存并启动"
      // 时，原地（同进程）调用 startBotService，复用 setup HTTP server。
      startSetupMode(CHATCCC_PORT, {
        onActivate: async (httpServer: Server) => {
          reloadConfigFromDisk();
          clearAdapterCache();
          startChromeDevtoolsGuard();
          appendStartupTrace("setup-activate: reloaded config from disk", {
            appIdMaskAfterReload: maskAppId(APP_ID),
          });
          try {
            await startConfiguredPlatforms(httpServer, { failOnFeishuError: true });
            installShutdownHandlers(httpServer);
            return { ok: true };
          } catch (err) {
            appendStartupTrace("setup-activate: startConfiguredPlatforms failed", {
              message: (err as Error).message,
            });
            return { ok: false, error: (err as Error).message };
          }
        },
      });
      return;
    }
    console.log(`  必填项校验通过（App ID 摘要: ${maskAppId(APP_ID)}）。\n`);
    appendStartupTrace("main: feishu credentials ok", { appIdMask: maskAppId(APP_ID) });
  } else {
    console.log("  飞书平台未启用（platforms.feishu.enabled = false），跳过飞书凭证检查。\n");
    appendStartupTrace("main: feishu disabled", {});
  }

  startChromeDevtoolsGuard();

  // 启动 HTTP server（同时挂 UI router，供 dashboard / setup / agent image/file 使用）
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

  await startConfiguredPlatforms(httpServer, { failOnFeishuError: false });

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
  process.on("SIGINT", () => { console.log("\nShutting down..."); wechatSignal.stopped = true; stopChromeDevtoolsGuard(); httpServer.close(); process.exit(0); });
  process.on("SIGTERM", () => { wechatSignal.stopped = true; stopChromeDevtoolsGuard(); httpServer.close(); process.exit(0); });
}

main().catch((err: Error) => {
  appendStartupTrace("main: catch fatal", { message: err.message, stack: err.stack?.slice(0, 800) });
  console.error("\n[启动] 未捕获的致命错误（main 异步链）");
  console.error(`  ${err.message}`);
  if (err.stack) console.error(err.stack);
  printServiceDidNotStart(`main() 异常: ${err.message}`);
  process.exit(1);
});
