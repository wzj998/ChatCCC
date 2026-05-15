import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildHelpCard } from "../cards.ts";
import {
  _downloadWechatMediaAttachmentsForTest,
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

describe("WeChat media receive helpers", () => {
  it("downloads image, file, and video items and returns message attachment paths", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "chatccc-wx-media-"));
    const imageDir = join(tempRoot, "images");
    const fileDir = join(tempRoot, "files");
    const videoDir = join(tempRoot, "videos");
    try {
      const imageMedia = { aes_key: "image-key-1234567890", encrypt_query_param: "image" };
      const fileMedia = { aes_key: "file-key-1234567890", encrypt_query_param: "file" };
      const videoMedia = { aes_key: "video-key-1234567890", encrypt_query_param: "video" };
      const wire = {
        downloadMedia: vi.fn(async (media: unknown) => {
          if (media === imageMedia) return Buffer.from("image-data");
          if (media === fileMedia) return Buffer.from("file-data");
          if (media === videoMedia) return Buffer.from("video-data");
          throw new Error("unexpected media");
        }),
      };

      const result = await _downloadWechatMediaAttachmentsForTest(
        {
          message_id: 123,
          item_list: [
            { image_item: { media: imageMedia } },
            {
              file_item: {
                media: fileMedia,
                file_name: "report.txt",
                md5: "1234567890abcdef1234567890abcdef",
              },
            },
            {
              video_item: {
                media: videoMedia,
                video_md5: "abcdef1234567890abcdef",
              },
            },
          ],
        },
        { wire, imageDir, fileDir, videoDir },
      );

      expect(result.imagePaths).toHaveLength(1);
      expect(result.filePaths).toHaveLength(1);
      expect(result.videoPaths).toHaveLength(1);
      expect(result.messageLines[0]).toMatch(/^\[图片\] /);
      expect(result.messageLines[1]).toMatch(/^\[文件\] /);
      expect(result.messageLines[2]).toMatch(/^\[视频\] /);
      expect(result.imagePaths[0]).toContain(join("images", "wx_image-key-123456.png"));
      expect(result.filePaths[0]).toContain(join("files", "wx_1234567890abcdef_report.txt"));
      expect(result.videoPaths[0]).toContain(join("videos", "wx_abcdef1234567890.mp4"));
      await expect(readFile(result.imagePaths[0], "utf8")).resolves.toBe("image-data");
      await expect(readFile(result.filePaths[0], "utf8")).resolves.toBe("file-data");
      await expect(readFile(result.videoPaths[0], "utf8")).resolves.toBe("video-data");
      expect(wire.downloadMedia).toHaveBeenCalledTimes(3);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
