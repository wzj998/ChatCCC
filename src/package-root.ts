import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

/** Locate the installed ChatCCC package root from either src/ or dist/src/. */
export function findChatCccPackageRoot(startDir = dirname(fileURLToPath(import.meta.url))): string {
  let current = startDir;
  const filesystemRoot = parse(current).root;

  while (true) {
    const packagePath = join(current, "package.json");
    if (existsSync(packagePath)) {
      try {
        const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { name?: string };
        if (pkg.name === "chatccc") return current;
      } catch {
        // Keep walking: a malformed unrelated package.json is not our root.
      }
    }
    if (current === filesystemRoot) break;
    current = dirname(current);
  }

  throw new Error(`Unable to locate ChatCCC package root from ${startDir}`);
}

export const CHATCCC_PACKAGE_ROOT = findChatCccPackageRoot();
