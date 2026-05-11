// Generate ChatCCC status avatars as 256x256 PNG files.
// Usage: npx tsx scripts/generate-avatars.ts

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import sharp from "sharp";

const AVATAR_DIR = resolve(import.meta.dirname ?? __dirname, "..", "images", "avatars");
const SIZE = 256;

type RGB = [number, number, number];

function rgb(color: RGB): string {
  return `rgb(${color[0]},${color[1]},${color[2]})`;
}

interface AvatarDef {
  bg: RGB;
  char: string;
}

const AVATARS: Record<string, AvatarDef> = {
  new: { bg: [46, 125, 50], char: "新" },
  busy: { bg: [239, 108, 0], char: "忙" },
  idle: { bg: [69, 90, 100], char: "闲" },
};

function textSVG(char: string): string {
  return [
    `<text x="131" y="136" text-anchor="middle" dominant-baseline="central" font-family="Arial, 'Microsoft YaHei', 'PingFang SC', sans-serif" font-weight="bold" font-size="150" fill="rgba(0,0,0,0.2)">${char}</text>`,
    `<text x="128" y="133" text-anchor="middle" dominant-baseline="central" font-family="Arial, 'Microsoft YaHei', 'PingFang SC', sans-serif" font-weight="bold" font-size="150" fill="white">${char}</text>`,
  ].join("\n");
}

async function renderAvatar(bg: RGB, char: string): Promise<Buffer> {
  const icon = textSVG(char);

  const svg = [
    `<svg width="${SIZE}" height="${SIZE}" xmlns="http://www.w3.org/2000/svg">`,
    `  <rect width="${SIZE}" height="${SIZE}" fill="${rgb(bg)}"/>`,
    icon.split("\n").map((l) => `  ${l}`).join("\n"),
    `</svg>`,
  ].join("\n");

  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function main(): Promise<void> {
  for (const [name, { bg, char }] of Object.entries(AVATARS)) {
    const png = await renderAvatar(bg, char);
    const outPath = resolve(AVATAR_DIR, `status_${name}.png`);
    writeFileSync(outPath, png);
    console.log(`Wrote ${outPath} (${png.length} bytes)`);
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});