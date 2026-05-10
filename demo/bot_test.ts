/**
 * Feishu Bot Integration Test Demo (TypeScript)
 * ===========================================
 * Tests all send/receive events for Feishu bot integration.
 * Guides the user through each test step interactively.
 *
 * Usage:
 *   npx tsx --env-file=.env demo/bot_test.ts
 *   npx tsx --env-file=.env demo/bot_test.ts --local   (local relay mode)
 */

import {
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { WSClient, EventDispatcher } from "@larksuiteoapi/node-sdk";
import WebSocket from "ws";

import {
  setupFileLogging,
  ensureSingleInstance,
  createRelayServer,
  freeRelayListenPort,
} from "../src/shared.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TestResult {
  step: number;
  name: string;
  success: boolean;
  detail: string;
}

interface LarkEvent {
  event?: {
    event_type?: string;
    type?: string;
    message?: LarkMessage;
    sender?: { sender_id?: { open_id?: string } };
  };
  event_type?: string;
  type?: string;
  message?: LarkMessage;
}

interface LarkMessage {
  message_type?: string;
  content?: string;
  chat_id?: string;
}

interface ApiResponse {
  code: number;
  msg?: string;
  data?: {
    message_id?: string;
    image_key?: string;
  };
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const PID_FILE = join(PROJECT_ROOT, ".claude", "runtime.pid");

// 日志文件
const logDir = join(__dirname, "logs");
setupFileLogging(logDir, "bot-test");

// ---------------------------------------------------------------------------
// 单实例保证
// ---------------------------------------------------------------------------

const USE_LOCAL = process.argv.includes("--local");
const APP_ID: string = process.env.CHATCCC_APP_ID ?? "";
const APP_SECRET: string = process.env.CHATCCC_APP_SECRET ?? "";

const BASE_URL = "https://open.feishu.cn/open-apis";
const LOCAL_RELAY_URL = "ws://127.0.0.1:18080";
const RECEIVE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

const testResults: TestResult[] = [];

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function log(emoji: string, msg: string): void {
  const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  console.log(`[${ts}] ${emoji} ${msg}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function getTenantAccessToken(): Promise<string> {
  const resp = await fetch(`${BASE_URL}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const data = (await resp.json()) as ApiResponse;
  if (data.code !== 0) {
    throw new Error(`Failed to get token: ${data.msg}`);
  }
  return (data as unknown as { tenant_access_token: string }).tenant_access_token;
}

async function sendMessage(
  token: string,
  receiveId: string,
  msgType: string,
  content: string
): Promise<ApiResponse> {
  const url = new URL(`${BASE_URL}/im/v1/messages`);
  url.searchParams.set("receive_id_type", "chat_id");

  const resp = await fetch(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      receive_id: receiveId,
      msg_type: msgType,
      content,
    }),
  });
  return (await resp.json()) as ApiResponse;
}

async function patchMessage(
  token: string,
  messageId: string,
  content: string
): Promise<ApiResponse> {
  const resp = await fetch(`${BASE_URL}/im/v1/messages/${messageId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content }),
  });
  return (await resp.json()) as ApiResponse;
}

async function deleteMessage(token: string, messageId: string): Promise<ApiResponse> {
  const resp = await fetch(`${BASE_URL}/im/v1/messages/${messageId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  return (await resp.json()) as ApiResponse;
}

async function uploadImage(token: string, imagePath: string): Promise<string> {
  const buf = readFileSync(imagePath);
  const formData = new FormData();
  formData.set("image_type", "message");
  formData.set("image", new Blob([buf], { type: "image/png" }), "image.png");

  const resp = await fetch(`${BASE_URL}/im/v1/images`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: formData,
  });
  const data = (await resp.json()) as ApiResponse;
  if (data.code !== 0) {
    throw new Error(`Image upload failed: ${data.msg}`);
  }
  return data.data!.image_key!;
}

// ---------------------------------------------------------------------------
// Card builders
// ---------------------------------------------------------------------------

function buildTextCard(
  title: string,
  content: string,
  template = "blue",
  note = ""
): string {
  const elements: Record<string, unknown>[] = [
    {
      tag: "div",
      text: { tag: "lark_md", content },
    },
  ];
  if (note) {
    elements.push({ tag: "hr" });
    elements.push({
      tag: "div",
      text: { tag: "lark_md", content: `_${note}_` },
    });
  }

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      template,
      title: { content: title, tag: "plain_text" },
    },
    elements,
  });
}

