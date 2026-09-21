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

describe("formatMessageContent mixed post images", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTenantAccessToken.mockResolvedValue("mock_token");
  });

  it("includes downloaded images from mixed post messages", async () => {
    mockGetOrDownloadImage.mockResolvedValue("C:\\tmp\\img_001.png");

    const result = await formatMessageContent({
      message_id: "om_post",
      message_type: "post",
      content: JSON.stringify({
        content: [[
          { tag: "text", text: "use this image" },
          { tag: "img", image_key: "img_001" },
        ]],
      }),
    });

    expect(result).toBe("use this image\n[图片] C:\\tmp\\img_001.png");
    expect(mockGetTenantAccessToken).toHaveBeenCalled();
    expect(mockGetOrDownloadImage).toHaveBeenCalledWith("mock_token", "om_post", "img_001");
  });

  it("keeps post image key when mixed post image download fails", async () => {
    mockGetOrDownloadImage.mockRejectedValue(new Error("download failed"));

    const result = await formatMessageContent({
      message_id: "om_post",
      message_type: "post",
      content: JSON.stringify({
        content: [[
          { tag: "text", text: "caption" },
          { tag: "img", image_key: "img_002" },
        ]],
      }),
    });

    expect(result).toBe("caption\n[图片: img_002]");
  });

  // 回归护栏：链接 + 图片 + 文字同处一条 post 消息时，链接不能被丢弃。
  // 历史 bug：e44f087 重写 extractText 时删掉了 tag=="a" 分支，d7ad624 补 post
  // 支持时只补了 code_block/p/text，导致链接元素被静默丢弃（Agent 收不到链接）。
  it("includes hyperlink (tag=a) alongside image in mixed post messages", async () => {
    mockGetOrDownloadImage.mockRejectedValue(new Error("download failed"));
    const url = "https://www.binance.com/zh-CN/copy-trading/lead-details/5231222063705631744?timeRange=30D";

    const result = await formatMessageContent({
      message_id: "om_post",
      message_type: "post",
      content: JSON.stringify({
        content: [
          [{ tag: "a", href: url, text: url, style: [] }],
          [{ tag: "img", image_key: "img_003", width: 1200, height: 2670 }],
          [{ tag: "text", text: "看一下这个人", style: [] }],
        ],
      }),
    });

    expect(result).toContain(url);
    expect(result).toContain("[图片: img_003]");
    expect(result).toContain("看一下这个人");
  });
});

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

  it("保留超链接元素（tag=a），文本与 URL 不同时输出 markdown 链接", () => {
    const result = formatPostContent({
      content: [[{ tag: "a", href: "https://example.com/x", text: "示例站点", style: [] }]],
    });
    expect(result).toBe("[示例站点](https://example.com/x)");
  });

  it("超链接文本与 URL 相同时只输出 URL（避免冗余）", () => {
    const result = formatPostContent({
      content: [[{ tag: "a", href: "https://example.com/x", text: "https://example.com/x", style: [] }]],
    });
    expect(result).toBe("https://example.com/x");
  });

  it("超链接只有 href 没有 text 时输出 URL", () => {
    const result = formatPostContent({
      content: [[{ tag: "a", href: "https://example.com/x", style: [] }]],
    });
    expect(result).toBe("https://example.com/x");
  });

  it("超链接没有 href 时退化为显示文本", () => {
    const result = formatPostContent({
      content: [[{ tag: "a", text: "纯文本", style: [] }]],
    });
    expect(result).toBe("纯文本");
  });
});

describe("formatPostContent 未知元素兜底透传", () => {
  it("未知 tag 带 text 时兜底透传文本并记 warn 日志", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = formatPostContent({
      content: [[{ tag: "future_element", text: "未来元素文本", style: [] }]],
    });
    expect(result).toBe("未来元素文本");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("future_element"));
    warn.mockRestore();
  });

  it("未知 tag 只有 href 时透传链接", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = formatPostContent({
      content: [[{ tag: "future_link", href: "https://example.com/y", style: [] }]],
    });
    expect(result).toBe("https://example.com/y");
    warn.mockRestore();
  });

  it("未知 tag 同时有 text 与 href 时输出 markdown 链接", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = formatPostContent({
      content: [[{ tag: "future_link", href: "https://example.com/y", text: "点这里", style: [] }]],
    });
    expect(result).toBe("[点这里](https://example.com/y)");
    warn.mockRestore();
  });

  it("at 元素降级为 @用户名", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = formatPostContent({
      content: [[{ tag: "at", user_id: "ou_001", user_name: "张三", style: [] }]],
    });
    expect(result).toBe("@张三");
    warn.mockRestore();
  });

  it("未知 tag 无可透传内容时丢弃并记 warn 日志", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = formatPostContent({
      content: [[{ tag: "empty_future_element", style: [] }]],
    });
    expect(result).toBe("");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("empty_future_element"));
    warn.mockRestore();
  });

  it("img 元素由图片逻辑处理，不触发未知元素 warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = formatPostContent({
      content: [[{ tag: "img", image_key: "img_001" }]],
    });
    expect(result).toBe("");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
