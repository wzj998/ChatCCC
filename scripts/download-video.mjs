/**
 * 临时脚本：下载飞书视频/文件消息到本地
 * 用法: node scripts/download-video.mjs --chat-id <chat_id> --file-key <file_key> [--name <name>]
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve as resolvePath, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolvePath(__dirname, "..");
const USER_DATA_DIR = join(homedir(), ".chatccc");
const CONFIG_PATHS = [join(USER_DATA_DIR, "config.json"), join(PROJECT_ROOT, "config.json")];

async function findConfig() {
  for (const configFile of CONFIG_PATHS) {
    try {
      const raw = await readFile(configFile, "utf-8");
      const cfg = JSON.parse(raw);
      const appId = cfg.feishu?.appId ?? "";
      const appSecret = cfg.feishu?.appSecret ?? "";
      const domain = cfg.feishu?.domain ?? "feishu";
      const baseUrl = domain === "lark"
        ? "https://open.larksuite.com/open-apis"
        : "https://open.feishu.cn/open-apis";
      if (appId && appSecret) { console.log(`使用配置: ${configFile}`); return { appId, appSecret, baseUrl }; }
    } catch { /* skip */ }
  }
  throw new Error(`找不到飞书配置。尝试了: ${CONFIG_PATHS.join(", ")}`);
}

async function getTenantAccessToken(appId, appSecret, baseUrl) {
  const resp = await fetch(`${baseUrl}/auth/v3/tenant_access_token/internal`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const data = await resp.json();
  if (data.code !== 0) throw new Error(`获取 token 失败: [${data.code}] ${data.msg}`);
  return data.tenant_access_token;
}

async function findMessageId(token, baseUrl, chatId, fileKey) {
  let pageToken, page = 0;
  while (page < 10) {
    page++;
    let url = `${baseUrl}/im/v1/messages?receive_id_type=chat_id&receive_id=${chatId}&page_size=50`;
    if (pageToken) url += `&page_token=${pageToken}`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await resp.json();
    if (data.code !== 0) throw new Error(`列出消息失败: [${data.code}] ${data.msg}`);
    for (const item of data.data?.items ?? []) {
      try { if (JSON.parse(item.body?.content ?? "{}").file_key === fileKey) return item.message_id; } catch { /* skip */ }
    }
    if (!data.data?.has_more) break;
    pageToken = data.data?.page_token;
  }
  return null;
}

async function downloadMedia(token, baseUrl, messageId, fileKey, fileName) {
  const url = `${baseUrl}/im/v1/messages/${messageId}/resources/${fileKey}?type=file`;
  console.log(`下载: ${url}`);
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) { const t = await resp.text().catch(() => ""); throw new Error(`HTTP ${resp.status}: ${t.slice(0, 200)}`); }
  const buffer = Buffer.from(await resp.arrayBuffer());
  const videoDir = join(USER_DATA_DIR, "videos", "downloads");
  await mkdir(videoDir, { recursive: true });
  const localPath = resolvePath(videoDir, fileName);
  await writeFile(localPath, buffer);
  return localPath;
}

function parseArgs(args) {
  const r = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--chat-id" || args[i] === "--file-key" || args[i] === "--name") r[args[i]] = args[++i] ?? "";
  }
  return r;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args["--chat-id"] || !args["--file-key"]) {
    console.error("用法: node scripts/download-video.mjs --chat-id <chat_id> --file-key <file_key> [--name <name>]");
    process.exit(1);
  }
  const { appId, appSecret, baseUrl } = await findConfig();
  console.log("获取 tenant_access_token ...");
  const token = await getTenantAccessToken(appId, appSecret, baseUrl);
  console.log("已获取 token");
  const fileName = args["--name"] || "video.mp4";
  console.log(`在群 ${args["--chat-id"]} 中查找 file_key=${args["--file-key"]} ...`);
  const messageId = await findMessageId(token, baseUrl, args["--chat-id"], args["--file-key"]);
  if (!messageId) throw new Error(`未找到 file_key=${args["--file-key"]} 对应的消息`);
  console.log(`找到 message_id=${messageId}`);
  const localPath = await downloadMedia(token, baseUrl, messageId, args["--file-key"], fileName);
  console.log(`下载完成: ${localPath}`);
}

main().catch((err) => { console.error("失败:", err.message); process.exit(1); });