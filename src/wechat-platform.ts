/**
 * wechat-platform.ts — WeChat iLink 平台适配器
 *
 * 基于 @openilink/openilink-sdk-node，提供：
 *   - QR 登录（每次启动强制显示新 QR）
 *   - 长轮询消息接收
 *   - PlatformAdapter 实现（纯文本、不支持卡片/群管理）
 *   - 自动重连
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, extname, join } from "node:path";
import { homedir } from "node:os";

import {
  Client as OpenIlinkWire,
  extractText,
  type GetUpdatesResponse,
  type WeixinMessage,
} from "@openilink/openilink-sdk-node";
import type { FileItem, ImageItem, VideoItem } from "@openilink/openilink-sdk-node";

import type { PlatformAdapter } from "./platform-adapter.ts";
import { setupFileLogging } from "./shared.ts";
import { appendChatLog } from "./config.ts";
import { cardJsonToPlainText } from "./card-plain-text.ts";
import { applyPrivacy } from "./privacy.ts";

interface TerminalQrRenderer {
  generate(
    input: string,
    opts: { small: boolean },
    callback: (qrcode: string) => void,
  ): void;
}

interface IlinkSnapshot {
  token?: string;
  baseUrl?: string;
  pollCursor?: string;
  botId?: string;
  userId?: string;
  lastSeenAt?: string;
  lastChatId?: string;
  contextToken?: string;
}

const USER_DATA_DIR = join(homedir(), ".chatccc");
const ILINK_AUTH_PATH = join(USER_DATA_DIR, "state", "ilink-auth.json");
const ILINK_LOG_DIR = join(USER_DATA_DIR, "logs");

const requireFromWechat = createRequire(import.meta.url);
const terminalQr = requireFromWechat("qrcode-terminal") as TerminalQrRenderer;

const { logPath: WECHAT_LOG_PATH } =
  setupFileLogging(ILINK_LOG_DIR, "wechat");

let ilinkWire: OpenIlinkWire | null = null;

/** 获取当前 iLink wire 实例（供外部脚本/测试使用） */
export function getIlinkWire(): OpenIlinkWire | null {
  return ilinkWire;
}
/** chatId → 最新 context_token */
const contextTokenMap = new Map<string, string>();
/** chatId → 用户未回复时已连发消息数 */
const consecutiveSendCount = new Map<string, number>();
/** chatId → 上一次 sendText 成功的时间戳 */
const lastSendTimeMap = new Map<string, number>();
const textCardMap = new Map<string, { chatId?: string; text: string; lastSentText: string; lastSentAt: number }>();
let textCardSeq = 0;
let platformLog: (msg: string) => void = () => {};

const TEXT_CARD_UPDATE_INTERVAL_MS = 30_000;

/** 微信连发间隔阈值：第5条起限制 ≥ 此值（默认10秒），测试可覆写 */
let wxMinSendIntervalMs = 10_000;
export function _setWxMinSendIntervalMsForTest(ms: number): void {
  wxMinSendIntervalMs = ms;
}

type WechatWireSender = Pick<OpenIlinkWire, "sendText" | "push">;

export interface WechatAdapterOptions {
  getWire?: () => WechatWireSender | null;
  log?: (msg: string) => void;
}

function isTerminalCardText(text: string): boolean {
  return text.startsWith("# 完成") || text.startsWith("# 已停止");
}

function isFinalReplyText(text: string): boolean {
  return text.includes("━━━ 回答结束 ━━━");
}

export function compressGeneratingText(text: string): string {
  const lines = text.split("\n");
  if (lines.length <= 10) return text;
  return [...lines.slice(0, 5), "...", ...lines.slice(-5)].join("\n");
}

async function sendWechatTextRaw(wire: WechatWireSender, chatId: string, text: string): Promise<void> {
  const contextToken = contextTokenMap.get(chatId);
  if (contextToken) {
    await wire.sendText(chatId, text, contextToken);
  } else {
    await wire.push(chatId, text);
  }
}

export function _resetWechatClawStateForTest(): void {
  consecutiveSendCount.clear();
  contextTokenMap.clear();
  lastSendTimeMap.clear();
}

// ---------------------------------------------------------------------------
// Snapshot 持久化
// ---------------------------------------------------------------------------

function ensureParentDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

function readSnapshot(): IlinkSnapshot {
  if (!existsSync(ILINK_AUTH_PATH)) return {};
  try {
    return JSON.parse(readFileSync(ILINK_AUTH_PATH, "utf8")) as IlinkSnapshot;
  } catch {
    return {};
  }
}

