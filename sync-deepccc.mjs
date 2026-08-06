/**
 * 确定性同步：chatccc（私有仓库）的 SYSTEM_PROMPT → deepccc-agent（F:\Users\weizhangjian\deepccc-agent）
 *
 * 背景：deepccc-agent 是 ChatCCC 的旧架构平行版本（0.1.x，ai SDK 版），
 * 两者的系统提示（SYSTEM_PROMPT 常量）必须逐字一致。本脚本保证：
 *   1. 从 chatccc 的 src/builtin/index.ts 提取 SYSTEM_PROMPT 数组
 *   2. 同步到 deepccc-agent 的 src/index.ts（仅替换 SYSTEM_PROMPT 块，不碰其他代码）
 *   3. 在 deepccc-agent 跑护栏测试 + typecheck 验证
 *   4. 报告差异；无差异时提示无需提交
 *
 * 用法:
 *   node sync-deepccc.mjs            # 同步 + 测试（有差异时）
 *   node sync-deepccc.mjs --check    # 只检查差异，不写文件
 *
 * 注意：deepccc-agent 必须在 main 分支且与 origin/main 一致（本脚本会检查并提示）。
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)));
const DST = "F:\\Users\\weizhangjian\\deepccc-agent";

const SRC_FILE = join(SRC, "src", "builtin", "index.ts");
const DST_FILE = join(DST, "src", "index.ts");

const CHECK_ONLY = process.argv.includes("--check");

// 提取 const SYSTEM_PROMPT = [ ... ].join("\n"); 完整块（非贪婪到第一个 ].join）
const SYSTEM_PROMPT_RE = /const SYSTEM_PROMPT = \[[\s\S]*?\n\]\.join\("\\n"\);/;

if (!existsSync(DST) || !existsSync(join(DST, ".git"))) {
  console.error(`[ERROR] ${DST} 不存在或不是 git 仓库`);
  process.exit(1);
}

const runGit = (args, cwd) =>
  execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true })
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);

console.log("=".repeat(60));
console.log("  Sync SYSTEM_PROMPT: chatccc -> deepccc-agent");
console.log(`    src: ${SRC_FILE}`);
console.log(`    dst: ${DST_FILE}`);
console.log("=".repeat(60));
console.log("");

// ---- 前置检查：deepccc-agent 分支与远端状态 ----
const branch = runGit(["branch", "--show-current"], DST)[0] ?? "";
if (branch !== "main") {
  console.error(`[ERROR] deepccc-agent 当前分支是 "${branch}"，必须为 main`);
  process.exit(1);
}
const ahead = runGit(["rev-list", "--count", "origin/main..main"], DST)[0];
if (ahead !== "0") {
  console.error(`[ERROR] deepccc-agent 本地 main 领先 origin/main ${ahead} 个提交，请先处理`);
  process.exit(1);
}
const behind = runGit(["rev-list", "--count", "main..origin/main"], DST)[0];
if (behind !== "0") {
  console.log(`[WARN] deepccc-agent 本地 main 落后 origin/main ${behind} 个提交`);
  console.log("       建议先: git -C F:/Users/weizhangjian/deepccc-agent merge --ff-only origin/main");
  console.log("");
}

// ---- 提取两侧 SYSTEM_PROMPT ----
const srcText = readFileSync(SRC_FILE, "utf8");
const dstText = readFileSync(DST_FILE, "utf8");

const srcBlock = srcText.match(SYSTEM_PROMPT_RE)?.[0];
const dstBlock = dstText.match(SYSTEM_PROMPT_RE)?.[0];

if (!srcBlock) {
  console.error(`[ERROR] 在 chatccc ${SRC_FILE} 中未找到 SYSTEM_PROMPT 块`);
  process.exit(1);
}
if (!dstBlock) {
  console.error(`[ERROR] 在 deepccc-agent ${DST_FILE} 中未找到 SYSTEM_PROMPT 块`);
  process.exit(1);
}

if (srcBlock === dstBlock) {
  console.log("✅ SYSTEM_PROMPT 已一致，无需同步。");
  process.exit(0);
}

console.log("⚠️  SYSTEM_PROMPT 有差异：");
const srcLines = srcBlock.split("\n");
const dstLines = dstBlock.split("\n");
console.log(`  chatccc: ${srcLines.length} 行`);
console.log(`  deepccc-agent: ${dstLines.length} 行`);
console.log("");

if (CHECK_ONLY) {
  console.log("（--check 模式，未写入）");
  console.log("差异预览：");
  const max = Math.max(srcLines.length, dstLines.length);
  for (let i = 0; i < max; i++) {
    const a = srcLines[i] ?? "";
    const b = dstLines[i] ?? "";
    if (a !== b) {
      console.log(`  L${i + 1} chatccc:   ${a}`);
      console.log(`  L${i + 1} deepccc:   ${b}`);
    }
  }
  process.exit(2);
}

// ---- 同步：仅替换 SYSTEM_PROMPT 块 ----
const newDstText = dstText.replace(SYSTEM_PROMPT_RE, () => srcBlock);
writeFileSync(DST_FILE, newDstText, "utf8");
console.log(`✍️  已写入 ${DST_FILE}`);

// ---- 验证：护栏测试 + typecheck ----
console.log("");
console.log("== 运行 deepccc-agent 测试 ==");
try {
  execFileSync("npx", ["vitest", "run"], { cwd: DST, encoding: "utf8", stdio: "inherit", windowsHide: true });
} catch {
  console.error("❌ deepccc-agent 测试失败，请检查");
  process.exit(3);
}

console.log("");
console.log("== typecheck ==");
try {
  execFileSync("node", ["node_modules/typescript/bin/tsc", "--noEmit"], { cwd: DST, encoding: "utf8", stdio: "inherit", windowsHide: true });
} catch {
  console.error("❌ deepccc-agent typecheck 失败，请检查");
  process.exit(4);
}

// ---- 报告后续步骤 ----
const gitDiff = runGit(["diff", "--stat"], DST).join("\n");
console.log("");
console.log("✅ 同步完成。后续步骤：");
console.log(`  git -C ${DST} add -A`);
console.log(`  git -C ${DST} commit -m "feat: 同步系统提示（sync-deepccc.mjs 自动同步）"`);
console.log(`  git -C ${DST} push origin main`);
console.log("  然后 bump 版本 + npm publish（参考 deepccc-agent 发布流程）");
console.log("");
console.log("本次差异：");
console.log(gitDiff);
