/**
 * Permission Check Demo (TypeScript)
 * ==================================
 * Tests that the bot has all required Feishu API permissions.
 * Run this before using other demos to verify your app configuration.
 *
 * Usage:
 *   npx tsx --env-file=.env demo/permission_check.ts
 *
 * Required permissions (configure in Feishu Developer Console):
 *
 *   API Permissions (权限管理):
 *     im:chat              — 创建群聊、获取群信息
 *     im:chat:member       — 添加/移除群成员
 *     im:message           — 发送消息
 *     im:message:send_as_bot — 以机器人身份发送消息（通常内置）
 *
 *   Event Subscriptions (事件订阅):
 *     im.message.receive_v1 — 接收消息事件
 *     ☑ 开启"机器人接收群聊中所有消息"（否则只能收到 @机器人 的消息）
 *
 *   Permission Scopes (权限范围) — 在"权限管理"中:
 *     通讯录           — 获取用户信息（拉人进群需要知道用户 open_id）
 *     消息与群组        — 获取群信息、发送消息、创建群聊
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  setupFileLogging,
  ensureSingleInstance,
  createRelayServer,
  freeRelayListenPort,
} from "../src/shared.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const PID_FILE = join(PROJECT_ROOT, ".claude", "runtime.pid");

const logDir = join(__dirname, "logs");
setupFileLogging(logDir, "permission-check");

const APP_ID: string = process.env.CHATCCC_APP_ID ?? "";
const APP_SECRET: string = process.env.CHATCCC_APP_SECRET ?? "";
const BASE_URL = "https://open.feishu.cn/open-apis";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ApiError {
  code: number;
  msg: string;
}

interface CheckResult {
  name: string;
  scope: string;
  passed: boolean;
  detail: string;
  howToFix?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function api(method: string, path: string, token: string, body?: unknown): Promise<{ ok: boolean; code: number; msg: string; data?: unknown }> {
  try {
    const resp = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await resp.json() as Record<string, unknown>;
    const code = (json.code ?? -1) as number;
    return {
      ok: code === 0,
      code,
      msg: (json.msg ?? "") as string,
      data: json.data,
    };
  } catch (err) {
    return { ok: false, code: -1, msg: (err as Error).message };
  }
}

async function getToken(): Promise<string> {
  const resp = await fetch(`${BASE_URL}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const data = (await resp.json()) as { code: number; msg?: string; tenant_access_token: string };
  if (data.code !== 0) throw new Error(`Cannot get token: ${data.msg}`);
  return data.tenant_access_token;
}

// ---------------------------------------------------------------------------
// Permission checks
// ---------------------------------------------------------------------------

async function checkCreateChat(token: string): Promise<CheckResult> {
  // 尝试创建一个只有 bot 自己的群，然后立即解散
  const result = await api("POST", "/im/v1/chats", token, {
    name: "permission-test",
    description: "Auto-created by permission check, will be deleted",
  });

  if (result.ok) {
    const chatId = (result.data as { chat_id?: string })?.chat_id;
    if (chatId) await api("DELETE", `/im/v1/chats/${chatId}`, token);
    return { name: "创建群聊", scope: "im:chat", passed: true, detail: "可以创建群聊" };
  }

  if (result.code === 99991672 || result.code === 230002) {
    return {
      name: "创建群聊", scope: "im:chat", passed: false,
      detail: `API 返回错误: [${result.code}] ${result.msg}`,
      howToFix: "在飞书开发者后台 → 权限管理 → 搜索 im:chat → 开通",
    };
  }

  return { name: "创建群聊", scope: "im:chat", passed: false, detail: `[${result.code}] ${result.msg}` };
}

async function checkAddMember(token: string): Promise<CheckResult> {
  // 尝试获取一个不存在的群的成员列表
  // 如果有 im:chat:member 权限 → 应返回 chat not found (如 230001)
  // 如果没有权限 → 返回 99991672 Access denied
  const result = await api("GET", "/im/v1/chats/oc_nonexistent/members?member_id_type=open_id", token);

  if (result.code === 99991672 || result.code === 230002) {
    return {
      name: "添加/查看群成员", scope: "im:chat:member", passed: false,
      detail: `API 返回错误: [${result.code}] ${result.msg}`,
      howToFix: "在飞书开发者后台 → 权限管理 → 搜索 im:chat:member → 开通",
    };
  }

  // 其他错误码（如 230001 chat not found）说明能通过权限校验
  return { name: "添加/查看群成员", scope: "im:chat:member", passed: true, detail: "权限已开通" };
}

async function checkSendMessage(token: string): Promise<CheckResult> {
  // 尝试向不存在的 chat 发消息
  // 有 im:message 权限 → 返回 chat not found 之类的错误
  // 无权限 → 返回 99991672 Access denied
  const card = JSON.stringify({ config: { wide_screen_mode: true } });
  const result = await api(
    "POST",
    "/im/v1/messages?receive_id_type=chat_id",
    token,
    { receive_id: "oc_nonexistent", msg_type: "interactive", content: card }
  );

  if (result.code === 99991672 || result.code === 230002) {
    return {
      name: "发送消息", scope: "im:message", passed: false,
      detail: `API 返回错误: [${result.code}] ${result.msg}`,
      howToFix: "在飞书开发者后台 → 权限管理 → 搜索 im:message → 开通",
    };
  }

  return { name: "发送消息", scope: "im:message", passed: true, detail: "权限已开通" };
}

function checkGroupMessageConfig(): CheckResult {
  // 这个权限无法通过 API 测试，是开发者后台的配置项
  return {
    name: "接收群聊全部消息",
    scope: "事件订阅配置项",
    passed: false, // 标记为需要手动确认
    detail:
      '此项无法通过 API 自动检测。请在飞书开发者后台 → 事件订阅 → im.message.receive_v1 → 开启"机器人接收群聊中所有消息"。如未开启，机器人在群聊中只能收到 @ 它的消息。',
    howToFix:
      '飞书开发者后台 → 事件订阅 → 找到 im.message.receive_v1 → 点击配置 → 勾选"机器人接收群聊中所有消息"',
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  ensureSingleInstance(PID_FILE);
  freeRelayListenPort(18080);
  const { server: relayServer } = createRelayServer(18080);

  console.log(`\n${"=".repeat(60)}`);
  console.log("  Feishu Bot Permission Check");
  console.log(`${"=".repeat(60)}`);
  console.log(`  App ID: ${APP_ID.slice(0, 10)}...`);
  console.log(`${"=".repeat(60)}\n`);

  if (!APP_ID || !APP_SECRET) {
    console.log("ERROR: CHATCCC_APP_ID / CHATCCC_APP_SECRET not set");
    process.exit(1);
  }

  // 获取 token
  let token: string;
  try {
    token = await getToken();
    console.log("[AUTH] Token obtained\n");
  } catch (err) {
    console.error(`FATAL: ${(err as Error).message}`);
    console.log("\n请检查 .env 中的 CHATCCC_APP_ID / CHATCCC_APP_SECRET 是否正确");
    process.exit(1);
  }

  // 运行权限检查
  const results: CheckResult[] = [];

  console.log("Running permission checks...\n");

  results.push(await checkCreateChat(token));
  results.push(await checkAddMember(token));
  results.push(await checkSendMessage(token));
  results.push(checkGroupMessageConfig());

  // 报告
  console.log(`${"=".repeat(60)}`);
  console.log("  Permission Check Report");
  console.log(`${"=".repeat(60)}\n`);

  const autoChecks = results.filter((r) => r.scope !== "事件订阅配置项");
  const passed = autoChecks.filter((r) => r.passed).length;
  const failed = autoChecks.filter((r) => !r.passed).length;

  for (const r of results) {
    const icon = r.passed ? "PASS" : (r.scope === "事件订阅配置项" ? "????" : "FAIL");
    console.log(`  ${icon}  ${r.name}  (${r.scope})`);
    console.log(`       ${r.detail}`);
    if (r.howToFix) {
      console.log(`       → ${r.howToFix}`);
    }
    console.log();
  }

  // 汇总
  console.log(`${"=".repeat(60)}`);
  console.log(`  自动检测: ${passed} 通过, ${failed} 失败`);
  console.log(`  需手动确认: 1 项 (接收群聊全部消息)`);
  console.log(`${"=".repeat(60)}`);

  if (failed > 0) {
    console.log("\n请根据上面的提示在飞书开发者后台开通缺失的权限，然后重新运行本程序。");
  } else {
    console.log("\n所有 API 权限已就绪！");
    console.log("请根据上面的提示确认\"接收群聊全部消息\"事件配置。");
  }

  relayServer.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err: Error) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
