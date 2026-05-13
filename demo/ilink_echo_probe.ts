/**
 * OpenILink WeChat Echo Probe
 * ===========================
 * Minimal scan-login and text echo demo for the WeChat iLink channel.
 *
 * Usage:
 *   npm run demo:ilink-echo
 *
 * Behavior:
 *   When a user sends text to the logged-in WeChat account, this demo replies
 *   with "收到：" plus the received text.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Client as OpenIlinkWire,
  extractText,
  type GetUpdatesResponse,
  type WeixinMessage,
} from "@openilink/openilink-sdk-node";

import { setupFileLogging } from "../src/shared.ts";

interface TerminalQrRenderer {
  generate(
    input: string,
    opts: { small: boolean },
    callback: (qrcode: string) => void,
  ): void;
}

interface EchoProbeSnapshot {
  token?: string;
  baseUrl?: string;
  pollCursor?: string;
  botId?: string;
  userId?: string;
  lastSeenAt?: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const SNAPSHOT_PATH = join(PROJECT_ROOT, "state", "ilink-echo-probe.json");
const LOG_DIR = join(__dirname, "logs");
const requireFromDemo = createRequire(import.meta.url);
const terminalQr = requireFromDemo("qrcode-terminal") as TerminalQrRenderer;

setupFileLogging(LOG_DIR, "ilink-echo-probe");

let acceptingEvents = true;

function ensureParentDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

function readSnapshot(): EchoProbeSnapshot {
  if (!existsSync(SNAPSHOT_PATH)) {
    return {};
  }

  try {
    return JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as EchoProbeSnapshot;
  } catch (error) {
    console.warn(`Cannot read saved iLink probe state: ${(error as Error).message}`);
    return {};
  }
}

function writeSnapshot(snapshot: EchoProbeSnapshot): void {
  ensureParentDir(SNAPSHOT_PATH);
  writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);
}

function updateSnapshot(patch: Partial<EchoProbeSnapshot>): EchoProbeSnapshot {
  const next = {
    ...readSnapshot(),
    ...patch,
    lastSeenAt: new Date().toISOString(),
  };
  writeSnapshot(next);
  return next;
}

function peerKeyOf(message: WeixinMessage): string {
  return String(message.from_user_id ?? "");
}

function textOf(message: WeixinMessage): string {
  return extractText(message).trim();
}

function printScanMaterial(content: string): void {
  console.log("\n========== iLink scan content ==========");
  console.log(content);
  console.log("========== iLink terminal QR ==========");
  terminalQr.generate(content, { small: true }, (renderedQr) => {
    console.log(renderedQr);
  });
  console.log("========== end iLink QR ==========\n");
}

async function prepareProbeWire(saved: EchoProbeSnapshot): Promise<OpenIlinkWire> {
  const ilinkWire = new OpenIlinkWire("", {
    base_url: saved.baseUrl,
  });

  console.log("Starting iLink QR login. The QR is shown on every run.");
  const loginResult = await ilinkWire.loginWithQr({
    on_qrcode: (content) => {
      printScanMaterial(content);
    },
    on_scanned: () => {
      console.log("QR scanned. Confirm login in WeChat.");
    },
    on_expired: (attempt, maxAttempts) => {
      console.log(`QR expired, refreshing (${attempt}/${maxAttempts}).`);
    },
  });

  if (!loginResult.connected) {
    throw new Error(`iLink QR login failed: ${loginResult.message}`);
  }

  updateSnapshot({
    token: loginResult.bot_token ?? ilinkWire.token,
    baseUrl: loginResult.base_url ?? ilinkWire.baseUrl,
    botId: loginResult.bot_id,
    userId: loginResult.user_id,
    pollCursor: "",
  });

  console.log(`iLink login ready. BotID=${loginResult.bot_id ?? ""}`);
  return ilinkWire;
}

async function mirrorIncomingLine(
  ilinkWire: OpenIlinkWire,
  message: WeixinMessage,
): Promise<void> {
  const peerKey = peerKeyOf(message);
  if (!peerKey) {
    console.warn("Skip message without from_user_id.");
    return;
  }

  const incomingText = textOf(message);
  const outgoingText = incomingText ? `收到：${incomingText}` : "收到：[non-text message]";
  const contextToken = message.context_token;

  if (contextToken) {
    await ilinkWire.sendText(peerKey, outgoingText, contextToken);
  } else {
    await ilinkWire.push(peerKey, outgoingText);
  }

  console.log(`Echoed to ${peerKey}: ${outgoingText.slice(0, 120)}`);
}

function rememberPollingCursor(response: GetUpdatesResponse): void {
  const pollCursor = response.sync_buf ?? response.get_updates_buf;
  if (!pollCursor) {
    return;
  }
  updateSnapshot({ pollCursor });
}

function installStopHooks(): void {
  const stop = (): void => {
    if (!acceptingEvents) {
      return;
    }
    acceptingEvents = false;
    console.log("Stopping iLink echo probe...");
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

async function runProbe(): Promise<void> {
  installStopHooks();

  const saved = readSnapshot();
  const ilinkWire = await prepareProbeWire(saved);
  const latest = readSnapshot();

  console.log("Listening for WeChat messages. Send text to the small account.");
  console.log(`State file: ${SNAPSHOT_PATH}`);
  console.log(`Log dir: ${LOG_DIR}`);

  await ilinkWire.monitor(
    async (message) => {
      try {
        await mirrorIncomingLine(ilinkWire, message);
      } catch (error) {
        console.error(`Echo failed: ${(error as Error).stack ?? (error as Error).message}`);
      }
    },
    {
      initial_buf: latest.pollCursor ?? "",
      on_buf_update: (pollCursor) => updateSnapshot({ pollCursor }),
      on_response: rememberPollingCursor,
      on_error: (error) => {
        console.error(`iLink monitor error: ${error.stack ?? error.message}`);
      },
      on_session_expired: () => {
        console.error("iLink session expired. Restart with --fresh to scan again.");
        acceptingEvents = false;
      },
      should_continue: () => acceptingEvents,
    },
  );
}

runProbe().catch((error: Error) => {
  console.error(`Fatal iLink echo probe error: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
