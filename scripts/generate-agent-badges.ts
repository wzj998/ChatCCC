// Generate 128x128 agent badge PNGs from official app/brand source images.
// Usage: npx tsx scripts/generate-agent-badges.ts

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import sharp from "sharp";

const OUT_DIR = resolve(import.meta.dirname ?? __dirname, "..", "images", "avatars", "badges");
const SOURCE_DIR = resolve(import.meta.dirname ?? __dirname, "..", "images", "avatars", "brand-sources");
const SIZE = 128;
const ICON_SIZE = 112;

interface BadgeDef {
  name: string;
  source: string;
  rounded?: boolean;
}

const BADGES: BadgeDef[] = [
  {
    name: "claude",
    source: "claude_code_app_icon.png",
  },
  {
    name: "cursor",
    source: "cursor_icon_512.png",
    rounded: true,
  },
  {
    name: "codex",
    source: "codex_app_icon.png",
  },
];

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const def of BADGES) {
    let iconPipeline = sharp(resolve(SOURCE_DIR, def.source))
      .ensureAlpha()
      .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 5 })
      .resize(ICON_SIZE, ICON_SIZE, {
        fit: "contain",
        kernel: sharp.kernel.lanczos3,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .sharpen({ sigma: 0.45, m1: 0.6, m2: 1.8 });

    if (def.rounded) {
      const radius = 24;
      const mask = Buffer.from(`
<svg width="${ICON_SIZE}" height="${ICON_SIZE}" viewBox="0 0 ${ICON_SIZE} ${ICON_SIZE}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${ICON_SIZE}" height="${ICON_SIZE}" rx="${radius}" fill="white"/>
</svg>`);
      iconPipeline = iconPipeline.composite([{ input: mask, blend: "dest-in" }]);
    }

    const icon = await iconPipeline
      .png()
      .toBuffer();
    const png = await sharp({
      create: {
        width: SIZE,
        height: SIZE,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([{ input: icon, left: Math.round((SIZE - ICON_SIZE) / 2), top: Math.round((SIZE - ICON_SIZE) / 2) }])
      .png()
      .toBuffer();
    const outPath = resolve(OUT_DIR, `badge_${def.name}.png`);
    writeFileSync(outPath, png);
    console.log(`Wrote ${outPath} (${png.length} bytes)`);
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
