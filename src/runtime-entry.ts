import { existsSync } from "node:fs";
import { join } from "node:path";

export interface RuntimeSpawnSpec {
  command: string;
  args: string[];
}

/** Use compiled JavaScript in installed packages, with a tsx fallback for source checkouts. */
export function resolveChatCccRuntimeSpawnSpec(projectRoot: string): RuntimeSpawnSpec {
  const compiledEntry = join(projectRoot, "dist", "src", "index.js");
  if (existsSync(compiledEntry)) {
    return { command: process.execPath, args: [compiledEntry] };
  }
  return {
    command: process.execPath,
    args: [join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs"), "src/index.ts"],
  };
}
