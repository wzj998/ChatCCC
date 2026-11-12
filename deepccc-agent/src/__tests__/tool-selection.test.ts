import { describe, expect, it, vi } from "vitest";
import type { ToolSet } from "ai";
import { normalizeAllowedTools, selectAllowedTools } from "../tool-selection.js";

describe("per-invocation tool selection", () => {
  it("keeps legacy tools when omitted and supports explicit no-tools SDK usage", () => {
    const tools = { inspect: {}, change: {} } as unknown as ToolSet;
    expect(selectAllowedTools(tools, undefined)).toBe(tools);
    expect(selectAllowedTools(tools, [])).toEqual({});
    expect(normalizeAllowedTools(undefined)).toBeUndefined();
  });

  it("copies the requested names and excludes other executors", () => {
    const execute = vi.fn();
    const tools = { inspect: { execute }, change: { execute: vi.fn() } } as unknown as ToolSet;
    const requested = [" inspect ", "inspect"];
    const names = normalizeAllowedTools(requested);
    expect(requested).toEqual([" inspect ", "inspect"]);
    const chosen = selectAllowedTools(tools, names);
    expect(Object.keys(chosen)).toEqual(["inspect"]);
    expect(chosen.inspect).toBe(tools.inspect);
    expect(chosen.change).toBeUndefined();
    expect(tools.change).toBeDefined();
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects unknown names, inherited properties and malformed lists", () => {
    expect(() => selectAllowedTools({ inspect: {} } as unknown as ToolSet, ["missing"])).toThrow(/Unknown allowed tool/);
    expect(() => selectAllowedTools({ inspect: {} } as unknown as ToolSet, ["toString"])).toThrow(/Unknown allowed tool/);
    expect(() => normalizeAllowedTools(["inspect", ""])).toThrow(/non-empty/);
    expect(() => normalizeAllowedTools("inspect" as unknown as string[])).toThrow(/array/);
  });
});
