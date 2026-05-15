import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildHelpCard } from "../cards.ts";
import {
  _resetWechatClawStateForTest,
  _setWxMinSendIntervalMsForTest,
  createWechatAdapter,
} from "../wechat-platform.ts";

describe("createWechatAdapter", () => {
  beforeEach(() => {
    _resetWechatClawStateForTest();
    _setWxMinSendIntervalMsForTest(0); // 测试中禁用发送间隔限制
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

  it("appends claw suffix on 9th non-final message and blocks further non-final messages", async () => {
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

    // 前8条正常发送
    for (let i = 0; i < 8; i++) {
      await expect(platform.sendText("wx-chat-limit", `chunk ${i}`)).resolves.toBe(true);
    }

    // 第9条非最终消息：应附加 claw 后缀
    await expect(platform.sendText("wx-chat-limit", "chunk 8")).resolves.toBe(true);

    // 第10条起非最终消息被阻止
    await expect(platform.sendText("wx-chat-limit", "chunk 9")).resolves.toBe(false);

    expect(wire.push).toHaveBeenCalledTimes(9);
    // 验证第9条附带了 claw 后缀
    const ninthCall = wire.push.mock.calls[8];
    expect(ninthCall[1]).toContain("chunk 8");
    expect(ninthCall[1]).toContain("由于微信claw机制限制，不再发送过程，稍后把最终结果发送给你");
    expect(log).toHaveBeenCalledWith(
      "[WECHAT] sendText skipped (claw limit): chatId=wx-chat-limit count=10",
    );
  });

  it("allows final messages through after the 9th message claw limit", async () => {
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
    const chatId = "wx-chat-final-allow";
    const finalText = "done\n━━━ 回答结束 ━━━";

    // 前8条正常发送
    for (let i = 0; i < 8; i++) {
      await expect(platform.sendText(chatId, `chunk ${i}`)).resolves.toBe(true);
    }

    // 第9条非最终消息带后缀
    await expect(platform.sendText(chatId, "chunk 8")).resolves.toBe(true);

    // 第10条：最终消息应允许发送（不被阻止也不被 queuing）
    await expect(platform.sendText(chatId, finalText)).resolves.toBe(true);

    expect(wire.push).toHaveBeenCalledTimes(10);
    const lastCall = wire.push.mock.calls[9];
    expect(lastCall[1]).toBe(finalText);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("[WECHAT] sendText OK"),
    );
  });
});
