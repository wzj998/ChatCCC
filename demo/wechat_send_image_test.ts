/**
 * 临时测试：生成一张图片并发送给微信用户
 *
 * 用法：
 *   npx tsx demo/wechat_send_image_test.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import sharp from "sharp";

import { Client as OpenIlinkWire } from "@openilink/openilink-sdk-node";

const USER_DATA_DIR = join(homedir(), ".chatccc");
const ILINK_AUTH_PATH = join(USER_DATA_DIR, "state", "ilink-auth.json");

interface IlinkSnapshot {
  token?: string;
  baseUrl?: string;
  lastChatId?: string;
  contextToken?: string;
}

function readSnapshot(): IlinkSnapshot {
  if (!existsSync(ILINK_AUTH_PATH)) {
    throw new Error(`Snapshot not found: ${ILINK_AUTH_PATH}. 请确保微信已登录。`);
  }
  return JSON.parse(readFileSync(ILINK_AUTH_PATH, "utf8")) as IlinkSnapshot;
}

async function main() {
  const snap = readSnapshot();
  if (!snap.token) throw new Error("Snapshot 中没有 token");
  if (!snap.lastChatId) throw new Error("Snapshot 中没有 lastChatId（还没有人发过消息）");
  if (!snap.contextToken) throw new Error("Snapshot 中没有 contextToken");

  console.log(`Token: ${snap.token.slice(0, 20)}...`);
  console.log(`BaseURL: ${snap.baseUrl ?? "(default)"}`);
  console.log(`ChatId: ${snap.lastChatId}`);
  console.log(`ContextToken: ${snap.contextToken.slice(0, 20)}...`);

  // 生成一张 400x300 的渐变测试图片
  const width = 400;
  const height = 300;

  // 用 sharp 创建 RGB 渐变图：左侧蓝色渐变到右侧红色
  const channels = 3;
  const pixels = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * channels;
      const t = x / width;
      pixels[offset] = Math.round(255 * (1 - t));       // R
      pixels[offset + 1] = Math.round(100 + 155 * t);   // G
      pixels[offset + 2] = Math.round(255 * t);          // B
    }
  }

  // 在图片上叠加文字
  const svgText = `
    <svg width="${width}" height="${height}">
      <rect width="${width}" height="${height}" fill="white"/>
      <text x="50%" y="40%" text-anchor="middle" font-size="24" font-family="sans-serif" fill="#333">
        微信图片测试
      </text>
      <text x="50%" y="55%" text-anchor="middle" font-size="16" font-family="sans-serif" fill="#666">
        WeChat Image Test
      </text>
      <text x="50%" y="70%" text-anchor="middle" font-size="14" font-family="sans-serif" fill="#999">
        ${new Date().toLocaleString("zh-CN")}
      </text>
    </svg>`;

  const imgBuf = await sharp({
    create: {
      width,
      height,
      channels,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .raw()
    .toFormat("png")
    .toBuffer();

  // 把渐变像素写入图片，再叠加 SVG 文字
  const imgData = await sharp(pixels, { raw: { width, height, channels } })
    .composite([{ input: Buffer.from(svgText), top: 0, left: 0 }])
    .png()
    .toBuffer();

  console.log(`生成测试图片: ${imgData.byteLength} bytes`);

  // 连接微信
  const wire = new OpenIlinkWire(snap.token, {
    base_url: snap.baseUrl,
  });

  console.log("正在发送图片...");
  await wire.sendMediaFile(
    snap.lastChatId,
    snap.contextToken,
    imgData,
    "test-image.png",
    "这是一张测试图片",
  );

  console.log("图片发送成功！");
}

main().catch((err) => {
  console.error("发送失败:", err);
  process.exit(1);
});