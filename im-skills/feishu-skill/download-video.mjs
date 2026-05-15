#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DOWNLOAD_DIR = join(homedir(), ".chatccc", "videos", "downloads");

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

function walkUpForConfig(startDir) {
  const result = [];
  let dir = resolve(startDir);
  for (let i = 0; i < 6; i++) {
    result.push(join(dir, "config.json"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return result;
}

async function findConfig() {
  const paths = [
    join(homedir(), ".chatccc", "config.json"),
    ...walkUpForConfig(SCRIPT_DIR),
  ];

  for (const path of paths) {
    try {
      const raw = await readFile(path, "utf-8");
      const cfg = JSON.parse(raw);
      const appId = cfg.feishu?.appId || "";
      const appSecret = cfg.feishu?.appSecret || "";
      if (appId && appSecret) {
        console.error(`Using config: ${path}`);
        return { appId, appSecret };
      }
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error(`Could not find Feishu config. Tried: ${paths.slice(0, 3).join(", ")}...`);
}

async function getTenantAccessToken(appId, appSecret) {
  const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: Buffer.from(JSON.stringify({ app_id: appId, app_secret: appSecret }), "utf8"),
  });
  const data = await response.json();
  if (data.code !== 0) {
    throw new Error(`Failed to get tenant_access_token: [${data.code}] ${data.msg}`);
  }
  return data.tenant_access_token;
}

async function findMessageId(token, chatId, fileKey) {
  let pageToken = "";
  for (let page = 0; page < 10; page++) {
    const url = new URL("https://open.feishu.cn/open-apis/im/v1/messages");
    url.searchParams.set("receive_id_type", "chat_id");
    url.searchParams.set("receive_id", chatId);
    url.searchParams.set("page_size", "50");
    if (pageToken) url.searchParams.set("page_token", pageToken);

    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await response.json();
    if (data.code !== 0) {
      throw new Error(`Failed to list messages: [${data.code}] ${data.msg}`);
    }

    for (const item of data.data?.items ?? []) {
      try {
        if (JSON.parse(item.body?.content ?? "{}").file_key === fileKey) {
          return item.message_id;
        }
      } catch {
        // Ignore non-file messages.
      }
    }

    if (!data.data?.has_more) break;
    pageToken = data.data?.page_token || "";
  }
  return null;
}

function safeFileName(name) {
  return (name || "download.bin").replace(/[\\/:*?"<>|]/g, "_");
}

async function downloadResource(token, messageId, fileKey, fileName) {
  const url = `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}?type=file`;
  console.error(`Downloading: ${url}`);

  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  }

  await mkdir(DOWNLOAD_DIR, { recursive: true });
  const localPath = resolve(DOWNLOAD_DIR, safeFileName(fileName));
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(localPath, buffer);
  return localPath;
}

function usage() {
  console.error(`Usage:
  node download-video.mjs --message-id <message_id> --file-key <file_key> [--name <file_name>]
  node download-video.mjs --chat-id <chat_id> --file-key <file_key> [--name <file_name>]`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args["file-key"]) {
    usage();
    process.exit(1);
  }

  const { appId, appSecret } = await findConfig();
  const token = await getTenantAccessToken(appId, appSecret);

  let messageId = args["message-id"] || "";
  if (!messageId && args["chat-id"]) {
    messageId = await findMessageId(token, args["chat-id"], args["file-key"]);
    if (!messageId) {
      throw new Error(`No message found for file_key=${args["file-key"]}`);
    }
  }

  if (!messageId) {
    usage();
    process.exit(1);
  }

  const localPath = await downloadResource(
    token,
    messageId,
    args["file-key"],
    args.name || "download.bin",
  );
  console.log(localPath);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
