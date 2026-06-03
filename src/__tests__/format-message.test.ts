import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock feishu-platform 以控制 API 行为
const mockGetTenantAccessToken = vi.fn();
const mockGetOrDownloadImage = vi.fn();
const mockGetMergeForwardMessages = vi.fn();

vi.mock("../feishu-platform.ts", () => ({
  getTenantAccessToken: (...args: unknown[]) => mockGetTenantAccessToken(...args),
  getOrDownloadImage: (...args: unknown[]) => mockGetOrDownloadImage(...args),
  getMergeForwardMessages: (...args: unknown[]) => mockGetMergeForwardMessages(...args),
}));

import { formatMessageContent, formatPostContent, formatMergeForward } from "../format-message.ts";

describe("formatMessageContent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTenantAccessToken.mockResolvedValue("mock_token");
  });

  it("解析文本消息", async () => {
    const result = await formatMessageContent({
      message_type: "text",
      content: JSON.stringify({ text: "hello world" }),
    });
    expect(result).toBe("hello world");
  });

  it("去除 HTML 标签", async () => {
    const result = await formatMessageContent({
      message_type: "text",
      content: JSON.stringify({ text: "<p>你好</p><br/>世界" }),
    });
    expect(result).toBe("你好\n世界");
  });

  it("解析 post 消息", async () => {
    const result = await formatMessageContent({
      message_type: "post",
      content: JSON.stringify({
        content: [[{ tag: "text", text: "第一条消息" }]],
      }),
    });
    expect(result).toBe("第一条消息");
  });

  it("解析 post 中的代码块", async () => {
    const result = await formatMessageContent({
      message_type: "post",
      content: JSON.stringify({
        content: [[{ tag: "code_block", language: "ts", text: "const x = 1;" }]],
      }),
    });
    expect(result).toBe("```ts\nconst x = 1;\n```");
  });

  it("解析 media 类型返回元数据", async () => {
    const result = await formatMessageContent({
      message_id: "om_test",
      message_type: "media",
      content: JSON.stringify({ file_key: "fk_001", file_name: "test.mp4" }),
    });
    expect(result).toContain("[视频]");
    expect(result).toContain("om_test");
    expect(result).toContain("fk_001");
  });

  it("解析 file 类型返回元数据", async () => {
    const result = await formatMessageContent({
      message_id: "om_test",
      message_type: "file",
      content: JSON.stringify({ file_key: "fk_001", file_name: "doc.pdf" }),
    });
    expect(result).toContain("[文件]");
    expect(result).toContain("om_test");
    expect(result).toContain("fk_001");
  });

  it("未知类型返回原始 JSON", async () => {
    const result = await formatMessageContent({
      message_type: "sticker",
      content: JSON.stringify({ sticker_id: "stk_001" }),
    });
    expect(result).toBe(JSON.stringify({ sticker_id: "stk_001" }));
  });

  it("content 为空时返回空字符串", async () => {
    const result = await formatMessageContent({
      message_type: "text",
    });
    expect(result).toBe("");
  });

  it("content JSON 解析失败返回空字符串", async () => {
    const result = await formatMessageContent({
      message_type: "text",
      content: "not valid json",
    });
    expect(result).toBe("");
  });

  it("merge_forward 的 content 为空时仍能走 API 路径", async () => {
    mockGetMergeForwardMessages.mockResolvedValue([
      { message_id: "om_root" },
      {
        message_id: "om_1",
        msg_type: "text",
        body: { content: JSON.stringify({ text: "hello" }) },
        sender: { id: "ou_001" },
        upper_message_id: "om_root",
      },
    ]);

    const result = await formatMessageContent({
      message_id: "om_mf",
      message_type: "merge_forward",
      content: "", // 空字符串
    });

    expect(result).toContain("[合并转发: 聊天记录]");
    expect(result).toContain("hello");
  });
});

