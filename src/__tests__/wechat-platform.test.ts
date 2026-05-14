import { describe, expect, it, vi } from "vitest";

import { buildHelpCard } from "../cards.ts";
import { createWechatAdapter } from "../wechat-platform.ts";

describe("createWechatAdapter", () => {
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
});
