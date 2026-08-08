#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const pkgRoot = dirname(require.resolve("../package.json"));
const compiledEntry = join(pkgRoot, "dist", "deepccc-agent", "src", "cli.js");
let args;
if (existsSync(compiledEntry)) {
  args = [compiledEntry, ...process.argv.slice(2)];
} else {
  // Development checkout fallback. Published packages always contain dist/.
  const cliTs = join(pkgRoot, "deepccc-agent", "src", "cli.ts");
  const tsxCli = require.resolve("tsx/cli");
  args = [tsxCli, cliTs, ...process.argv.slice(2)];
}

const result = spawnSync(process.execPath, args, {
  stdio: "inherit",
  cwd: process.cwd(),
  env: process.env,
});

process.exit(result.status === null ? 1 : result.status);
