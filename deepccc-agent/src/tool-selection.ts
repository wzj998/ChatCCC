import type { ToolSet } from "ai";

/** A per-invocation tool surface, not a filesystem/process sandbox. */
export function normalizeAllowedTools(value: readonly string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(name => typeof name !== "string" || !name.trim())) {
    throw new Error("allowedTools must be an array of non-empty tool names");
  }
  return [...new Set(value.map(name => name.trim()))];
}

export function selectAllowedTools(tools: ToolSet, names: readonly string[] | undefined): ToolSet {
  if (names === undefined) return tools;
  for (const name of names) {
    if (!Object.prototype.hasOwnProperty.call(tools, name)) {
      throw new Error(`Unknown allowed tool: ${name}`);
    }
  }
  return Object.fromEntries(names.map(name => [name, tools[name]]));
}
