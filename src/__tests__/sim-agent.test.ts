import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { createSimAgent } from "../sim-agent.ts";
import { simStore, setMessageHandler } from "../sim-store.ts";

const MESSAGES_FILE = join(homedir(), ".chatccc", "sim", "messages.jsonl");

describe("SimAgent", () => {
  beforeEach(() => {
    simStore.reset();
    setMessageHandler(async () => {});
  });

  afterAll(async () => {
    try { await unlink(MESSAGES_FILE); } catch { /* ok */ }
  });

  it("createSimAgent 绑定已有用户账户", () => {
    const a = createSimAgent("sim_user_001");
    expect(a.userId).toBe("sim_user_001");
    expect(a.account.name).toBe("Developer");
  });

  it("createSimAgent 不存在用户抛出错误", () => {
    expect(() => createSimAgent("nonexistent")).toThrow('Account "nonexistent" not found');
  });

  it("createSimAgent bot 账户抛出错误", () => {
    expect(() => createSimAgent("bot")).toThrow('is not a user account');
  });

  it("createP2pWithBot 创建后用户能看到", () => {
    const a = createSimAgent("sim_user_001");
    const chatId = a.createP2pWithBot();
    expect(chatId).toBe("p2p_sim_user_001_bot");
    const chats = a.listChats();
    expect(chats.some((c) => c.type === "p2p")).toBe(true);
  });

  it("sendMessage 将消息发送到指定群", async () => {
    let receivedText = "";
    let receivedChatId = "";
    setMessageHandler(async (text, chatId) => {
      receivedText = text;
      receivedChatId = chatId;
      simStore.sendReply(chatId, "text", `echo: ${text}`);
    });

    const a = createSimAgent("sim_user_001");
    await a.sendMessage("sim_default", "你好");

    expect(receivedText).toBe("你好");
    expect(receivedChatId).toBe("sim_default");
  });

  it("sendMessage 非成员发送消息抛出错误", async () => {
    simStore.registerAccount({ id: "alice_test", kind: "user", name: "Alice" });
    const a = createSimAgent("alice_test");
    await expect(a.sendMessage("sim_default", "hello"))
      .rejects.toThrow('is not a member');
  });

  it("on message 订阅收到 bot 回复", async () => {
    setMessageHandler(async (text, chatId) => {
      simStore.sendReply(chatId, "text", `reply to: ${text}`);
    });

    const a = createSimAgent("sim_user_001");
    let received: { chatId: string; content: string } | null = null;
    a.on("message", (chatId, msg) => {
      received = { chatId, content: msg.content };
    });

    await a.sendMessage("sim_default", "ping");
    await new Promise((r) => setTimeout(r, 50));

    expect(received).not.toBeNull();
    expect(received!.content).toBe("reply to: ping");
  });

  it("waitForReply 等待 bot 回复", async () => {
    setMessageHandler(async (text, chatId) => {
      setTimeout(() => {
        simStore.sendReply(chatId, "text", `async reply: ${text}`);
      }, 10);
    });

    const a = createSimAgent("sim_user_001");
    const replyPromise = a.waitForReply("sim_default", 5000);
    await a.sendMessage("sim_default", "hello");

    const reply = await replyPromise;
    expect(reply).not.toBeNull();
    expect(reply!.content).toBe("async reply: hello");
    expect(reply!.senderId).toBe("bot");
  });

  it("waitForReply 超时返回 null", async () => {
    setMessageHandler(async () => {});

    const a = createSimAgent("sim_user_001");
    const reply = await a.waitForReply("sim_default", 100);
    expect(reply).toBeNull();
  });

  it("getMessages 获取消息历史", async () => {
    setMessageHandler(async (text, chatId) => {
      simStore.sendReply(chatId, "text", `echo: ${text}`);
    });

    const a = createSimAgent("sim_user_001");
    await a.sendMessage("sim_default", "msg1");
    await a.sendMessage("sim_default", "msg2");
    await new Promise((r) => setTimeout(r, 50));

    const msgs = a.getMessages("sim_default");
    expect(msgs.length).toBe(4); // 2 user + 2 bot
    expect(msgs[0].senderId).toBe("sim_user_001");
    expect(msgs[0].content).toBe("msg1");
    expect(msgs[1].senderId).toBe("bot");
    expect(msgs[1].content).toBe("echo: msg1");
  });

  it("on invited_to_group 收到拉群通知", () => {
    simStore.registerAccount({ id: "new_user", kind: "user", name: "New" });
    const a = createSimAgent("new_user");
    let invitedChatId = "";
    let invitedUserId = "";
    a.on("invited_to_group", (chatId, userId) => {
      invitedChatId = chatId;
      invitedUserId = userId;
    });

    simStore.createGroupChat("新群", ["new_user"]);
    expect(invitedChatId).toMatch(/^sim_/);
    expect(invitedUserId).toBe("new_user");
  });

  it("off 取消消息订阅", async () => {
    setMessageHandler(async (text, chatId) => {
      simStore.sendReply(chatId, "text", `echo: ${text}`);
    });

    const a = createSimAgent("sim_user_001");
    let count = 0;
    const handler = () => { count++; };
    a.on("message", handler);

    await a.sendMessage("sim_default", "test1");
    await new Promise((r) => setTimeout(r, 30));
    // sendMessage 产生 2 条消息（recordMessage + sendReply）
    const countBeforeOff = count;
    expect(countBeforeOff).toBe(2);

    a.off("message", handler);

    await a.sendMessage("sim_default", "test2");
    await new Promise((r) => setTimeout(r, 30));

    // off 后不应再增加
    expect(count).toBe(countBeforeOff);
  });

  it("listChats 返回用户会话列表", () => {
    const a = createSimAgent("sim_user_001");
    const chats = a.listChats();
    expect(chats.length).toBeGreaterThanOrEqual(1);
    expect(chats.some((c) => c.id === "sim_default")).toBe(true);
    expect(chats.some((c) => c.type === "p2p")).toBe(true);
  });
});