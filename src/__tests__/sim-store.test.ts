import { describe, it, expect, afterAll } from "vitest";
import { unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { SimStore, simStore, SIM_DEFAULT_CHAT_ID } from "../sim-store.ts";
import type { SimAccount, SimChat, SimMessage } from "../sim-store.ts";

const MESSAGES_FILE = join(homedir(), ".chatccc", "sim", "messages.jsonl");

describe("SimStore", () => {
  afterAll(async () => {
    try { await unlink(MESSAGES_FILE); } catch { /* ok */ }
  });

  // ---- 初始化 ----

  it("默认初始化 bot + 默认用户 + 默认群", () => {
    const store = new SimStore();
    expect(store.getAccount("bot")).toBeDefined();
    expect(store.getAccount("sim_user_001")).toBeDefined();
    expect(store.getChat("sim_default")).toBeDefined();
  });

  it("默认群成员包含 bot 和 sim_user_001", () => {
    const store = new SimStore();
    const chat = store.getChat("sim_default")!;
    expect(chat.memberIds).toContain("bot");
    expect(chat.memberIds).toContain("sim_user_001");
    expect(chat.type).toBe("group");
  });

  // ---- 账户管理 ----

  it("registerAccount 注册新用户", () => {
    const store = new SimStore();
    store.registerAccount({ id: "alice", kind: "user", name: "Alice" });
    const a = store.getAccount("alice");
    expect(a).toBeDefined();
    expect(a!.name).toBe("Alice");
    expect(a!.kind).toBe("user");
  });

  it("registerAccount 重复 id 抛出错误", () => {
    const store = new SimStore();
    store.registerAccount({ id: "bob", kind: "user", name: "Bob" });
    expect(() => store.registerAccount({ id: "bob", kind: "user", name: "Bob2" }))
      .toThrow('Account "bob" already exists');
  });

  // ---- 群聊管理 ----

  it("createGroupChat 创建群，bot 自动加入", () => {
    const store = new SimStore();
    store.registerAccount({ id: "alice", kind: "user", name: "Alice" });
    const chat = store.createGroupChat("测试群", ["alice"]);
    expect(chat.id).toMatch(/^sim_[0-9a-f]{8}$/);
    expect(chat.name).toBe("测试群");
    expect(chat.type).toBe("group");
    expect(chat.memberIds).toContain("bot");
    expect(chat.memberIds).toContain("alice");
  });

  it("createGroupChat emit chat_created 和 member_added 事件", () => {
    const store = new SimStore();
    store.registerAccount({ id: "alice", kind: "user", name: "Alice" });

    let createdChat: SimChat | null = null;
    let addedUserId = "";
    store.on("chat_created", ({ chat }) => { createdChat = chat; });
    store.on("member_added", ({ userId }) => { addedUserId = userId; });

    store.createGroupChat("测试群", ["alice"]);
    expect(createdChat).not.toBeNull();
    expect(createdChat!.name).toBe("测试群");
    expect(addedUserId).toBe("alice");
  });

  it("createP2pChat 创建私聊", () => {
    const store = new SimStore();
    store.registerAccount({ id: "alice", kind: "user", name: "Alice" });
    const chat = store.createP2pChat("alice");
    expect(chat.id).toBe("p2p_alice_bot");
    expect(chat.type).toBe("p2p");
    expect(chat.memberIds).toContain("bot");
    expect(chat.memberIds).toContain("alice");
  });

  it("createP2pChat 重复调用返回同一个 chat", () => {
    const store = new SimStore();
    store.registerAccount({ id: "alice", kind: "user", name: "Alice" });
    const c1 = store.createP2pChat("alice");
    const c2 = store.createP2pChat("alice");
    expect(c1.id).toBe(c2.id);
  });

  it("getChatsForUser 返回用户所在的所有会话", () => {
    const store = new SimStore();
    store.registerAccount({ id: "alice", kind: "user", name: "Alice" });
    store.createP2pChat("alice");
    store.createGroupChat("群1", ["alice"]);
    store.createGroupChat("群2", ["alice"]);

    const chats = store.getChatsForUser("alice");
    expect(chats.length).toBeGreaterThanOrEqual(2);
    expect(chats.some((c) => c.type === "p2p")).toBe(true);
  });

  it("addMember 添加成员并 emit 事件", () => {
    const store = new SimStore();
    store.registerAccount({ id: "alice", kind: "user", name: "Alice" });
    const chat = store.createGroupChat("测试群", []);

    let addedUserId = "";
    store.on("member_added", ({ userId }) => { addedUserId = userId; });

    store.addMember(chat.id, "alice");
    expect(chat.memberIds).toContain("alice");
    expect(addedUserId).toBe("alice");
  });

  it("updateChatInfo 更新已有群信息", () => {
    const store = new SimStore();
    store.registerAccount({ id: "alice", kind: "user", name: "Alice" });
    const chat = store.createGroupChat("原群名", ["alice"]);
    store.updateChatInfo(chat.id, "新群名", "Claude Code Session: abc123");
    expect(chat.name).toBe("新群名");
    expect(chat.description).toBe("Claude Code Session: abc123");
  });

  it("updateChatInfo 对不存在的群自动创建", () => {
    const store = new SimStore();
    store.updateChatInfo("sim_fake", "新群", "desc");
    const chat = store.getChat("sim_fake");
    expect(chat).toBeDefined();
    expect(chat!.name).toBe("新群");
  });

  // ---- 消息管理 ----

  it("recordMessage 记录用户消息到 chat 历史", () => {
    const store = new SimStore();
    store.registerAccount({ id: "alice", kind: "user", name: "Alice" });
    const chat = store.createGroupChat("测试群", ["alice"]);
    store.recordMessage(chat.id, "alice", "text", "你好");
    expect(chat.messages.length).toBe(1);
    expect(chat.messages[0].content).toBe("你好");
    expect(chat.messages[0].senderId).toBe("alice");
  });

  it("recordMessage emit message 事件", () => {
    const store = new SimStore();
    store.registerAccount({ id: "alice", kind: "user", name: "Alice" });
    const chat = store.createGroupChat("测试群", ["alice"]);

    let emittedMsg: SimMessage | null = null;
    let emittedChatId = "";
    store.on("message", ({ chatId, message }) => {
      emittedChatId = chatId;
      emittedMsg = message;
    });

    store.recordMessage(chat.id, "alice", "text", "hello");
    expect(emittedChatId).toBe(chat.id);
    expect(emittedMsg!.content).toBe("hello");
  });

  it("recordMessage 非成员不能看到消息", () => {
    const store = new SimStore();
    store.registerAccount({ id: "alice", kind: "user", name: "Alice" });
    store.registerAccount({ id: "bob", kind: "user", name: "Bob" });
    const chat = store.createGroupChat("测试群", ["alice"]); // bob 不在群内

    store.recordMessage(chat.id, "alice", "text", "hello");
    const msgs = store.getMessages(chat.id, "bob"); // bob 请求消息
    expect(msgs.length).toBe(0);
  });

  it("recordMessage 成员可以看到消息", () => {
    const store = new SimStore();
    store.registerAccount({ id: "alice", kind: "user", name: "Alice" });
    const chat = store.createGroupChat("测试群", ["alice"]);

    store.recordMessage(chat.id, "alice", "text", "hello");
    const msgs = store.getMessages(chat.id, "alice");
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toBe("hello");
  });

  it("sendReply 即使 chat 不存在也能记录并 emit", () => {
    const store = new SimStore();
    let emitted = false;
    store.on("message", () => { emitted = true; });

    const msg = store.sendReply("unknown_chat", "text", "测试");
    expect(msg.senderId).toBe("bot");
    expect(emitted).toBe(true);
  });

  it("sendReply 追加到已有 chat 的消息历史", () => {
    const store = new SimStore();
    store.registerAccount({ id: "alice", kind: "user", name: "Alice" });
    const chat = store.createGroupChat("测试群", ["alice"]);

    store.sendReply(chat.id, "text", "bot reply");
    expect(chat.messages.length).toBe(1);
    expect(chat.messages[0].senderId).toBe("bot");
  });

  it("getMessages 对不存在的 chat 返回空数组", () => {
    const store = new SimStore();
    expect(store.getMessages("nonexistent", "alice")).toEqual([]);
  });
});