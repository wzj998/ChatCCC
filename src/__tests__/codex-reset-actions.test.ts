import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetCodexResetRequestsForTest,
  handleCodexResetCardAction,
  type CodexResetActionDeps,
} from "../codex-reset-actions.ts";

function deps(): CodexResetActionDeps & {
  getTenantAccessToken: ReturnType<typeof vi.fn>;
  sendRawCard: ReturnType<typeof vi.fn>;
  sendTextReply: ReturnType<typeof vi.fn>;
  sendCardReply: ReturnType<typeof vi.fn>;
  updateCardMessage: ReturnType<typeof vi.fn>;
  recallMessage: ReturnType<typeof vi.fn>;
  consumeCodexRateLimitResetCredit: ReturnType<typeof vi.fn>;
  createRequestId: ReturnType<typeof vi.fn>;
} {
  return {
    getTenantAccessToken: vi.fn(async () => "tenant-token"),
    sendRawCard: vi.fn(async () => true),
    sendTextReply: vi.fn(async () => true),
    sendCardReply: vi.fn(async () => true),
    updateCardMessage: vi.fn(async () => true),
    recallMessage: vi.fn(async () => true),
    consumeCodexRateLimitResetCredit: vi.fn(async () => ({ code: "reset" as const, windowsReset: 2 })),
    createRequestId: vi.fn(() => "request-1"),
  };
}

function event(value: Record<string, unknown>, messageId: string) {
  return {
    event: {
      open_message_id: messageId,
      open_chat_id: "chat-1",
      operator: { open_id: "ou-user" },
      action: { value },
    },
  };
}

describe("Codex reset card actions", () => {
  beforeEach(() => {
    _resetCodexResetRequestsForTest();
  });

  it("sends a confirmation card tied to the clicked usage card", async () => {
    const d = deps();

    await expect(handleCodexResetCardAction(
      event({ action: "codex_reset_request" }, "usage-message"),
      d,
    )).resolves.toBe(true);

    expect(d.sendRawCard).toHaveBeenCalledTimes(1);
    expect(d.sendRawCard.mock.calls[0][1]).toBe("chat-1");
    const confirmCard = JSON.parse(d.sendRawCard.mock.calls[0][2]);
    const action = confirmCard.elements.find((element: any) => element.tag === "action");
    expect(action.actions[0].value).toEqual({
      action: "codex_reset_confirm",
      decision: "yes",
      parentMessageId: "usage-message",
      requestId: "request-1",
    });
  });

  it("consumes a reset credit, sends the result, and collapses the confirmation card when user confirms", async () => {
    const d = deps();
    await handleCodexResetCardAction(event({ action: "codex_reset_request" }, "usage-message"), d);

    await expect(handleCodexResetCardAction(
      event({
        action: "codex_reset_confirm",
        decision: "yes",
        parentMessageId: "usage-message",
        requestId: "request-1",
      }, "confirm-message"),
      d,
    )).resolves.toBe(true);

    expect(d.consumeCodexRateLimitResetCredit).toHaveBeenCalledWith("request-1");
    expect(d.updateCardMessage).toHaveBeenCalledTimes(1);
    expect(d.updateCardMessage.mock.calls[0][1]).toBe("confirm-message");
    expect(JSON.parse(d.updateCardMessage.mock.calls[0][2]).elements).toEqual([
      { tag: "markdown", content: " " },
    ]);
    expect(d.recallMessage).toHaveBeenCalledWith("tenant-token", "confirm-message");
    expect(d.sendTextReply).toHaveBeenCalledWith(
      "tenant-token",
      "chat-1",
      expect.stringContaining("重置成功"),
    );
    expect(d.sendCardReply).not.toHaveBeenCalled();
  });

  it("does not consume a reset credit and sends a cancellation message when user declines", async () => {
    const d = deps();
    await handleCodexResetCardAction(event({ action: "codex_reset_request" }, "usage-message"), d);

    await expect(handleCodexResetCardAction(
      event({
        action: "codex_reset_confirm",
        decision: "no",
        parentMessageId: "usage-message",
        requestId: "request-1",
      }, "confirm-message"),
      d,
    )).resolves.toBe(true);

    expect(d.consumeCodexRateLimitResetCredit).not.toHaveBeenCalled();
    expect(d.updateCardMessage).toHaveBeenCalledTimes(1);
    expect(d.recallMessage).toHaveBeenCalledWith("tenant-token", "confirm-message");
    expect(d.sendTextReply).toHaveBeenCalledWith(
      "tenant-token",
      "chat-1",
      "Codex 主动重置：用户取消了重置。",
    );
    expect(d.sendCardReply).not.toHaveBeenCalled();
  });

  it("can collapse a confirmation card using context.message_id fallback", async () => {
    const d = deps();
    await handleCodexResetCardAction(event({ action: "codex_reset_request" }, "usage-message"), d);

    await expect(handleCodexResetCardAction({
      event: {
        context: {
          message_id: "confirm-message-from-context",
          open_chat_id: "chat-1",
        },
        action: {
          value: {
            action: "codex_reset_confirm",
            decision: "no",
            parentMessageId: "usage-message",
            requestId: "request-1",
          },
        },
      },
    }, d)).resolves.toBe(true);

    expect(d.updateCardMessage).toHaveBeenCalledTimes(1);
    expect(d.updateCardMessage.mock.calls[0][1]).toBe("confirm-message-from-context");
    expect(d.recallMessage).toHaveBeenCalledWith("tenant-token", "confirm-message-from-context");
  });
});
