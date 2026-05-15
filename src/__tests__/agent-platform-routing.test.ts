import { describe, expect, it } from "vitest";

import { splitFeishuTargetChats } from "../agent-platform-routing.ts";

describe("agent platform routing", () => {
  it("keeps Feishu-compatible chats and skips WeChat chats for Feishu RPC", () => {
    const result = splitFeishuTargetChats(["fs-1", "wx-1", "unknown-1"], (chatId) => {
      if (chatId.startsWith("wx")) return "wechat";
      if (chatId.startsWith("fs")) return "feishu";
      return undefined;
    });

    expect(result.targetChatIds).toEqual(["fs-1", "unknown-1"]);
    expect(result.skippedUnsupported).toEqual([{ chatId: "wx-1", platformKind: "wechat" }]);
  });

  it("reports no Feishu targets when every bound chat is WeChat", () => {
    const result = splitFeishuTargetChats(["wx-1", "wx-2"], () => "wechat");

    expect(result.targetChatIds).toEqual([]);
    expect(result.skippedUnsupported).toEqual([
      { chatId: "wx-1", platformKind: "wechat" },
      { chatId: "wx-2", platformKind: "wechat" },
    ]);
  });
});
