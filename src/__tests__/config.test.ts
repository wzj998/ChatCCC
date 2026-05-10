import { describe, it, expect } from "vitest";

import {
  DEFAULT_GIT_TIMEOUT_SECONDS,
  MAX_GIT_TIMEOUT_SECONDS,
  MIN_GIT_TIMEOUT_SECONDS,
  parseGitTimeoutSeconds,
} from "../config.ts";

describe("parseGitTimeoutSeconds", () => {
  it("returns default when raw is undefined", () => {
    const r = parseGitTimeoutSeconds(undefined);
    expect(r.seconds).toBe(DEFAULT_GIT_TIMEOUT_SECONDS);
    expect(r.valid).toBe(true);
    expect(r.usingDefault).toBe(true);
    expect(r.raw).toBeUndefined();
  });

  it("returns default when raw is empty / whitespace only", () => {
    expect(parseGitTimeoutSeconds("")).toMatchObject({
      seconds: DEFAULT_GIT_TIMEOUT_SECONDS,
      valid: true,
      usingDefault: true,
    });
    expect(parseGitTimeoutSeconds("   ")).toMatchObject({
      seconds: DEFAULT_GIT_TIMEOUT_SECONDS,
      valid: true,
      usingDefault: true,
    });
  });

  it("trims and uses user value when valid integer in range", () => {
    expect(parseGitTimeoutSeconds("90")).toMatchObject({
      seconds: 90,
      valid: true,
      usingDefault: false,
      raw: "90",
    });
    expect(parseGitTimeoutSeconds("  600  ")).toMatchObject({
      seconds: 600,
      valid: true,
      usingDefault: false,
      raw: "600",
    });
  });

  it("accepts boundary values MIN and MAX", () => {
    expect(parseGitTimeoutSeconds(String(MIN_GIT_TIMEOUT_SECONDS))).toMatchObject({
      seconds: MIN_GIT_TIMEOUT_SECONDS,
      valid: true,
      usingDefault: false,
    });
    expect(parseGitTimeoutSeconds(String(MAX_GIT_TIMEOUT_SECONDS))).toMatchObject({
      seconds: MAX_GIT_TIMEOUT_SECONDS,
      valid: true,
      usingDefault: false,
    });
  });

  it("falls back to default for non-integer / non-numeric", () => {
    expect(parseGitTimeoutSeconds("abc")).toMatchObject({
      seconds: DEFAULT_GIT_TIMEOUT_SECONDS,
      valid: false,
      usingDefault: true,
      raw: "abc",
    });
    expect(parseGitTimeoutSeconds("12.5")).toMatchObject({
      seconds: DEFAULT_GIT_TIMEOUT_SECONDS,
      valid: false,
      usingDefault: true,
    });
    expect(parseGitTimeoutSeconds("NaN")).toMatchObject({
      valid: false,
      usingDefault: true,
    });
  });

  it("falls back to default for out-of-range values", () => {
    expect(parseGitTimeoutSeconds("0")).toMatchObject({
      seconds: DEFAULT_GIT_TIMEOUT_SECONDS,
      valid: false,
      usingDefault: true,
    });
    expect(parseGitTimeoutSeconds("-5")).toMatchObject({
      valid: false,
      usingDefault: true,
    });
    expect(parseGitTimeoutSeconds(String(MAX_GIT_TIMEOUT_SECONDS + 1))).toMatchObject({
      seconds: DEFAULT_GIT_TIMEOUT_SECONDS,
      valid: false,
      usingDefault: true,
    });
  });

  it("respects custom default parameter", () => {
    expect(parseGitTimeoutSeconds(undefined, 30)).toMatchObject({
      seconds: 30,
      usingDefault: true,
    });
    // 用户值有效则忽略 default 参数
    expect(parseGitTimeoutSeconds("45", 30)).toMatchObject({
      seconds: 45,
      usingDefault: false,
    });
    // 用户值非法时回退到自定义 default
    expect(parseGitTimeoutSeconds("abc", 30)).toMatchObject({
      seconds: 30,
      usingDefault: true,
    });
  });
});

describe("GIT timeout constants", () => {
  it("DEFAULT_GIT_TIMEOUT_SECONDS is 180", () => {
    expect(DEFAULT_GIT_TIMEOUT_SECONDS).toBe(180);
  });

  it("MIN < DEFAULT < MAX", () => {
    expect(MIN_GIT_TIMEOUT_SECONDS).toBeGreaterThan(0);
    expect(MIN_GIT_TIMEOUT_SECONDS).toBeLessThan(DEFAULT_GIT_TIMEOUT_SECONDS);
    expect(DEFAULT_GIT_TIMEOUT_SECONDS).toBeLessThan(MAX_GIT_TIMEOUT_SECONDS);
  });
});