function writeSnapshot(snapshot: IlinkSnapshot): void {
  ensureParentDir(ILINK_AUTH_PATH);
  writeFileSync(ILINK_AUTH_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);
}

function updateSnapshot(patch: Partial<IlinkSnapshot>): IlinkSnapshot {
  const next = { ...readSnapshot(), ...patch, lastSeenAt: new Date().toISOString() };
  writeSnapshot(next);
  return next;
}

// ---------------------------------------------------------------------------
// QR 终端输出
// ---------------------------------------------------------------------------

function printScanMaterial(content: string): void {
  platformLog("\n========== 微信 iLink 扫码内容 ==========");
  platformLog(content);
  platformLog("========== 终端二维码 ==========");
  terminalQr.generate(content, { small: true }, (renderedQr) => {
    platformLog(renderedQr);
  });
  platformLog("========== 请使用微信扫描上方二维码登录 ==========\n");
}

// ---------------------------------------------------------------------------
// WeChat PlatformAdapter 工厂
// ---------------------------------------------------------------------------

export function createWechatAdapter(
  options: WechatAdapterOptions = {},
): PlatformAdapter {
  const getWire = options.getWire ?? (() => ilinkWire);
  const log = options.log ?? ((msg: string) => platformLog(msg));

  return {
    kind: "wechat",

    // ---- 基础消息 ----
    async sendText(chatId, text) {
      const wire = getWire();
      if (!wire) return false;

      text = applyPrivacy(text);

      // 微信 claw 连发限制：统计用户未回复时已连发条数
      const count = (consecutiveSendCount.get(chatId) ?? 0) + 1;
      consecutiveSendCount.set(chatId, count);

      const isFinal = isFinalReplyText(text);

      // 第9条且非最终消息：附加 claw 限制提示，此后禁止继续发送生成消息
      if (count === 9 && !isFinal) {
        text = text + "\n---由于微信claw机制限制，不再发送过程，稍后把最终结果发送给你---";
      }

      // 超过9条后不允许发送非最终消息（生成消息），最终结果消息仍然允许
      if (count > 9 && !isFinal) {
        log(`[WECHAT] sendText skipped (claw limit): chatId=${chatId} count=${count}`);
        return false;
      }

      // 第5条起限制发送间隔 ≥ 10 秒（前4条保持原有 3s 显示循环节奏）
      if (count > 4) {
        const lastSentAt = lastSendTimeMap.get(chatId) ?? 0;
        const elapsed = Date.now() - lastSentAt;
        if (elapsed < wxMinSendIntervalMs) {
          await new Promise((r) => setTimeout(r, wxMinSendIntervalMs - elapsed));
        }
      }

      try {
        await sendWechatTextRaw(wire, chatId, text);
        lastSendTimeMap.set(chatId, Date.now());
        const preview = text.length > 60 ? text.slice(0, 60) + "..." : text;
        log(`[WECHAT] sendText OK: chatId=${chatId} len=${text.length} count=${count} text="${preview}"`);
        return true;
      } catch (err) {
        log(`[WECHAT] sendText failed: ${(err as Error).message}`);
        return false;
      }
    },

    async sendCard(chatId, title, content, _template) {
      // WeChat has no card renderer here; send the same message as plain text.
      const text = [title.trim(), content.trim()].filter(Boolean).join("\n\n");
      return this.sendText(chatId, text);
    },

    async sendRawCard(chatId, cardJson) {
      const text = cardJsonToPlainText(cardJson);
      if (!text) {
        log(`[WECHAT] sendRawCard text fallback failed: empty card text`);
        return false;
      }
      log(`[WECHAT] sendRawCard degraded to text`);
      return this.sendText(chatId, text);
    },

    // ---- 群聊管理 ----
    async createGroup(_name, _userIds) {
      throw new Error("微信不支持创建群聊");
    },

    async updateChatInfo(_chatId, _name, _description) {
      // 微信不支持修改群信息，静默成功
    },

    async getChatInfo(_chatId) {
      return { name: "微信会话", description: "" };
    },

    async disbandChat(_chatId) {
      // 微信不支持解散群聊
    },

    async setChatAvatar(_chatId, _tool, _status) {
      // 微信不支持设置头像
    },

    extractSessionInfo(_description) {
      // 微信没有群描述机制，session 绑定走 session-registry
      return null;
    },

    // ---- 进度展示（微信无卡片，降级为文本） ----
    async cardCreate(cardJson) {
      const text = cardJsonToPlainText(cardJson);
      if (!text) {
        log(`[WECHAT] cardCreate text fallback failed: empty card text`);
        return null;
      }
      const cardId = `wechat-text-card-${Date.now()}-${++textCardSeq}`;
      textCardMap.set(cardId, {
        text,
        lastSentText: "",
        lastSentAt: 0,
      });
      log(`[WECHAT] cardCreate degraded to text card: ${cardId}`);
      return cardId;
    },

    async cardSend(chatId, cardId) {
      const entry = textCardMap.get(cardId);
      if (!entry) {
        log(`[WECHAT] cardSend text fallback failed: missing card ${cardId}`);
        return "";
      }
      entry.chatId = chatId;
      const compressed = compressGeneratingText(entry.text);
      const ok = await this.sendText(chatId, compressed);
      if (!ok) return "";
      entry.lastSentText = entry.text;
      entry.lastSentAt = Date.now();
      log(`[WECHAT] cardSend degraded to text: ${cardId}`);
      return `wechat-text-message-${cardId}`;
    },

    async cardUpdate(cardId, cardJson, _sequence) {
      const entry = textCardMap.get(cardId);
      if (!entry || !entry.chatId) {
        log(`[WECHAT] cardUpdate text fallback skipped: missing sent card ${cardId}`);
        return;
      }
      const text = cardJsonToPlainText(cardJson);
      if (!text || text === entry.lastSentText) return;

      const now = Date.now();
      const terminal = isTerminalCardText(text);
      if (!terminal && now - entry.lastSentAt < TEXT_CARD_UPDATE_INTERVAL_MS) {
        entry.text = text;
        return;
      }

      // 非终端卡片（生成中）：只发送新增部分（delta），不重发已发送的内容
      let sendText: string;
      if (!terminal && entry.lastSentText && text.startsWith(entry.lastSentText)) {
        sendText = text.slice(entry.lastSentText.length).trim();
        if (!sendText) {
          entry.text = text;
          return;
        }
      } else {
        sendText = text;
      }

      entry.text = text;
      const compressed = compressGeneratingText(sendText);
      const ok = await this.sendText(entry.chatId, compressed);
      if (!ok) return;
      entry.lastSentText = text;
      entry.lastSentAt = now;
      if (terminal) textCardMap.delete(cardId);
      log(`[WECHAT] cardUpdate degraded to text: ${cardId}`);
    },
  };
}

