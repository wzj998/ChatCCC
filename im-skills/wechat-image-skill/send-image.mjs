#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";

import { Client as OpenIlinkWire } from "@openilink/openilink-sdk-node";

const ILINK_AUTH_PATH = join(homedir(), ".chatccc", "state", "ilink-auth.json");
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ALLOWED_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    result[key.slice(2)] = value;
  }
  return result;
}

function usage() {
  console.error(`Usage:
  node ${basename(process.argv[1])} --path <absolute image path> [--caption <text>]`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const imagePath = args.path;
  const caption = args.caption || "";

  if (!imagePath) {
    usage();
    process.exit(1);
  }
  if (!isAbsolute(imagePath)) {
    console.error("Image path must be absolute.");
    process.exit(1);
  }

  const ext = extname(imagePath).toLowerCase();
  if (!ALLOWED_EXTS.has(ext)) {
    console.error(`Unsupported image extension: ${ext || "(none)"}`);
    process.exit(1);
  }

  const st = statSync(imagePath);
  if (!st.isFile()) {
    console.error("Image path is not a file");
    process.exit(1);
  }
  if (st.size > MAX_IMAGE_BYTES) {
    console.error("Image file exceeds 10MB limit");
    process.exit(1);
  }

  if (!existsSync(ILINK_AUTH_PATH)) {
    console.error(`Auth snapshot not found: ${ILINK_AUTH_PATH}`);
    console.error("Make sure the WeChat iLink platform is logged in.");
    process.exit(1);
  }

  const snap = JSON.parse(readFileSync(ILINK_AUTH_PATH, "utf8"));
  if (!snap.token || !snap.lastChatId || !snap.contextToken) {
    console.error("Auth snapshot missing token, lastChatId, or contextToken.");
    process.exit(1);
  }

  const imgData = readFileSync(imagePath);
  const fileName = basename(imagePath);

  const wire = new OpenIlinkWire(snap.token, {
    base_url: snap.baseUrl,
  });

  await wire.sendMediaFile(snap.lastChatId, snap.contextToken, imgData, fileName, caption);
  console.log(JSON.stringify({ ok: true, sentTo: 1 }));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
