import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeCccProviderOverride } from "../config-utils.ts";

describe("normalizeCccProviderOverride", () => {
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

  afterEach(() => {
    warnSpy.mockClear();
  });

  it("returns empty string for missing / non-string values (no override)", () => {
    expect(normalizeCccProviderOverride(undefined)).toBe("");
    expect(normalizeCccProviderOverride(null)).toBe("");
    expect(normalizeCccProviderOverride(42)).toBe("");
    expect(normalizeCccProviderOverride({})).toBe("");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("treats empty/whitespace and legacy 'default' as no override", () => {
    expect(normalizeCccProviderOverride("")).toBe("");
    expect(normalizeCccProviderOverride("   ")).toBe("");
    expect(normalizeCccProviderOverride("default")).toBe("");
    expect(normalizeCccProviderOverride("DEFAULT")).toBe("");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("normalizes openai / anthropic case-insensitively", () => {
    expect(normalizeCccProviderOverride("openai")).toBe("openai");
    expect(normalizeCccProviderOverride("OPENAI")).toBe("openai");
    expect(normalizeCccProviderOverride(" anthropic ")).toBe("anthropic");
    expect(normalizeCccProviderOverride("Anthropic")).toBe("anthropic");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("ignores invalid values with a warning", () => {
    expect(normalizeCccProviderOverride("gemini")).toBe("");
    expect(normalizeCccProviderOverride("oai")).toBe("");
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });
});