function buildButtonCard(
  title: string,
  content: string,
  buttonText: string,
  actionValue: string
): string {
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      template: "blue",
      title: { content: title, tag: "plain_text" },
    },
    elements: [
      {
        tag: "div",
        text: { tag: "lark_md", content },
      },
      { tag: "hr" },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: buttonText },
            type: "primary",
            value: actionValue,
          },
        ],
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// WebSocket + Event handling
// ---------------------------------------------------------------------------

let broadcastToRelay: (data: unknown) => void = () => {};

class TestEventHandler {
  private _resolve: ((data: LarkEvent | null) => void) | null = null;
  private _timer: NodeJS.Timeout | null = null;
  receivedData: LarkEvent | null = null;
  running = true;

  onEvent(data: LarkEvent): void {
    broadcastToRelay(data);
    this.receivedData = data;
    if (this._resolve) {
      const r = this._resolve;
      this._resolve = null;
      if (this._timer) {
        clearTimeout(this._timer);
        this._timer = null;
      }
      r(data);
    }
    log("📨", `Received event: ${JSON.stringify(data).slice(0, 300)}`);
  }

  waitForEvent(
    eventType: string,
    timeoutMs: number = RECEIVE_TIMEOUT_MS
  ): Promise<LarkEvent | null> {
    return new Promise((resolve) => {
      this._resolve = resolve;
      const checkExisting = (): boolean => {
        if (this.receivedData) {
          const evt = this.receivedData.event ?? this.receivedData;
          if (evt.event_type === eventType || evt.type === eventType) {
            this.receivedData = null;
            this._resolve = null;
            if (this._timer) clearTimeout(this._timer);
            resolve(this.receivedData || evt);
            return true;
          }
        }
        return false;
      };
      if (checkExisting()) return;

      this._timer = setTimeout(() => {
        if (this._resolve) {
          this._resolve = null;
          resolve(null);
        }
      }, timeoutMs);

      const origResolve = this._resolve;
      this._resolve = (data) => {
        if (this._timer) clearTimeout(this._timer);
        const evt = data?.event ?? data;
        if (evt?.event_type === eventType || evt?.type === eventType) {
          this.receivedData = null;
          resolve(data);
        } else {
          // Wrong event type, keep waiting
          this.waitForEvent(eventType, timeoutMs).then(resolve);
        }
      };
    });
  }

  stop(): void {
    this.running = false;
    if (this._resolve) {
      this._resolve(null);
      this._resolve = null;
    }
    if (this._timer) clearTimeout(this._timer);
  }
}

// ---------------------------------------------------------------------------
// Feishu WebSocket (SDK，处理协议 ack/订阅)
// ---------------------------------------------------------------------------

function connectFeishuWS(handler: TestEventHandler): WSClient {
  const dispatcher = new EventDispatcher({});
  dispatcher.register({
    "im.message.receive_v1": (data: LarkEvent) => handler.onEvent(data),
    "card.action.trigger": (data: LarkEvent) => handler.onEvent(data),
  });

  const wsClient = new WSClient({
    appId: APP_ID,
    appSecret: APP_SECRET,
  });

  wsClient.start({ eventDispatcher: dispatcher }).then(() => {
    log("✅", "Feishu WebSocket connected (SDK)");
  }).catch((err: Error) => {
    log("❌", `Feishu WS connection failed: ${err.message}`);
  });

  return wsClient;
}

// ---------------------------------------------------------------------------
// WebSocket connection (local relay mode)
// ---------------------------------------------------------------------------

