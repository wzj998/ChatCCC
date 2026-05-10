#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
// 相对 bin/chatccc.mjs 解析 package.json，包根目录不依赖 cwd，也不会多退一级到 node_modules
const pkgRoot = dirname(require.resolve("../package.json"));
const indexTs = join(pkgRoot, "src", "index.ts");
const tsxCli = require.resolve("tsx/cli");

const result = spawnSync(
  process.execPath,
  [tsxCli, indexTs, ...process.argv.slice(2)],
  { stdio: "inherit", cwd: process.cwd(), env: process.env }
);

process.exit(result.status === null ? 1 : result.status);