// ---------------------------------------------------------------------------
// 消息接收与路由
// ---------------------------------------------------------------------------

type MessageHandler = (
  text: string,
  chatId: string,
  openId: string,
  msgTimestamp: number,
  chatType: string,
  traceId?: string,
) => Promise<void>;

/**
 * 启动微信 iLink 平台。
 *
 * 若 reuseTokenOnStart 为 true 且上次保存的 token 仍然有效，则跳过 QR 直接复用；
 * 否则显示 QR 码等待扫码登录。
 * 接收到的消息统一交给 handler 处理（即 orchestrator.handleCommand）。
 *
 * 返回永不 resolve（除非主动停止或会话过期），由调用方 supervisor 管理。
 */
export async function startWechatPlatform(
  handler: MessageHandler,
  signal: { stopped: boolean },
  reuseTokenOnStart: boolean,
): Promise<void> {
  platformLog = (msg: string) => {
    console.log(`[WX:${new Date().toISOString().slice(0, 19).replace("T", " ")}] ${msg}`);
  };

  platformLog(
    `日志文件: ${WECHAT_LOG_PATH}`,
  );

  const saved = readSnapshot();
  platformLog(`上次登录: ${saved.lastSeenAt ?? "无记录"}`);

  // 尝试复用已保存的 token
  if (reuseTokenOnStart && saved.token && saved.baseUrl) {
    platformLog("检测到已保存的 token，尝试复用...");
    ilinkWire = new OpenIlinkWire(saved.token, {
      base_url: saved.baseUrl,
    });

    try {
      const probeResp = await ilinkWire.getUpdates(saved.pollCursor ?? "", 5000);
      if (probeResp.ret === 0 || probeResp.errcode === 0 || probeResp.msgs !== undefined) {
        platformLog("token 有效，跳过扫码。");
        updateSnapshot({ lastSeenAt: new Date().toISOString() });
        const latest = readSnapshot();
        // 恢复 context token 到内存
        if (latest.contextToken && latest.lastChatId) {
          contextTokenMap.set(latest.lastChatId, latest.contextToken);
        }
        await ilinkWire.monitor(
          async (message: WeixinMessage) => {
            try {
              await handleWechatMessage(message, handler);
            } catch (error) {
              platformLog(
                `消息处理失败: ${(error as Error).stack ?? (error as Error).message}`,
              );
            }
          },
          {
            initial_buf: probeResp.sync_buf ?? probeResp.get_updates_buf ?? latest.pollCursor ?? "",
            on_buf_update: (pollCursor) => updateSnapshot({ pollCursor }),
            on_response: (response: GetUpdatesResponse) => {
              const pollCursor =
                response.sync_buf ?? response.get_updates_buf;
              if (pollCursor) {
                updateSnapshot({ pollCursor });
              }
            },
            on_error: (error) => {
              platformLog(
                `iLink 监听错误: ${error.stack ?? error.message}`,
              );
            },
            on_session_expired: () => {
              platformLog("微信 iLink 会话已过期，需要重新扫码登录。");
              signal.stopped = true;
            },
            should_continue: () => !signal.stopped,
          },
        );
        return;
      }
      platformLog(`token 验证失败 (ret=${probeResp.ret} errcode=${probeResp.errcode})，回退到扫码登录。`);
    } catch (err) {
      platformLog(`token 探测失败: ${(err as Error).message}，回退到扫码登录。`);
    }
  }

  // 请求新 QR
  platformLog("启动微信 iLink QR 登录...");
  ilinkWire = new OpenIlinkWire("", {
    base_url: saved.baseUrl,
  });

  const loginResult = await ilinkWire.loginWithQr({
    on_qrcode: (content) => {
      printScanMaterial(content);
    },
    on_scanned: () => {
      platformLog("QR 已扫描，请在微信中确认登录。");
    },
    on_expired: (attempt, maxAttempts) => {
      platformLog(`QR 已过期，正在刷新 (${attempt}/${maxAttempts})。`);
    },
  });

  if (!loginResult.connected) {
    throw new Error(`微信 iLink QR 登录失败: ${loginResult.message}`);
  }

  updateSnapshot({
    token: loginResult.bot_token ?? ilinkWire.token,
    baseUrl: loginResult.base_url ?? ilinkWire.baseUrl,
    botId: loginResult.bot_id,
    userId: loginResult.user_id,
    pollCursor: "",
  });

  platformLog(
    `微信 iLink 登录成功。BotID=${loginResult.bot_id ?? ""} UserID=${loginResult.user_id ?? ""}`,
  );

  // 监听消息
  const latest = readSnapshot();
  // 恢复 context token 到内存
  if (latest.contextToken && latest.lastChatId) {
    contextTokenMap.set(latest.lastChatId, latest.contextToken);
  }

  await ilinkWire.monitor(
    async (message: WeixinMessage) => {
      try {
        await handleWechatMessage(message, handler);
      } catch (error) {
        platformLog(
          `消息处理失败: ${(error as Error).stack ?? (error as Error).message}`,
        );
      }
    },
    {
      initial_buf: latest.pollCursor ?? "",
      on_buf_update: (pollCursor) => updateSnapshot({ pollCursor }),
      on_response: (response: GetUpdatesResponse) => {
        const pollCursor =
          response.sync_buf ?? response.get_updates_buf;
        if (pollCursor) {
          updateSnapshot({ pollCursor });
        }
      },
      on_error: (error) => {
        platformLog(
          `iLink 监听错误: ${error.stack ?? error.message}`,
        );
      },
      on_session_expired: () => {
        platformLog("微信 iLink 会话已过期，需要重新扫码登录。");
        signal.stopped = true;
      },
      should_continue: () => !signal.stopped,
    },
  );
}

