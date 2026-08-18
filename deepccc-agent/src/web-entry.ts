import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { startDeepCccWebServer, type StartDeepCccWebOptions } from "./web-server.js";

export interface ParsedWebEntryArgs extends Pick<StartDeepCccWebOptions, "port" | "openBrowser" | "reuseExisting"> {}

const WEB_FLAGS = new Set(["web", "--reuse-existing", "--port", "--no-open", "--help", "-h"]);

export function isLegacyCliInvocation(args: string[]): boolean {
  if (!args.length) return false;
  if (args[0] === "web") return false;
  return !WEB_FLAGS.has(args[0]!);
}

export function parseWebEntryArgs(rawArgs: string[]): ParsedWebEntryArgs {
  const args = rawArgs[0] === "web" ? rawArgs.slice(1) : [...rawArgs];
  if (args.includes("--help") || args.includes("-h")) return {};
  let port: number | undefined;
  let openBrowser: boolean | undefined;
  let reuseExisting = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--reuse-existing") reuseExisting = true;
    else if (arg === "--no-open") openBrowser = false;
    else if (arg === "--port") {
      const value = Number(args[++index]);
      if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error("--port must be an integer between 1 and 65535");
      port = value;
    } else {
      throw new Error(`Unknown DeepCCC Web option: ${arg}`);
    }
  }
  return {
    reuseExisting,
    ...(port ? { port } : {}),
    ...(openBrowser === false ? { openBrowser: false } : {}),
  };
}

export function printWebHelp(): void {
  console.log([
    "DeepCCC Web UI",
    "",
    "Usage: deepccc [web] [options]",
    "",
    "  --reuse-existing   Reuse an existing verified DeepCCC Web instance",
    "  --port <port>      Override config.web.port for this run",
    "  --no-open          Do not open the browser automatically",
    "  --help             Show this help",
    "",
    "Terminal CLI: deepccc-cli [options]",
  ].join("\n"));
}

export async function runWebEntry(rawArgs = process.argv.slice(2)): Promise<void> {
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    printWebHelp();
    return;
  }
  const options = parseWebEntryArgs(rawArgs);
  const handle = await startDeepCccWebServer(options);
  console.log(`DeepCCC Web UI: ${handle.url}${handle.reused ? " (reused existing server)" : ""}`);
}

function isDirectInvocation(): boolean {
  return resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] ?? "");
}

if (isDirectInvocation()) {
  runWebEntry().catch((err) => {
    console.error(`DeepCCC Web startup failed: ${(err as Error).message}`);
    process.exit(1);
  });
}