describe("formatMergeForward", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTenantAccessToken.mockResolvedValue("mock_token");
  });

  const preview = [
    {
      content: "第一条消息",
      sender: { id: "ou_001", name: "张三", avatar_url: "" },
    },
    {
      content: "第二条消息",
      sender: { id: "ou_002", name: "李四", avatar_url: "" },
    },
  ];

  it("API 成功：格式化子消息列表", async () => {
    mockGetMergeForwardMessages.mockResolvedValue([
      // 第一个 item: 合并转发消息自身（无 upper_message_id），会被跳过
      { message_id: "om_root", msg_type: "merge_forward", body: { content: "{}" } },
      {
        message_id: "om_1",
        msg_type: "text",
        body: { content: JSON.stringify({ text: "你好" }) },
        sender: { id: "ou_001" },
        upper_message_id: "om_root",
      },
      {
        message_id: "om_2",
        msg_type: "text",
        body: { content: JSON.stringify({ text: "在吗" }) },
        sender: { id: "ou_002" },
        upper_message_id: "om_root",
      },
    ]);

    const result = await formatMergeForward("om_mf", {
      title: "聊天记录",
      preview,
    });

    expect(result).toContain("[合并转发: 聊天记录]");
    expect(result).toContain("张三: 你好");
    expect(result).toContain("李四: 在吗");
    expect(mockGetMergeForwardMessages).toHaveBeenCalledWith("mock_token", "om_mf");
  });

  it("API 成功：跳过 merge_forward 自身 item", async () => {
    mockGetMergeForwardMessages.mockResolvedValue([
      { message_id: "om_root", msg_type: "merge_forward", body: { content: "{}" } },
    ]);

    const result = await formatMergeForward("om_mf", {
      title: "空聊天记录",
      preview: [],
    });

    // API 返回了 items 但只有根消息本身（无子消息），应该降级到 preview（也为空）
    // → 返回原始 JSON
    expect(result).toBe(JSON.stringify({ title: "空聊天记录", preview: [] }));
  });

  it("API 失败：降级使用 preview", async () => {
    mockGetMergeForwardMessages.mockRejectedValue(new Error("permission denied"));

    const result = await formatMergeForward("om_mf", {
      title: "聊天记录",
      preview,
    });

    expect(result).toContain("[合并转发: 聊天记录]");
    expect(result).toContain("张三: 第一条消息");
    expect(result).toContain("李四: 第二条消息");
  });

  it("API 失败 + preview 为空：返回原始 JSON", async () => {
    mockGetMergeForwardMessages.mockRejectedValue(new Error("permission denied"));

    const result = await formatMergeForward("om_mf", {
      title: "聊天记录",
    });

    expect(result).toBe(JSON.stringify({ title: "聊天记录" }));
  });

  it("chat_name 出现在标题中", async () => {
    mockGetMergeForwardMessages.mockRejectedValue(new Error("no permission"));

    const result = await formatMergeForward("om_mf", {
      title: "聊天记录",
      chat_name: "技术群",
      preview,
    });

    expect(result).toContain("[合并转发: 聊天记录 (技术群)]");
  });

  it("发送者名称从 preview 映射到 API items", async () => {
    // API 返回的 sender 只有 id 没有 name，应该从 preview 映射名称
    mockGetMergeForwardMessages.mockResolvedValue([
      { message_id: "om_root" },
      {
        message_id: "om_1",
        msg_type: "text",
        body: { content: JSON.stringify({ text: "测试" }) },
        sender: { id: "ou_001" }, // 只有 id，无 name
        upper_message_id: "om_root",
      },
    ]);

    const result = await formatMergeForward("om_mf", {
      title: "测试",
      preview: [{ content: "", sender: { id: "ou_001", name: "张三" } }],
    });

    expect(result).toContain("张三: 测试");
  });

  it("preview 发送者为空时使用默认名称", async () => {
    mockGetMergeForwardMessages.mockRejectedValue(new Error("fail"));

    const result = await formatMergeForward("om_mf", {
      title: "测试",
      preview: [{ content: "消息内容" }],
    });

    expect(result).toContain("未知用户: 消息内容");
  });

  it("嵌套合并转发递归深度限制", async () => {
    // MAX_DEPTH=3，从 depth=3 开始调用应立即返回
    const result = await formatMergeForward("om_mf", {}, 3);
    expect(result).toBe("[合并转发: 超出最大嵌套深度 3]");
  });
});

describe("formatPostContent", () => {
  it("返回空段落数组时为空字符串", () => {
    const result = formatPostContent({});
    expect(result).toBe("");
  });

  it("跳过非数组元素", () => {
    const result = formatPostContent({ content: [null, undefined, "string"] });
    expect(result).toBe("");
  });
});