const WECHAT_IMAGE_DOWNLOAD_DIR = join(homedir(), ".chatccc", "images", "downloads");
const WECHAT_FILE_DOWNLOAD_DIR = join(homedir(), ".chatccc", "files", "downloads");
const WECHAT_VIDEO_DOWNLOAD_DIR = join(homedir(), ".chatccc", "videos", "downloads");

type WechatMediaDownloader = Pick<OpenIlinkWire, "downloadMedia">;

interface WechatMediaDownloadOptions {
  wire?: WechatMediaDownloader | null;
  imageDir?: string;
  fileDir?: string;
  videoDir?: string;
  log?: (msg: string) => void;
}

interface WechatDownloadedMediaAttachments {
  imagePaths: string[];
  filePaths: string[];
  videoPaths: string[];
  messageLines: string[];
}

function extFromMimeOrName(
  mime?: string | null,
  fileName?: string | null,
  fallback = ".bin",
): string {
  if (mime) {
    const map: Record<string, string> = {
      "image/png": ".png",
      "image/jpeg": ".jpg",
      "image/webp": ".webp",
      "image/gif": ".gif",
      "image/bmp": ".bmp",
      "image/svg+xml": ".svg",
      "video/mp4": ".mp4",
      "video/quicktime": ".mov",
      "video/x-msvideo": ".avi",
      "video/x-matroska": ".mkv",
      "video/webm": ".webm",
      "video/x-flv": ".flv",
      "text/plain": ".txt",
      "text/csv": ".csv",
      "application/pdf": ".pdf",
      "application/zip": ".zip",
      "application/gzip": ".gz",
    };
    const key = mime.split(";")[0].trim().toLowerCase();
    if (map[key]) return map[key];
  }
  if (fileName) {
    const ext = extname(fileName).toLowerCase();
    if (ext) return ext;
  }
  return fallback;
}

