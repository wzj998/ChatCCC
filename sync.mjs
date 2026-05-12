/**
 * 同步私有仓库文件到公有仓库（跨平台）
 * 用法: node sync.mjs
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)));
const DST = join(homedir(), "ChatCCC");

if (!existsSync(join(DST, ".git"))) {
  console.error(`[ERROR] ${DST} not found or not a git repo`);
  process.exit(1);
}

console.log("=".repeat(60));
console.log(`  Sync: ${SRC}`);
console.log(`    -> ${DST}`);
console.log("=".repeat(60));
console.log("");

const runGit = (args, cwd) =>
  execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true })
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);

const tracked = runGit(["ls-files"], SRC);
const untracked = runGit(["ls-files", "--others", "--exclude-standard"], SRC);

let copied = 0;
const failed = [];

function syncFile(file) {
  const src = join(SRC, file);
  const dst = join(DST, file);
  if (!existsSync(src)) { failed.push(`MISSING: ${file}`); return; }
  const dstDir = dirname(dst);
  if (!existsSync(dstDir)) mkdirSync(dstDir, { recursive: true });
  try { copyFileSync(src, dst); copied++; } catch (e) { failed.push(`COPY: ${file} — ${e.message}`); }
}

// Step 1: copy tracked files
console.log(`[1/3] Copying tracked files (${tracked.length} files)...`);
for (const f of tracked) syncFile(f);

// Step 2: copy untracked but non-ignored files
console.log(`[2/3] Copying untracked but non-ignored files (${untracked.length} files)...`);
for (const f of untracked) syncFile(f);

// Step 3: remove stale files from dest
const srcSet = new Set([...tracked, ...untracked]);
const dstTracked = runGit(["ls-files"], DST);
const toRemove = dstTracked.filter((f) => !srcSet.has(f));

let removed = 0;
if (toRemove.length > 0) {
  console.log(`[3/3] Removing ${toRemove.length} files no longer in source repo...`);
  for (const f of toRemove) {
    console.log(`  REMOVE: ${f}`);
    try { execFileSync("git", ["rm", "-q", "--", f], { cwd: DST, windowsHide: true }); removed++; }
    catch { failed.push(`REMOVE: ${f}`); }
  }
} else {
  console.log("[3/3] No files to remove");
}

console.log("");
console.log(`Done. Copied: ${copied}, Removed: ${removed}, Failed: ${failed.length}`);
if (failed.length > 0) for (const e of failed) console.log(`  [FAIL] ${e}`);