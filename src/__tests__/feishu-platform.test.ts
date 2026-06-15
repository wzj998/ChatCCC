import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPlatform, setPlatform, getTenantAccessToken, getChatInfo, createGroupChat, updateChatInfo, sendTextReply, sendCardReply, sendRawCard, sendPostMessage, extractSessionInfo, formatDelayNotice, reportPermissionResults, verifyAllPermissions, addReaction, recallMessage, updateCardMessage, setChatAvatar, getCodexUsageSummary, disbandChat, sendRestartCard, getMergeForwardMessages } from "../feishu-platform.ts";
import type { FeishuPlatform } from "../feishu-platform.ts";

const realPlatform = getPlatform();

describe("feishu-platform", () => {
  it("默认使用真实实现", () => {
    expect(realPlatform).toBeDefined();
    expect(typeof realPlatform.getTenantAccessToken).toBe("function");
    expect(typeof realPlatform.sendTextReply).toBe("function");
  });

  it("setPlatform 可替换实现，包装函数委托到新实现", async () => {
    const mock: FeishuPlatform = {
      getTenantAccessToken: async () => "mock_token",
      sendTextReply: async () => true,
      sendCardReply: async () => true,
      sendRawCard: async () => true,
      sendPostMessage: async () => true,
      sendImageReply: async () => true,
      sendFileReply: async () => true,
      addReaction: async () => {},
      recallMessage: async () => false,
      updateCardMessage: async () => true,
      createGroupChat: async () => "mock_chat",
      updateChatInfo: async () => {},
      getChatInfo: async () => ({ name: "x", description: "y" }),
      disbandChat: async () => {},
      setChatAvatar: async () => {},
      getCodexUsageSummary: async () => ({
        fiveHour: { usedPercent: 10, remainingPercent: 90, resetAtEpochSeconds: 1781528212, resetAfterSeconds: 10349 },
        weekly: { usedPercent: 20, remainingPercent: 80, resetAtEpochSeconds: 1781842926, resetAfterSeconds: 325063 },
      }),
      getOrDownloadImage: async () => "/tmp/img.png",
      verifyAllPermissions: async () => [],
      reportPermissionResults: realPlatform.reportPermissionResults,
      extractSessionInfo: realPlatform.extractSessionInfo,
      extractSessionId: realPlatform.extractSessionId,
      formatDelayNotice: realPlatform.formatDelayNotice,
      sendRestartCard: async () => {},
      getMergeForwardMessages: async () => [],
    };

    setPlatform(mock);
    try {
      expect(await getTenantAccessToken()).toBe("mock_token");
      expect(await sendTextReply("t", "c", "hi")).toBe(true);
      expect(await createGroupChat("t", "g", [])).toBe("mock_chat");
      expect(await getChatInfo("t", "mock_chat")).toEqual({ name: "x", description: "y" });
      const perms = await verifyAllPermissions("t");
      expect(perms).toEqual([]);
      const mergeMsgs = await getMergeForwardMessages("t", "om_test");
      expect(mergeMsgs).toEqual([]);
      expect(await getCodexUsageSummary()).toEqual({
        fiveHour: { usedPercent: 10, remainingPercent: 90, resetAtEpochSeconds: 1781528212, resetAfterSeconds: 10349 },
        weekly: { usedPercent: 20, remainingPercent: 80, resetAtEpochSeconds: 1781842926, resetAfterSeconds: 325063 },
      });
    } finally {
      // 恢复到真实实现，避免影响后续测试
      setPlatform(realPlatform);
    }
  });

  it("恢复真实实现后函数正常工作", async () => {
    setPlatform(realPlatform);
    expect(getPlatform()).toBe(realPlatform);
  });
});
