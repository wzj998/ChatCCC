import { describe, it, expect, afterAll } from "vitest";
import { unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { SimulatedPlatform, SIM_DEFAULT_CHAT_ID } from "../sim-platform.ts";

const MESSAGES_FILE = join(homedir(), ".chatccc", "sim", "messages.jsonl");

describe("SimulatedPlatform", () => {
  afterAll(async () => {
    // 清理测试消息文件
    try { await unlink(MESSAGES_FILE); } catch { /* ok */ }
  });

  it("getTenantAccessToken 返回固定 token", async () => {
    const token = await SimulatedPlatform.getTenantAccessToken();
    expect(token).toBe("sim_token");
  });

  it("createGroupChat 创建群并返回 sim_xxx ID", async () => {
    const chatId = await SimulatedPlatform.createGroupChat("t", "测试群", ["u1"]);
    expect(chatId).toMatch(/^sim_[0-9a-f]{8}$/);
    const info = await SimulatedPlatform.getChatInfo("t", chatId);
    expect(info.name).toBe("测试群");
  });

  it("getChatInfo 默认群存在", async () => {
    const info = await SimulatedPlatform.getChatInfo("t", SIM_DEFAULT_CHAT_ID);
    expect(info.name).toBe("默认模拟会话");
  });

  it("updateChatInfo 更新群信息", async () => {
    const chatId = await SimulatedPlatform.createGroupChat("t", "原群名", ["u1"]);
    await SimulatedPlatform.updateChatInfo("t", chatId, "新群名", "Claude Session: abc123");
    const info = await SimulatedPlatform.getChatInfo("t", chatId);
    expect(info.name).toBe("新群名");
    expect(info.description).toContain("Claude Session");
  });

  it("sendTextReply 返回 true", async () => {
    const ok = await SimulatedPlatform.sendTextReply("t", "ch1", "你好");
    expect(ok).toBe(true);
  });

  it("sendCardReply 返回 true", async () => {
    const ok = await SimulatedPlatform.sendCardReply("t", "ch1", "标题", "内容", "blue");
    expect(ok).toBe(true);
  });

  it("verifyAllPermissions 全部通过", async () => {
    const results = await SimulatedPlatform.verifyAllPermissions("t");
    expect(results.length).toBe(5);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("addReaction 无异常", async () => {
    await expect(SimulatedPlatform.addReaction("t", "msg1")).resolves.toBeUndefined();
  });

  it("setChatAvatar 无异常", async () => {
    await expect(SimulatedPlatform.setChatAvatar("t", "ch1", "claude", "busy")).resolves.toBeUndefined();
  });

  it("纯函数 extractSessionInfo 正常工作", () => {
    const result = SimulatedPlatform.extractSessionInfo("Claude Code Session: a1b2c3d4-e5f6-7890-abcd-ef1234567890");
    expect(result).toEqual({ sessionId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890", tool: "claude" });
  });

  it("pure extractSessionInfo recognizes ccc session ids", () => {
    const result = SimulatedPlatform.extractSessionInfo("CCC Session: session-20260702-121530-a1b2c3");
    expect(result).toEqual({ sessionId: "session-20260702-121530-a1b2c3", tool: "ccc" });
  });

  it("纯函数 formatDelayNotice 正常工作", () => {
    const notice = SimulatedPlatform.formatDelayNotice(Date.now() - 20 * 60 * 1000, "测试消息");
    expect(notice).toBeDefined();
    expect(notice).toContain("延迟送达");
    // 近期消息不触发
    expect(SimulatedPlatform.formatDelayNotice(Date.now(), "test")).toBeNull();
  });
});
