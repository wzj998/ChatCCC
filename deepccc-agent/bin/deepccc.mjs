#!/usr/bin/env node
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const pkgRoot = dirname(require.resolve("../package.json"));
const distCli = join(pkgRoot, "dist", "cli.js");

let args;
if (existsSync(distCli)) {
  args = [distCli, ...process.argv.slice(2)];
} else {
  const tsxCli = require.resolve("tsx/cli");
  const sourceCli = join(pkgRoot, "src", "cli.ts");
  args = [tsxCli, sourceCli, ...process.argv.slice(2)];
}

const result = spawnSync(process.execPath, args, {
  stdio: "inherit",
  cwd: process.cwd(),
  env: process.env,
});

process.exit(result.status === null ? 1 : result.status);
