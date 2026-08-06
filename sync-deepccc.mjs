/**
 * 目录级确定性同步：chatccc 仓库内 deepccc-agent/ 子目录（唯一内核主战场）
 *   → F:\Users\weizhangjian\deepccc-agent（发布镜像仓库，保留 .git/remote）
 *
 * 背景：deepccc-agent 是独立 npm 包（wzj998/deepccc-agent），内核代码以 chatccc
 * 仓库的 deepccc-agent/ 子目录为主战场（chatccc 运行时直接 import 子目录源码）。
 * 本脚本保证镜像仓库与子目录逐文件一致（多的删、少的补、不同的改），
 * 并跑护栏测试 + typecheck 验证后提示后续发布步骤。
 *
 * 用法:
 *   node sync-deepccc.mjs            # 同步 + 验证（有差异时）
 *   node sync-deepccc.mjs --check    # 只检查差异，不写文件
 *
 * 注意：deepccc-agent 镜像必须在 main 分支且与 origin/main 一致（本脚本会检查）。
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)));
const DST = "F:\\Users\\weizhangjian\\deepccc-agent";
const SUBDIR = "deepccc-agent";

const CHECK_ONLY = process.argv.includes("--check");

if (!existsSync(DST) || !existsSync(join(DST, ".git"))) {
  console.error(`[ERROR] ${DST} 不存在或不是 git 仓库`);
  process.exit(1);
}

const runGit = (args, cwd) =>
  execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true })
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);

const sha256 = (file) =>
  createHash("sha256").update(existsSync(file) ? readFileSync(file) : "").digest("hex");

console.log("=".repeat(60));
console.log("  Sync deepccc-agent/ (chatccc 子目录) -> 发布镜像");
console.log(`    src: ${join(SRC, SUBDIR)}`);
console.log(`    dst: ${DST}`);
console.log("=".repeat(60));
console.log("");

// ---- 前置检查：镜像仓库分支与远端状态 ----
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

// ---- 收集源文件集合（tracked + untracked 非忽略）----
const tracked = runGit(["ls-files", SUBDIR], SRC);
const untracked = runGit(["ls-files", "--others", "--exclude-standard", SUBDIR], SRC);
const allSrc = [...tracked, ...untracked];

const toRel = (f) => f.replace(/^deepccc-agent[\\/]/, "");
const srcRelSet = new Set(allSrc.map(toRel));

const dstTracked = runGit(["ls-files"], DST);
const dstRelSet = new Set(dstTracked);

const missingInDst = [...srcRelSet].filter((rel) => !existsSync(join(DST, rel)));
const extraInDst = dstTracked.filter((rel) => !srcRelSet.has(rel));
const common = [...srcRelSet].filter((rel) => dstRelSet.has(rel));
const contentDiff = common.filter((rel) => sha256(join(SRC, SUBDIR, rel)) !== sha256(join(DST, rel)));

const hasDiff = missingInDst.length > 0 || extraInDst.length > 0 || contentDiff.length > 0;

if (!hasDiff) {
  console.log("✅ deepccc-agent 子目录与镜像仓库已逐字一致，无需同步。");
  process.exit(0);
}

console.log(`⚠️  有差异：缺 ${missingInDst.length}，多 ${extraInDst.length}，内容不同 ${contentDiff.length}`);
if (missingInDst.length > 0) console.log(`  缺: ${missingInDst.join(", ")}`);
if (extraInDst.length > 0) console.log(`  多: ${extraInDst.join(", ")}`);
if (contentDiff.length > 0) console.log(`  改: ${contentDiff.slice(0, 30).join(", ")}${contentDiff.length > 30 ? ` ...(共 ${contentDiff.length})` : ""}`);

if (CHECK_ONLY) {
  console.log("（--check 模式，未写入）");
  process.exit(2);
}

// ---- 同步：多的删、少的补、不同的改 ----
let copied = 0;
const failed = [];
for (const rel of srcRelSet) {
  const srcFile = join(SRC, SUBDIR, rel);
  const dstFile = join(DST, rel);
  if (!existsSync(srcFile)) { failed.push(`MISSING: ${rel}`); continue; }
  const dstDir = join(DST, dirname(rel));
  if (!existsSync(dstDir)) mkdirSync(dstDir, { recursive: true });
  try { copyFileSync(srcFile, dstFile); copied++; } catch (e) { failed.push(`COPY: ${rel} — ${e.message}`); }
}

let removed = 0;
for (const rel of extraInDst) {
  try { execFileSync("git", ["rm", "-q", "--", rel], { cwd: DST, windowsHide: true }); removed++; }
  catch { failed.push(`REMOVE: ${rel}`); }
}

console.log(`✍️  已写入 ${copied} 个文件，移除 ${removed} 个文件${failed.length > 0 ? `，失败 ${failed.length} 个` : ""}`);
if (failed.length > 0) {
  for (const e of failed) console.error(`  [FAIL] ${e}`);
  process.exit(3);
}

// ---- 验证：护栏测试 + typecheck ----
console.log("");
console.log("== 运行 deepccc-agent 镜像测试 ==");
try {
  execFileSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run"], { cwd: DST, encoding: "utf8", stdio: "inherit", windowsHide: true });
} catch {
  console.error("❌ deepccc-agent 测试失败，请检查");
  process.exit(4);
}

console.log("");
console.log("== typecheck ==");
try {
  execFileSync("node", ["node_modules/typescript/bin/tsc", "--noEmit"], { cwd: DST, encoding: "utf8", stdio: "inherit", windowsHide: true });
} catch {
  console.error("❌ deepccc-agent typecheck 失败，请检查");
  process.exit(5);
}

// ---- 报告后续步骤 ----
const gitDiff = runGit(["diff", "--stat"], DST).join("\n");
console.log("");
console.log("✅ 同步完成。后续步骤：");
console.log(`  git -C ${DST} add -A`);
console.log(`  git -C ${DST} commit -m "feat: 同步 deepccc 内核（chatccc deepccc-agent 子目录）"`);
console.log(`  git -C ${DST} push origin main`);
console.log("  然后 bump 版本 + npm publish（参考 deepccc-agent 发布流程）");
console.log("");
console.log("本次差异：");
console.log(gitDiff);
