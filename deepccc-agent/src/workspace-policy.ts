import { relative, resolve } from "node:path";

/** Search defaults are noise filters, not access controls. Explicit paths override them. */
export const PROJECT_NOISE_DIRECTORIES = [
  ".git", "node_modules", ".venv", "venv", "__pycache__", ".tox", ".mypy_cache",
  ".pytest_cache", "dist", "build", "coverage",
] as const;
export type SearchScope = "project" | "all";
export function resolveSearchScope(cwd: string, path?: string, scope?: SearchScope): SearchScope {
  if (scope !== undefined && scope !== "project" && scope !== "all") throw new Error("invalid search scope");
  if (scope) return scope;
  // A named subtree is intentional, including a dependency directory or hidden folder.
  return path && relative(resolve(cwd), resolve(cwd, path)) !== "" ? "all" : "project";
}
export function skipProjectEntry(name: string): boolean {
  return name.startsWith(".") || (PROJECT_NOISE_DIRECTORIES as readonly string[]).includes(name);
}
