#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
// 相对 bin/chatccc.mjs 解析 package.json，包根目录不依赖 cwd，也不会多退一级到 node_modules
const pkgRoot = dirname(require.resolve("../package.json"));
const indexTs = join(pkgRoot, "src", "index.ts");
const tsxCli = require.resolve("tsx/cli");

// 与 npm run dev 一致：当前工作目录下的 .env 会被加载（全局安装时 cwd 一般为你的项目根）
const envFile = join(process.cwd(), ".env");
if (!existsSync(envFile)) {
  console.error(`[chatccc] 当前目录下未找到 .env，不会自动加载环境变量： ${envFile}`);
  console.error("  将只使用系统/用户环境变量。若未设置 CHATCCC_APP_ID / CHATCCC_APP_SECRET，启动会失败。");
  console.error("  建议: cd 到项目根目录，复制 .env.example 为 .env 并填写后再运行 chatccc。\n");
}
const tsxArgs = existsSync(envFile)
  ? [tsxCli, "--env-file", envFile, indexTs, ...process.argv.slice(2)]
  : [tsxCli, indexTs, ...process.argv.slice(2)];

const result = spawnSync(process.execPath, tsxArgs, {
  stdio: "inherit",
  cwd: process.cwd(),
  env: process.env,
});

const code = result.status === null ? 1 : result.status;
if (code !== 0) {
  console.error("[ 未启动 ]");
  console.error("chatccc 子进程已结束，服务没有在后台运行。");
}

process.exit(code);