async function downloadWechatImage(
  imageItem: ImageItem,
  msgId?: number,
  options: WechatMediaDownloadOptions = {},
): Promise<string> {
  const wire = options.wire ?? ilinkWire;
  if (!wire) throw new Error("iLink wire not available");
  if (!imageItem.media) throw new Error("image item has no media");

  const data = await wire.downloadMedia(imageItem.media);
  const mime = (imageItem as Record<string, unknown>).mime_type as string | undefined;
  const fileName = (imageItem as Record<string, unknown>).file_name as string | undefined;
  const ext = extFromMimeOrName(mime, fileName, ".png");
  const key = imageItem.media.aes_key?.slice(0, 16) ?? (msgId?.toString() ?? Date.now().toString());
  const downloadDir = options.imageDir ?? WECHAT_IMAGE_DOWNLOAD_DIR;
  mkdirSync(downloadDir, { recursive: true });
  const localPath = join(downloadDir, `wx_${key}${ext}`);
  writeFileSync(localPath, data);
  platformLog(`图片已下载: ${localPath}`);
  return localPath;
}

function safeLocalFileName(fileName: string): string {
  return basename(fileName).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
}

async function downloadWechatFile(
  fileItem: FileItem,
  msgId?: number,
  options: WechatMediaDownloadOptions = {},
): Promise<string> {
  const wire = options.wire ?? ilinkWire;
  if (!wire) throw new Error("iLink wire not available");
  if (!fileItem.media) throw new Error("file item has no media");

  const data = await wire.downloadMedia(fileItem.media);
  const mime = (fileItem as Record<string, unknown>).mime_type as string | undefined;
  const ext = extFromMimeOrName(mime, fileItem.file_name, ".bin");
  const key =
    fileItem.md5?.slice(0, 16) ??
    fileItem.media.aes_key?.slice(0, 16) ??
    (msgId?.toString() ?? Date.now().toString());
  const localName = fileItem.file_name
    ? `wx_${key}_${safeLocalFileName(fileItem.file_name)}`
    : `wx_${key}${ext}`;
  const downloadDir = options.fileDir ?? WECHAT_FILE_DOWNLOAD_DIR;
  mkdirSync(downloadDir, { recursive: true });
  const localPath = join(downloadDir, localName);
  writeFileSync(localPath, data);
  (options.log ?? platformLog)(`文件已下载: ${localPath}`);
  return localPath;
}

async function downloadWechatVideo(
  videoItem: VideoItem,
  msgId?: number,
  options: WechatMediaDownloadOptions = {},
): Promise<string> {
  const wire = options.wire ?? ilinkWire;
  if (!wire) throw new Error("iLink wire not available");
  if (!videoItem.media) throw new Error("video item has no media");

  const data = await wire.downloadMedia(videoItem.media);
  const mime = (videoItem as Record<string, unknown>).mime_type as string | undefined;
  const fileName = (videoItem as Record<string, unknown>).file_name as string | undefined;
  const ext = extFromMimeOrName(mime, fileName, ".mp4");
  const key =
    videoItem.video_md5?.slice(0, 16) ??
    videoItem.media.aes_key?.slice(0, 16) ??
    (msgId?.toString() ?? Date.now().toString());
  const downloadDir = options.videoDir ?? WECHAT_VIDEO_DOWNLOAD_DIR;
  mkdirSync(downloadDir, { recursive: true });
  const localPath = join(downloadDir, `wx_${key}${ext}`);
  writeFileSync(localPath, data);
  (options.log ?? platformLog)(`视频已下载: ${localPath}`);
  return localPath;
}

