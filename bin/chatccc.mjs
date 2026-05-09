#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
// bin/ 的上一级才是 chatccc 包根；勿对 new URL("..") 再 dirname，否则会退到 node_modules
const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const indexTs = join(pkgRoot, "src", "index.ts");
const tsxCli = require.resolve("tsx/cli");

const result = spawnSync(
  process.execPath,
  [tsxCli, indexTs, ...process.argv.slice(2)],
  { stdio: "inherit", cwd: process.cwd(), env: process.env }
);

process.exit(result.status === null ? 1 : result.status);
