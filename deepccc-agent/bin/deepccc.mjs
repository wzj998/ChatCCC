#!/usr/bin/env node
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const pkgRoot = dirname(require.resolve("../package.json"));
const rawArgs = process.argv.slice(2);
const distWebEntry = join(pkgRoot, "dist", "web-entry.js");
const distCli = join(pkgRoot, "dist", "cli.js");
const sourceMode = !existsSync(distWebEntry);
const isLegacy = rawArgs.length > 0 && rawArgs[0] !== "web" && !["--reuse-existing", "--port", "--no-open", "--help", "-h"].includes(rawArgs[0]);

if (isLegacy) {
  console.error("[DeepCCC] CLI commands have moved to deepccc-cli; forwarding this invocation for compatibility.");
  const args = sourceMode
    ? [require.resolve("tsx/cli"), join(pkgRoot, "src", "cli.ts"), ...rawArgs]
    : [distCli, ...rawArgs];
  const result = spawnSync(process.execPath, args, { stdio: "inherit", cwd: process.cwd(), env: process.env });
  process.exit(result.status === null ? 1 : result.status);
}

if (sourceMode) {
  const result = spawnSync(process.execPath, [require.resolve("tsx/cli"), join(pkgRoot, "src", "web-entry.ts"), ...rawArgs], {
    stdio: "inherit", cwd: process.cwd(), env: process.env,
  });
  process.exit(result.status === null ? 1 : result.status);
}

const { runWebEntry } = await import(new URL("../dist/web-entry.js", import.meta.url));
await runWebEntry(rawArgs);
