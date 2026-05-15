import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildHelpCard } from "../cards.ts";
import {
  _flushPendingClawFinalTextForTest,
  _resetWechatClawStateForTest,
  createWechatAdapter,
} from "../wechat-platform.ts";

describe("createWechatAdapter", () => {
  beforeEach(() => {
    _resetWechatClawStateForTest();
  });

  it("degrades raw cards to plain text messages", async () => {
    const wire = {
      push: vi.fn(async (_chatId: string, _text: string) => "msg-id"),
      sendText: vi.fn(
        async (_chatId: string, _text: string, _contextToken?: string) =>
          "msg-id",
      ),
    };
    const log = vi.fn();
    const platform = createWechatAdapter({
      getWire: () => wire,
      log,
    });

    const ok = await platform.sendRawCard("wx-chat-help", buildHelpCard("Hello"));

    expect(ok).toBe(true);
    expect(wire.push).toHaveBeenCalledTimes(1);
    expect(wire.sendText).not.toHaveBeenCalled();
    const [, text] = wire.push.mock.calls[0];
    expect(text).toContain("# ChatCCC");
    expect(text).toContain("Hello");
    expect(text).toContain("/new");
    expect(log).toHaveBeenCalledWith("[WECHAT] sendRawCard degraded to text");
  });

  it("reports unsent non-final messages after the claw limit", async () => {
    const wire = {
      push: vi.fn(async (_chatId: string, _text: string) => "msg-id"),
      sendText: vi.fn(
        async (_chatId: string, _text: string, _contextToken?: string) =>
          "msg-id",
      ),
    };
    const log = vi.fn();
    const platform = createWechatAdapter({
      getWire: () => wire,
      log,
    });

    for (let i = 0; i < 10; i++) {
      await expect(platform.sendText("wx-chat-limit", `chunk ${i}`)).resolves.toBe(true);
    }

    await expect(platform.sendText("wx-chat-limit", "chunk 10")).resolves.toBe(false);
    expect(wire.push).toHaveBeenCalledTimes(10);
    expect(log).toHaveBeenCalledWith(
      "[WECHAT] sendText skipped (claw limit): chatId=wx-chat-limit count=11",
    );
  });

  it("queues final messages after the claw limit until the user wakes the chat", async () => {
    const wire = {
      push: vi.fn(async (_chatId: string, _text: string) => "msg-id"),
      sendText: vi.fn(
        async (_chatId: string, _text: string, _contextToken?: string) =>
          "msg-id",
      ),
    };
    const log = vi.fn();
    const platform = createWechatAdapter({
      getWire: () => wire,
      log,
    });
    const chatId = "wx-chat-final-limit";
    const finalText = "done\n━━━ 回答结束 ━━━";

    for (let i = 0; i < 10; i++) {
      await expect(platform.sendText(chatId, `chunk ${i}`)).resolves.toBe(true);
    }

    await expect(platform.sendText(chatId, finalText)).resolves.toBe(true);
    expect(wire.push).toHaveBeenCalledTimes(10);
    expect(log).toHaveBeenCalledWith(
      `[WECHAT] final queued (claw limit): chatId=${chatId} count=11 len=${finalText.length}`,
    );

    await expect(_flushPendingClawFinalTextForTest(chatId, wire, log)).resolves.toBe(true);
    expect(wire.push).toHaveBeenCalledTimes(11);
    expect(wire.push).toHaveBeenLastCalledWith(chatId, finalText);
    expect(log).toHaveBeenCalledWith(
      `[WECHAT] pending final sent after claw wake: chatId=${chatId} len=${finalText.length}`,
    );
  });
});
