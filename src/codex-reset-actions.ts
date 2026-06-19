import { randomUUID } from "node:crypto";

import { buildCodexResetConfirmCard } from "./cards.ts";
import type { CodexResetConsumeResult } from "./feishu-api.ts";

type CodexResetDecision = "yes" | "no";

interface PendingCodexResetRequest {
  chatId: string;
  parentMessageId: string;
  status: "pending" | "handled";
}

export interface CodexResetActionDeps {
  getTenantAccessToken(): Promise<string>;
  sendRawCard(token: string, chatId: string, cardJson: string): Promise<boolean>;
  sendTextReply(token: string, chatId: string, text: string): Promise<boolean>;
  sendCardReply(token: string, chatId: string, title: string, content: string, template?: string): Promise<boolean>;
  updateCardMessage(token: string, messageId: string, content: string): Promise<boolean>;
  recallMessage(token: string, messageId: string): Promise<boolean>;
  consumeCodexRateLimitResetCredit(redeemRequestId: string): Promise<CodexResetConsumeResult>;
  createRequestId?: () => string;
}

const pendingCodexResetRequests = new Map<string, PendingCodexResetRequest>();

function rawEvent(data: unknown): Record<string, unknown> {
  return ((data as Record<string, unknown>)?.event ?? data) as Record<string, unknown>;
}

function actionValue(raw: Record<string, unknown>): Record<string, unknown> | null {
  const action = raw.action as { value?: unknown } | undefined;
  const value = action?.value;
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function eventMessageId(raw: Record<string, unknown>): string {
  return typeof raw.open_message_id === "string"
    ? raw.open_message_id
    : typeof (raw.context as Record<string, unknown> | undefined)?.open_message_id === "string"
      ? (raw.context as Record<string, string>).open_message_id
      : typeof raw.message_id === "string"
        ? raw.message_id
        : typeof (raw.context as Record<string, unknown> | undefined)?.message_id === "string"
          ? (raw.context as Record<string, string>).message_id
          : typeof (raw.message as Record<string, unknown> | undefined)?.message_id === "string"
            ? (raw.message as Record<string, string>).message_id
            : "";
}

function eventChatId(raw: Record<string, unknown>): string {
  return typeof raw.open_chat_id === "string"
    ? raw.open_chat_id
    : typeof (raw.context as Record<string, unknown> | undefined)?.open_chat_id === "string"
      ? (raw.context as Record<string, string>).open_chat_id
      : typeof (raw.message as Record<string, unknown> | undefined)?.chat_id === "string"
        ? (raw.message as Record<string, string>).chat_id
        : "";
}

function collapsedCard(): string {
  return JSON.stringify({
    config: { wide_screen_mode: true },
    elements: [{ tag: "markdown", content: " " }],
  });
}

function resetResultMessage(result: CodexResetConsumeResult): { content: string; template: string } {
  if (result.code === "reset") {
    return {
      content: `重置成功。已重置 ${result.windowsReset} 个 Codex 用量窗口。`,
      template: "green",
    };
  }
  if (result.code === "nothing_to_reset") {
    return {
      content: "没有需要重置的 Codex 用量窗口。",
      template: "yellow",
    };
  }
  if (result.code === "no_credit") {
    return {
      content: "没有可用的 Codex 主动重置次数。",
      template: "red",
    };
  }
  return {
    content: "这次 Codex 主动重置请求已经处理过。",
    template: "yellow",
  };
}

async function sendResetRequestConfirmation(
  raw: Record<string, unknown>,
  value: Record<string, unknown>,
  deps: CodexResetActionDeps,
): Promise<boolean> {
  const parentMessageId = eventMessageId(raw);
  const chatId = eventChatId(raw);
  if (!parentMessageId || !chatId) return true;
  const availableCount = Number(value.availableCount);

  const requestId = (deps.createRequestId ?? randomUUID)();
  pendingCodexResetRequests.set(requestId, {
    chatId,
    parentMessageId,
    status: "pending",
  });

  const token = await deps.getTenantAccessToken();
  await deps.sendRawCard(token, chatId, buildCodexResetConfirmCard({
    availableCount: Number.isFinite(availableCount) ? Math.max(1, Math.trunc(availableCount)) : 1,
    parentMessageId,
    requestId,
  }));
  return true;
}

async function handleResetConfirmation(
  raw: Record<string, unknown>,
  value: Record<string, unknown>,
  deps: CodexResetActionDeps,
): Promise<boolean> {
  const decision = value.decision;
  const requestId = value.requestId;
  const parentMessageId = value.parentMessageId;
  if ((decision !== "yes" && decision !== "no") || typeof requestId !== "string" || typeof parentMessageId !== "string") {
    return true;
  }

  const token = await deps.getTenantAccessToken();
  const confirmMessageId = eventMessageId(raw);
  if (confirmMessageId) {
    const collapsed = await deps.updateCardMessage(token, confirmMessageId, collapsedCard());
    console.log(`[Codex Reset] collapse confirmation card ${collapsed ? "OK" : "FAILED"}: messageId=${confirmMessageId}`);
    const recalled = await deps.recallMessage(token, confirmMessageId);
    console.log(`[Codex Reset] recall confirmation card ${recalled ? "OK" : "FAILED"}: messageId=${confirmMessageId}`);
  } else {
    console.error("[Codex Reset] missing confirmation card message id; cannot collapse");
  }

  const pending = pendingCodexResetRequests.get(requestId);
  const chatId = pending?.chatId ?? eventChatId(raw);
  if (!chatId) return true;

  if (!pending || pending.status !== "pending" || pending.parentMessageId !== parentMessageId) {
    await deps.sendTextReply(token, chatId, "Codex 主动重置：这张确认卡片已经失效或已处理。");
    return true;
  }
  pending.status = "handled";

  if (decision === "no") {
    await deps.sendTextReply(token, chatId, "Codex 主动重置：用户取消了重置。");
    return true;
  }

  try {
    const result = await deps.consumeCodexRateLimitResetCredit(requestId);
    const message = resetResultMessage(result);
    await deps.sendTextReply(token, chatId, `Codex 主动重置：${message.content}`);
  } catch (err) {
    await deps.sendTextReply(token, chatId, `Codex 主动重置失败：${(err as Error).message}`);
  }
  return true;
}

export async function handleCodexResetCardAction(data: unknown, deps: CodexResetActionDeps): Promise<boolean> {
  const raw = rawEvent(data);
  const value = actionValue(raw);
  if (!value) return false;
  const action = value?.action;
  if (action === "codex_reset_request") {
    return sendResetRequestConfirmation(raw, value, deps);
  }
  if (action === "codex_reset_confirm") {
    return handleResetConfirmation(raw, value, deps);
  }
  return false;
}

export function _resetCodexResetRequestsForTest(): void {
  pendingCodexResetRequests.clear();
}