function wsConnectLocal(handler: TestEventHandler): Promise<void> {
  return new Promise((resolve, reject) => {
    log("🔗", `Connecting to local relay: ${LOCAL_RELAY_URL}`);
    const ws = new WebSocket(LOCAL_RELAY_URL);

    ws.on("open", () => {
      log("✅", "Connected to local relay");
      resolve();
    });

    ws.on("message", (raw: Buffer) => {
      try {
        const data = JSON.parse(raw.toString()) as LarkEvent;
        handler.onEvent(data);
      } catch {
        // ignore parse errors
      }
    });

    ws.on("close", () => {
      if (handler.running) {
        log("⚠️", "Local relay disconnected, reconnecting in 5s...");
        setTimeout(() => {
          if (handler.running) wsConnectLocal(handler).catch(() => {});
        }, 5000);
      }
    });

    ws.on("error", (err: Error) => {
      log("❌", `Local relay error: ${err.message}`);
      if (!handler.running) {
        reject(err);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Test step helpers
// ---------------------------------------------------------------------------

async function testStepHeader(
  step: number,
  total: number,
  name: string,
  chatId: string,
  token: string
): Promise<void> {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  [Test ${step}/${total}] ${name}`);
  console.log(`${"=".repeat(60)}`);

  await sendMessage(
    token,
    chatId,
    "interactive",
    buildTextCard(
      `🟢 Test ${step}/${total}: ${name}`,
      `Please follow the console instructions to complete this test step.\nTest will timeout after **${RECEIVE_TIMEOUT_MS / 60000} minutes**.`,
      "blue"
    )
  );
}

async function testResult(
  step: number,
  name: string,
  success: boolean,
  detail = ""
): Promise<void> {
  testResults.push({ step, name, success, detail });
  console.log(
    `  >>> ${success ? "PASS" : "FAIL"}: ${name}${detail ? ` - ${detail}` : ""}`
  );
}

// ---------------------------------------------------------------------------
// Receive tests
// ---------------------------------------------------------------------------

async function testReceiveText(
  step: number,
  chatId: string,
  token: string,
  handler: TestEventHandler
): Promise<boolean | string> {
  await testStepHeader(step, 13, "Receive Text Message", chatId, token);
  console.log("  >>> Please send a TEXT message to the bot (e.g. Hello, this is a test)");
  console.log("  ... Waiting (max " + (RECEIVE_TIMEOUT_MS / 60000) + " min) ...");

  const event = await handler.waitForEvent("im.message.receive_v1");
  if (!event) {
    await testResult(step, "Receive Text Message", false, "Timeout");
    await sendMessage(
      token, chatId, "interactive",
      buildTextCard("FAIL: Timeout", "Did not receive a text message within " + (RECEIVE_TIMEOUT_MS / 60000) + " minutes.", "red")
    );
    return "timeout";
  }

  const evt = event.event ?? event;
  const msg = evt.message ?? {};
  const msgType = msg.message_type ?? "";

  if (msgType === "text") {
    const content = JSON.parse(msg.content ?? "{}") as { text?: string };
    const text = content.text ?? "";
    log("✅", `Received text: ${text.slice(0, 100)}`);
    await testResult(step, "Receive Text Message", true, `Content: ${text.slice(0, 50)}`);
    await sendMessage(
      token, chatId, "interactive",
      buildTextCard("PASS", `Successfully received text message!\nContent: ${text.slice(0, 200)}`, "green")
    );
    return true;
  }

  await testResult(step, "Receive Text Message", false, `Got non-text message: ${msgType}`);
  return false;
}

async function testReceivePost(
  step: number,
  chatId: string,
  token: string,
  handler: TestEventHandler
): Promise<boolean | string> {
  await testStepHeader(step, 13, "Receive Rich Text (Post) Message", chatId, token);
  console.log("  >>> Please send a RICH TEXT / formatted message to the bot (multi-line, bold, italic, etc.)");
  console.log("  ... Waiting (max " + (RECEIVE_TIMEOUT_MS / 60000) + " min) ...");

  const event = await handler.waitForEvent("im.message.receive_v1");
  if (!event) {
    await testResult(step, "Receive Rich Text", false, "Timeout");
    await sendMessage(
      token, chatId, "interactive",
      buildTextCard("FAIL: Timeout", "Did not receive a rich text message.", "red")
    );
    return "timeout";
  }

  const evt = event.event ?? event;
  const msg = evt.message ?? {};
  const msgType = msg.message_type ?? "";

  if (msgType === "post") {
    const content = JSON.parse(msg.content ?? "{}") as {
      post?: { content?: unknown[][] };
      zh_cn?: { content?: unknown[][] };
    };
    const post = content.post ?? content.zh_cn ?? {};
    const raw = (post as { content?: unknown[][] }).content ?? [];
    const extracted = (raw)
      .flatMap((section) =>
        Array.isArray(section)
          ? section
              .filter(
                (el): el is { tag: string; text?: string } =>
                  typeof el === "object" && el !== null && (el as { tag: string }).tag === "text" || (el as { tag: string }).tag === "a"
              )
              .map((el) => String(el.text ?? ""))
          : []
      )
      .join("");
    await testResult(step, "Receive Rich Text", true, `Extracted: ${extracted.slice(0, 50)}`);
    await sendMessage(
      token, chatId, "interactive",
      buildTextCard("PASS", `Successfully received rich text message!\nExtracted: ${extracted.slice(0, 200)}`, "green")
    );
    return true;
  }

  await testResult(step, "Receive Rich Text", false, `Message type: ${msgType} (expected post)`);
  return false;
}

async function testReceiveImage(
  step: number,
  chatId: string,
  token: string,
  handler: TestEventHandler
): Promise<boolean | string> {
  await testStepHeader(step, 13, "Receive Image Message", chatId, token);
  console.log("  >>> Please send an IMAGE to the bot (any picture)");
  console.log("  ... Waiting (max " + (RECEIVE_TIMEOUT_MS / 60000) + " min) ...");

  const event = await handler.waitForEvent("im.message.receive_v1");
  if (!event) {
    await testResult(step, "Receive Image", false, "Timeout");
    await sendMessage(
      token, chatId, "interactive",
      buildTextCard("FAIL: Timeout", "Did not receive an image message.", "red")
    );
    return "timeout";
  }

  const evt = event.event ?? event;
  const msg = evt.message ?? {};
  const msgType = msg.message_type ?? "";

  if (msgType === "image") {
    const content = JSON.parse(msg.content ?? "{}") as { image_key?: string };
    const imageKey = content.image_key ?? "";
    await testResult(step, "Receive Image", true, `image_key: ${imageKey.slice(0, 20)}...`);
    await sendMessage(
      token, chatId, "interactive",
      buildTextCard("PASS", `Successfully received image!\nimage_key: ${imageKey}`, "green")
    );
    return true;
  }

  await testResult(step, "Receive Image", false, `Message type: ${msgType}`);
  return false;
}

async function testReceiveFile(
  step: number,
  chatId: string,
  token: string,
  handler: TestEventHandler
): Promise<boolean | string> {
  await testStepHeader(step, 13, "Receive File Message", chatId, token);
  console.log("  >>> Please send a FILE to the bot (any file: txt, pdf, etc.)");
  console.log("  ... Waiting (max " + (RECEIVE_TIMEOUT_MS / 60000) + " min) ...");

  const event = await handler.waitForEvent("im.message.receive_v1");
  if (!event) {
    await testResult(step, "Receive File", false, "Timeout");
    await sendMessage(
      token, chatId, "interactive",
      buildTextCard("FAIL: Timeout", "Did not receive a file message.", "red")
    );
    return "timeout";
  }

  const evt = event.event ?? event;
  const msg = evt.message ?? {};
  const msgType = msg.message_type ?? "";

  if (msgType === "file") {
    const content = JSON.parse(msg.content ?? "{}") as { file_key?: string; file_name?: string };
    const fileKey = content.file_key ?? "";
    const fileName = content.file_name ?? "unknown";
    await testResult(step, "Receive File", true, `File: ${fileName}`);
    await sendMessage(
      token, chatId, "interactive",
      buildTextCard("PASS", `Successfully received file!\nName: ${fileName}\nfile_key: ${fileKey}`, "green")
    );
    return true;
  }

  await testResult(step, "Receive File", false, `Message type: ${msgType}`);
  return false;
}

async function testReceiveMedia(
  step: number,
  chatId: string,
  token: string,
  handler: TestEventHandler
): Promise<boolean | string> {
  await testStepHeader(step, 13, "Receive Media/Video Message", chatId, token);
  console.log("  >>> Please send a VIDEO or VOICE message to the bot");
  console.log("  ... Waiting (max " + (RECEIVE_TIMEOUT_MS / 60000) + " min) ...");

  const event = await handler.waitForEvent("im.message.receive_v1");
  if (!event) {
    await testResult(step, "Receive Media/Video", false, "Timeout");
    await sendMessage(
      token, chatId, "interactive",
      buildTextCard("FAIL: Timeout", "Did not receive a video/voice message.", "red")
    );
    return "timeout";
  }

  const evt = event.event ?? event;
  const msg = evt.message ?? {};
  const msgType = msg.message_type ?? "";

  if (msgType === "media") {
    const content = JSON.parse(msg.content ?? "{}") as {
      file_key?: string;
      file_name?: string;
      duration?: number;
    };
    const fileKey = content.file_key ?? "";
    const fileName = content.file_name ?? "unknown";
    const duration = content.duration ?? 0;
    await testResult(step, "Receive Media/Video", true, `File: ${fileName}, duration: ${duration}ms`);
    await sendMessage(
      token, chatId, "interactive",
      buildTextCard("PASS", `Successfully received media!\nName: ${fileName}\nDuration: ${duration}ms`, "green")
    );
    return true;
  }

  await testResult(step, "Receive Media/Video", false, `Message type: ${msgType}`);
  return false;
}

async function testReceiveAudio(
  step: number,
  chatId: string,
  token: string,
  handler: TestEventHandler
): Promise<boolean | string> {
  await testStepHeader(step, 13, "Receive Audio/Voice Message", chatId, token);
  console.log("  >>> Please send a VOICE message to the bot (hold mic button in Feishu)");
  console.log("  ... Waiting (max " + (RECEIVE_TIMEOUT_MS / 60000) + " min) ...");

  const event = await handler.waitForEvent("im.message.receive_v1");
  if (!event) {
    await testResult(step, "Receive Audio/Voice", false, "Timeout");
    await sendMessage(
      token, chatId, "interactive",
      buildTextCard("FAIL: Timeout", "Did not receive a voice message.", "red")
    );
    return "timeout";
  }

  const evt = event.event ?? event;
  const msg = evt.message ?? {};
  const msgType = msg.message_type ?? "";

  if (msgType === "audio") {
    const content = JSON.parse(msg.content ?? "{}") as { duration?: number };
    const duration = content.duration ?? 0;
    await testResult(step, "Receive Audio/Voice", true, `duration: ${duration}ms`);
    await sendMessage(
      token, chatId, "interactive",
      buildTextCard("PASS", `Successfully received voice message!\nDuration: ${duration}ms`, "green")
    );
    return true;
  }

  await testResult(step, "Receive Audio/Voice", false, `Message type: ${msgType}`);
  return false;
}

async function testReceiveCardAction(
  step: number,
  chatId: string,
  token: string,
  handler: TestEventHandler
): Promise<boolean | string> {
  await testStepHeader(step, 13, "Receive Card Button Click", chatId, token);

  const actionValue = JSON.stringify({
    action: "test_button",
    timestamp: Date.now(),
  });
  await sendMessage(
    token,
    chatId,
    "interactive",
    buildButtonCard("🔘 Button Click Test", "Please click the button below to test card action event.", "Click Here", actionValue)
  );

  console.log("  >>> Please click the button on the card just sent in Feishu");
  console.log("  ... Waiting (max " + (RECEIVE_TIMEOUT_MS / 60000) + " min) ...");

  const event = await handler.waitForEvent("card.action.trigger");
  if (!event) {
    await testResult(step, "Receive Card Button Click", false, "Timeout");
    await sendMessage(
      token, chatId, "interactive",
      buildTextCard("FAIL: Timeout", "Did not receive card button click event.", "red")
    );
    return "timeout";
  }

  const evt = event.event ?? event;
  const sender = (evt as { sender?: { sender_id?: { open_id?: string } } }).sender ?? {};
  const userId: string = sender.sender_id?.open_id ?? "unknown";

  await testResult(step, "Receive Card Button Click", true, `User: ${userId}`);
  await sendMessage(
    token, chatId, "interactive",
    buildTextCard("PASS", `Successfully received card button click!\nUser: ${userId}`, "green")
  );
  return true;
}

// ---------------------------------------------------------------------------
// Send tests
// ---------------------------------------------------------------------------

async function testSendThinkingCard(
  step: number,
  chatId: string,
  token: string
): Promise<{ ok: boolean; msgId: string | null }> {
  await testStepHeader(step, 13, "Send Thinking Status Card", chatId, token);
  console.log("  >>> Sending [thinking] status card...");

  const result = await sendMessage(
    token,
    chatId,
    "interactive",
    buildTextCard("🔵 Thinking...", "Thinking, please wait...\n\n💭 **Preparing**", "blue", "Status: thinking")
  );

  const msgId = result.data?.message_id ?? "";
  if (msgId) {
    await testResult(step, "Send Thinking Card", true, `message_id: ${msgId}`);
    console.log("  >>> Please check Feishu - do you see the [thinking] card?");
    return { ok: true, msgId };
  }

  await testResult(step, "Send Thinking Card", false, result.msg || "unknown error");
  return { ok: false, msgId: null };
}

async function testSendStreamUpdate(
  step: number,
  chatId: string,
  token: string,
  prevMsgId: string | null
): Promise<boolean> {
  await testStepHeader(step, 13, "Stream Update Card (Patch)", chatId, token);

  let msgId = prevMsgId;
  if (!msgId) {
    console.log("  WARN: No previous message_id, creating a card first...");
    const result = await sendMessage(
      token, chatId, "interactive",
      buildTextCard("🔄 About to Update", "Original content...", "blue")
    );
    msgId = result.data?.message_id ?? "";
    if (!msgId) {
      await testResult(step, "Stream Update Card", false, "Cannot create test card");
      return true;
    }
  }

  console.log(`  >>> Patching message ${msgId} with incremental update...`);

  const card = buildTextCard(
    "🔄 Updating (streaming)",
    "**Original content...**\n\nThis new content was added via Patch API!\n\nContent is appended incrementally.",
    "blue",
    "Status: streaming"
  );

  const result = await patchMessage(token, msgId, card);

  if (result.code === 0) {
    await testResult(step, "Stream Update Card", true);
    console.log("  >>> Please check Feishu - did the card content update in-place?");
  } else {
    await testResult(step, "Stream Update Card", false, result.msg ?? `code: ${result.code}`);
    console.log("  NOTE: Feishu Patch API has rate limits, code 230020 is expected occasionally");
  }

  return true;
}

async function testSendDoneCard(
  step: number,
  chatId: string,
  token: string
): Promise<string | null> {
  await testStepHeader(step, 13, "Send Done Status Card", chatId, token);
  console.log("  >>> Sending [done] status card...");

  const result = await sendMessage(
    token,
    chatId,
    "interactive",
    buildTextCard(
      "Done",
      "Task completed successfully!\n\nThis is the final result card.\n\nSample data:\n- Item A: 100%\n- Item B: 100%",
      "green",
      "Status: done"
    )
  );

  const msgId = result.data?.message_id ?? "";
  if (msgId) {
    await testResult(step, "Send Done Card", true, `message_id: ${msgId}`);
    console.log("  >>> Please check Feishu - do you see the [done] card?");
    return msgId;
  }

  await testResult(step, "Send Done Card", false, result.msg ?? "");
  return null;
}

async function testSendErrorCard(
  step: number,
  chatId: string,
  token: string
): Promise<boolean> {
  await testStepHeader(step, 13, "Send Error Status Card", chatId, token);
  console.log("  >>> Sending [error] status card...");

  const result = await sendMessage(
    token,
    chatId,
    "interactive",
    buildTextCard(
      "Execution Failed",
      "**Error details:**\nThis is a simulated error message.\n\nError code: TEST_ERR_001\nSuggestion: Please retry later",
      "red",
      "Status: error"
    )
  );

  const msgId = result.data?.message_id ?? "";
  if (msgId) {
    await testResult(step, "Send Error Card", true, `message_id: ${msgId}`);
    console.log("  >>> Please check Feishu - do you see the [error] card?");
    return true;
  }

  await testResult(step, "Send Error Card", false, result.msg ?? "");
  return false;
}

async function testSendImage(
  step: number,
  chatId: string,
  token: string
): Promise<boolean> {
  await testStepHeader(step, 13, "Send Image Message", chatId, token);
  console.log("  >>> Generating test image and sending...");

  // Create a simple test image (1x1 blue pixel PNG)
  const tinyPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
    "base64"
  );
  const testImage = join(__dirname, "_test_img.png");
  writeFileSync(testImage, tinyPng);

  try {
    const imageKey = await uploadImage(token, testImage);
    const content = JSON.stringify({ image_key: imageKey });

    const result = await sendMessage(token, chatId, "image", content);
    const msgId = result.data?.message_id ?? "";

    if (msgId) {
      await testResult(step, "Send Image", true);
      console.log("  >>> Please check Feishu - do you see the image?");
    } else {
      await testResult(step, "Send Image", false, result.msg ?? "");
    }
  } catch (err) {
    await testResult(step, "Send Image", false, (err as Error).message);
  } finally {
    try { unlinkSync(testImage); } catch { /* ok */ }
  }

  return true;
}

async function testDeleteMessage(
  step: number,
  chatId: string,
  token: string
): Promise<boolean> {
  await testStepHeader(step, 13, "Delete Message", chatId, token);

  const result = await sendMessage(
    token, chatId, "interactive",
    buildTextCard("🗑 Deleting...", "This message will be deleted in a few seconds...", "yellow")
  );

  const msgId = result.data?.message_id ?? "";
  if (!msgId) {
    await testResult(step, "Delete Message", false, "Cannot create test message");
    return true;
  }

  console.log(`  >>> Created message ${msgId}, deleting in 3 seconds...`);
  await sleep(3000);

  const delResult = await deleteMessage(token, msgId);
  if (delResult.code === 0) {
    await testResult(step, "Delete Message", true);
    console.log("  >>> Please check Feishu - the message should have disappeared");
  } else {
    await testResult(step, "Delete Message", false, delResult.msg ?? `code: ${delResult.code}`);
  }

  return true;
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // 单实例保证：杀旧 PID 文件进程，写自身 PID
  ensureSingleInstance(PID_FILE);
  freeRelayListenPort(18080);

  // 启动本地中继服务
  const { server: relayServer, broadcast } = createRelayServer(18080);
  broadcastToRelay = broadcast;

  const modeTag = USE_LOCAL ? " (local relay mode)" : "";
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Feishu Bot Integration Test Demo (TypeScript)${modeTag}`);
  console.log(`${"=".repeat(60)}`);
  console.log(`  App ID: ${APP_ID.slice(0, 10)}...`);
  console.log(`  Receive Timeout: ${RECEIVE_TIMEOUT_MS / 60000} minutes`);
  if (USE_LOCAL) console.log(`  Relay: ${LOCAL_RELAY_URL}`);
  console.log(`${"=".repeat(60)}`);

  if (!APP_ID || !APP_SECRET) {
    console.log("\nERROR: CHATCCC_APP_ID / CHATCCC_APP_SECRET not set");
    console.log("  Please configure the .env file in the project root.");
    process.exit(1);
  }

  // Step 1: Get token
  console.log("\nGetting access token...");
  const token = await getTenantAccessToken();
  log("✅", "Token obtained");

  // Step 2: Set up event handler and WebSocket
  const handler = new TestEventHandler();
  if (USE_LOCAL) {
    console.log("Connecting to local relay...");
    wsConnectLocal(handler).catch((err: Error) => {
      log("❌", `Local relay connection failed: ${err.message}`);
    });
  } else {
    console.log("Connecting to Feishu WebSocket (SDK)...");
    connectFeishuWS(handler);
  }
  await sleep(2000);

  // Step 3: Auto-detect chat_id from user's first message
  console.log(`\n${"=".repeat(60)}`);
  console.log("  Ready to start testing!");
  console.log("  Please use a PRIVATE CHAT with the bot for testing.");
  console.log(`  Total 13 test steps, each receive test waits up to ${RECEIVE_TIMEOUT_MS / 60000} minutes.`);
  console.log(`${"=".repeat(60)}`);

  console.log("\n  >>> FIRST: Please send ANY message to the bot in Feishu private chat");
  console.log("  >>> This will auto-detect your chat_id for subsequent tests");
  console.log("  ... Waiting for your first message (max " + (RECEIVE_TIMEOUT_MS / 60000) + " min) ...");

  let event: LarkEvent | null = null;
  let attempt = 0;
  while (!event && attempt < 360) {
    event = await handler.waitForEvent("im.message.receive_v1", 5000);
    attempt++;
  }

  if (!event) {
    console.log("ERROR: No message received. Exiting.");
    handler.stop();
    process.exit(1);
  }

  const evt = event.event ?? event;
  const chatId: string = evt.message?.chat_id ?? "";
  if (!chatId) {
    console.log("ERROR: Cannot extract chat_id from event. Exiting.");
    handler.stop();
    process.exit(1);
  }

  log("✅", `Detected chat_id: ${chatId}`);

  // Send welcome
  await sendMessage(
    token, chatId, "interactive",
    buildTextCard(
      "🚀 Test Starting",
      `Feishu bot integration test is about to begin!\n\n**Total: 13 test steps**\nEach receive test waits up to **${RECEIVE_TIMEOUT_MS / 60000} minutes**.\n\nPlease watch the console and follow instructions.\n\nStep 1 starting soon...`,
      "blue"
    )
  );
  await sleep(2000);

  // =========================================
  // Run all tests in sequence
  // =========================================

  function failFast(result: boolean | string): void {
    if (result === "timeout") {
      console.log("\nTest timed out. Exiting early.");
      handler.stop();
      relayServer.close();
      process.exit(1);
    }
  }

  // Receive tests (7) — only timeout exits early, content mismatch continues
  failFast(await testReceiveText(1, chatId, token, handler));
  await sleep(1000);
  failFast(await testReceivePost(2, chatId, token, handler));
  await sleep(1000);
  failFast(await testReceiveImage(3, chatId, token, handler));
  await sleep(1000);
  failFast(await testReceiveFile(4, chatId, token, handler));
  await sleep(1000);
  failFast(await testReceiveMedia(5, chatId, token, handler));
  await sleep(1000);
  failFast(await testReceiveAudio(6, chatId, token, handler));
  await sleep(1000);
  failFast(await testReceiveCardAction(7, chatId, token, handler));
  await sleep(1000);

  // Send tests (6)
  const { msgId: thinkingMsgId } = await testSendThinkingCard(8, chatId, token);
  await sleep(1000);
  await testSendStreamUpdate(9, chatId, token, thinkingMsgId);
  await sleep(1000);
  await testSendDoneCard(10, chatId, token);
  await sleep(1000);
  await testSendErrorCard(11, chatId, token);
  await sleep(1000);
  await testSendImage(12, chatId, token);
  await sleep(1000);
  await testDeleteMessage(13, chatId, token);

  // =========================================
  // Final report
  // =========================================
  console.log(`\n${"=".repeat(60)}`);
  console.log("  Test Complete!");
  console.log(`${"=".repeat(60)}`);

  const passed = testResults.filter((r) => r.success).length;
  const failed = testResults.filter((r) => !r.success).length;
  const total = testResults.length;

  const reportLines = [
    "📊 **Test Report**",
    "",
    `Total: ${total}`,
    `Passed: ${passed}`,
    `Failed: ${failed}`,
    "",
    "---",
    ...testResults.map(
      (r) => `${r.success ? "PASS" : "FAIL"}  ${r.name}${r.detail ? ` - ${r.detail}` : ""}`
    ),
  ];

  await sendMessage(
    token, chatId, "interactive",
    buildTextCard(
      `📊 Test Report (${passed}/${total} passed)`,
      reportLines.join("\n"),
      failed === 0 ? "green" : "yellow"
    )
  );

  console.log(`\n  Passed: ${passed}  Failed: ${failed}  Total: ${total}`);
  if (failed > 0) {
    console.log("  Some tests failed, check details above.");
  } else {
    console.log("  All tests passed!");
  }

  // Cleanup
  handler.stop();
  relayServer.close();
  process.exit(0);
}

main().catch((err: Error) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
