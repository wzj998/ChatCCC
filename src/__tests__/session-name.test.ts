import { describe, expect, it } from "vitest";

import {
  normalizeSessionDisplayTitle,
  sessionDisplayTitleFromPrompt,
} from "../session-name.ts";

describe("session display titles", () => {
  it("derives a compact title without changing chat-name behavior", () => {
    expect(sessionDisplayTitleFromPrompt("  修复登录页面的缓存问题  ")).toBe("修复登录页面的缓存问题");
    expect(sessionDisplayTitleFromPrompt("a".repeat(40))).toBe(`${"a".repeat(31)}…`);
  });

  it("normalizes manual titles and rejects empty or oversized values", () => {
    expect(normalizeSessionDisplayTitle("  Release   checklist ")).toBe("Release checklist");
    expect(() => normalizeSessionDisplayTitle("   ")).toThrow("不能为空");
    expect(() => normalizeSessionDisplayTitle("a".repeat(81))).toThrow("不能超过 80");
  });
});
