#!/usr/bin/env node
import { basename } from "node:path";

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
  node ${basename(process.argv[1])} --url <url> --token <token> --path <absolute image path> [--caption <text>]`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = args.url || process.env.CHATCCC_SEND_IMAGE_URL;
  const token = args.token || process.env.CHATCCC_SEND_IMAGE_TOKEN;
  const path = args.path;
  const caption = args.caption || "";

  if (!url || !token || !path) {
    usage();
    process.exit(1);
  }

  const body = Buffer.from(JSON.stringify({ path, caption }), "utf8");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body,
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
  console.log(text);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