async function downloadWechatMediaAttachments(
  message: WeixinMessage,
  options: WechatMediaDownloadOptions = {},
): Promise<WechatDownloadedMediaAttachments> {
  const imagePaths: string[] = [];
  const filePaths: string[] = [];
  const videoPaths: string[] = [];
  const messageLines: string[] = [];
  const items = message.item_list;
  if (items) {
    for (const item of items) {
      if (item.image_item?.media) {
        try {
          const localPath = await downloadWechatImage(item.image_item, message.message_id, options);
          imagePaths.push(localPath);
          messageLines.push(`[图片] ${localPath}`);
        } catch (err) {
          (options.log ?? platformLog)(`图片下载失败: ${(err as Error).message}`);
        }
      }

      if (item.file_item?.media) {
        try {
          const localPath = await downloadWechatFile(item.file_item, message.message_id, options);
          filePaths.push(localPath);
          messageLines.push(`[文件] ${localPath}`);
        } catch (err) {
          (options.log ?? platformLog)(`文件下载失败: ${(err as Error).message}`);
        }
      }

      if (item.video_item?.media) {
        try {
          const localPath = await downloadWechatVideo(item.video_item, message.message_id, options);
          videoPaths.push(localPath);
          messageLines.push(`[视频] ${localPath}`);
        } catch (err) {
          (options.log ?? platformLog)(`视频下载失败: ${(err as Error).message}`);
        }
      }
    }
  }

  return {
    imagePaths,
    filePaths,
    videoPaths,
    messageLines,
  };
}

export async function _downloadWechatMediaAttachmentsForTest(
  message: WeixinMessage,
  options: WechatMediaDownloadOptions,
): Promise<WechatDownloadedMediaAttachments> {
  return downloadWechatMediaAttachments(message, options);
}

async function handleWechatMessage(
  message: WeixinMessage,
  handler: MessageHandler,
): Promise<void> {
  const chatId = String(message.from_user_id ?? "");
  if (!chatId) {
    platformLog("跳过无 from_user_id 的消息");
    return;
  }

  // 保存 lastChatId 供下次启动时发送通知
  const current = readSnapshot();
  if (current.lastChatId !== chatId) {
    updateSnapshot({ lastChatId: chatId });
  }

  // 保存 context_token 到 snapshot（供重启后启动通知使用）和内存
  if (message.context_token) {
    contextTokenMap.set(chatId, message.context_token);
    updateSnapshot({ contextToken: message.context_token, lastChatId: chatId });
  }

  const text = extractText(message).trim();
  const msgTimestamp = message.create_time_ms ?? Date.now();

  const mediaAttachments = await downloadWechatMediaAttachments(message);

  // 构建消息文本：文本内容 + 媒体路径
  let fullText = text;
  if (mediaAttachments.messageLines.length > 0) {
    const mediaLines = mediaAttachments.messageLines.join("\n");
    fullText = fullText ? `${fullText}\n${mediaLines}` : mediaLines;
  }

  // 纯媒体且无可下载内容时跳过（避免空消息触发会话）
  if (!fullText.trim()) {
    platformLog(`跳过纯媒体消息（无文本）: chatId=${chatId}`);
    return;
  }

  platformLog(
    `收到消息: chatId=${chatId} text="${text.slice(0, 80)}" images=${mediaAttachments.imagePaths.length} files=${mediaAttachments.filePaths.length} videos=${mediaAttachments.videoPaths.length}`,
  );
  appendChatLog(chatId, chatId, fullText);

  // 用户回复，重置 claw 连发计数
  consecutiveSendCount.set(chatId, 0);

  // WeChat 中所有会话都视为 p2p，/new 复用 p2p 路径（等同飞书 /newh 效果）
  // 不 await：避免长 prompt 阻塞后续消息处理（如 /cd、/stop 等命令）
  handler(fullText, chatId, chatId, msgTimestamp, "p2p").catch((err) => {
    platformLog(`消息处理失败: ${(err as Error).stack ?? (err as Error).message}`);
  });
}
