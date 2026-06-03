/**
 * format-message.ts — 飞书消息内容格式化
 *
 * 从 index.ts 中提取，独立模块便于测试。
 */

import { cardJsonToPlainText } from "./card-plain-text.ts";
import { ts } from "./config.ts";
import {
  getTenantAccessToken,
  getOrDownloadImage,
  getMergeForwardMessages,
} from "./feishu-platform.ts";

/**
 * 根据消息类型格式化消息内容为可读文本。
 */
export async function formatMessageContent(message: {
  message_id?: string;
  message_type?: string;
  content?: string;
}): Promise<string> {
  const contentStr = message.content ?? "{}";
  let content: Record<string, unknown>;
  try { content = JSON.parse(contentStr); } catch {
    // merge_forward 消息的 content 可能为空字符串，但可通过 message_id 调 API 获取子消息
    if (message.message_type === "merge_forward") {
      content = {};
    } else {
      return "";
    }
  }

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
      console.error(
        `[${ts()}] [IMAGE] download failed for ${imageKey}: ${(err as Error).message}`,
      );
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

  if (message.message_type === "file") {
    const fileKey = content.file_key as string | undefined;
    const fileName = (content.file_name as string) || "download.bin";
    const messageId = message.message_id;
    if (!fileKey || !messageId) return contentStr;
    return `[文件] message_id=${messageId} file_key=${fileKey} file_name=${fileName}`;
  }

  if (message.message_type === "interactive") {
    const raw = JSON.stringify(content);
    const text = cardJsonToPlainText(raw);
    if (text) return `[卡片] ${text}`;
    return contentStr;
  }

  if (message.message_type === "merge_forward") {
    return formatMergeForward(message.message_id ?? "", content);
  }

  // 其他类型（audio, sticker 等）直接给原始 JSON
  return contentStr;
}

export function formatPostContent(content: Record<string, unknown>): string {
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
// 合并转发消息格式化
// ---------------------------------------------------------------------------

/**
 * 格式化合并转发消息。
 *
 * 三阶段降级策略：
 * 1. 调用 GET /im/v1/messages/{messageId} 获取完整子消息列表
 * 2. API 失败时降级使用 content.preview 字段
 * 3. preview 也为空时返回原始 JSON
 *
 * 递归深度限制 MAX_DEPTH=3，避免嵌套合并转发 API 爆炸。
 */
export async function formatMergeForward(
  messageId: string,
  content: Record<string, unknown>,
  depth: number = 0,
): Promise<string> {
  const MAX_DEPTH = 3;
  if (depth >= MAX_DEPTH) {
    return `[合并转发: 超出最大嵌套深度 ${MAX_DEPTH}]`;
  }

  const title = (content.title as string) || "聊天记录";
  const chatName = (content.chat_name as string) || "";
  const header = `[合并转发: ${title}${chatName ? ` (${chatName})` : ""}]`;

  // 从 preview 构建 sender ID → name 映射表
  const senderNameMap = new Map<string, string>();
  const preview = content.preview;
  if (Array.isArray(preview)) {
    for (const entry of preview) {
      const e = entry as Record<string, unknown>;
      const s = e.sender as Record<string, unknown> | undefined;
      if (s && typeof s.id === "string" && typeof s.name === "string") {
        senderNameMap.set(s.id, s.name);
      }
    }
  }

  const lines: string[] = [];
  let usedApi = false;

  // Phase 1: 尝试通过 API 获取完整子消息列表
  try {
    const token = await getTenantAccessToken();
    const items = await getMergeForwardMessages(token, messageId);

    // 跳过第一个 item（合并转发消息自身，无 upper_message_id）
    const subItems = items.filter((item) => item.upper_message_id);

    if (subItems.length > 0) {
      for (const item of subItems) {
        const senderId = item.sender?.id ?? "unknown";
        const senderName = senderNameMap.get(senderId) ?? senderId;

        const subMsgType = item.msg_type ?? "";
        const subContent = item.body?.content ?? "{}";

        try {
          const formatted = await formatMessageContent({
            message_id: item.message_id,
            message_type: subMsgType,
            content: subContent,
          });
          lines.push(`${senderName}: ${formatted}`);
        } catch {
          lines.push(`${senderName}: ${subContent}`);
        }
      }
      usedApi = true;
    }
  } catch (err) {
    console.error(
      `[${ts()}] [MERGE_FORWARD] API 获取子消息失败 (${messageId}), 降级使用 preview: ${(err as Error).message}`,
    );
  }

  // Phase 2: API 失败或返回空时降级使用 preview
  if (!usedApi) {
    if (Array.isArray(preview) && preview.length > 0) {
      for (const entry of preview) {
        const e = entry as Record<string, unknown>;
        const s = e.sender as Record<string, unknown> | undefined;
        const senderName = (s?.name as string) ?? "未知用户";
        const text = (e.content as string) ?? "";
        lines.push(`${senderName}: ${text}`);
      }
    }
  }

  // Phase 3: 没有任何内容时返回原始 JSON
  if (lines.length === 0) {
    return JSON.stringify(content);
  }

  return header + "\n" + lines.join("\n");
}