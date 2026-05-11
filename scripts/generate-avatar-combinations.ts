// Generate 3x3 status x agent avatar combinations.
// Usage: npx tsx scripts/generate-avatar-combinations.ts

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import sharp from "sharp";

const AVATAR_DIR = resolve(import.meta.dirname ?? __dirname, "..", "images", "avatars");
const BADGE_DIR = resolve(AVATAR_DIR, "badges");
const OUT_DIR = resolve(AVATAR_DIR, "combinations");

const BADGE_SIZE = 92;
const BADGE_MARGIN = 10;
const CANVAS_SIZE = 256;

const ALL_AGENTS = ["claude", "cursor", "codex"] as const;
const STATUSES = ["new", "busy", "idle"] as const;

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const requestedAgents = new Set(process.argv.slice(2));
  const agents = requestedAgents.size > 0
    ? ALL_AGENTS.filter((agent) => requestedAgents.has(agent))
    : [...ALL_AGENTS];

  for (const agent of agents) {
    const badge = await sharp(resolve(BADGE_DIR, `badge_${agent}.png`))
      .resize(BADGE_SIZE, BADGE_SIZE, {
        fit: "contain",
        kernel: sharp.kernel.lanczos3,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();

    for (const status of STATUSES) {
      const base = resolve(AVATAR_DIR, `status_${status}.png`);
      const out = resolve(OUT_DIR, `avatar_${agent}_${status}.png`);
      const png = await sharp(base)
        .resize(CANVAS_SIZE, CANVAS_SIZE, { fit: "cover" })
        .composite([
          {
            input: badge,
            left: CANVAS_SIZE - BADGE_SIZE - BADGE_MARGIN,
            top: CANVAS_SIZE - BADGE_SIZE - BADGE_MARGIN,
          },
        ])
        .png()
        .toBuffer();
      writeFileSync(out, png);
      console.log(`Wrote ${out} (${png.length} bytes)`);
    }
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
