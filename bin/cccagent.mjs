#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const pkgRoot = dirname(require.resolve("../package.json"));
const cliTs = join(pkgRoot, "src", "builtin", "cli.ts");
const tsxCli = require.resolve("tsx/cli");

const result = spawnSync(process.execPath, [tsxCli, cliTs, ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: process.cwd(),
  env: process.env,
});

process.exit(result.status === null ? 1 : result.status);
