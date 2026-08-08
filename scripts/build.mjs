import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(packageRoot, "dist");
if (dirname(distDir) !== packageRoot) {
  throw new Error(`Refusing to clean unexpected build directory: ${distDir}`);
}
rmSync(distDir, { recursive: true, force: true });

const tsc = resolve(packageRoot, "node_modules", "typescript", "bin", "tsc");
const result = spawnSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], {
  cwd: packageRoot,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
