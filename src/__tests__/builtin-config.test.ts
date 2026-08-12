import { afterEach, describe, expect, it } from "vitest";

import { ChatSession } from "../../deepccc-agent/src/index.ts";
import { config, DEFAULT_CONFIG } from "../../deepccc-agent/src/config.ts";

const originalDeepSeekApiKey = process.env.DEEPSEEK_API_KEY;
const originalDeepCccApiKey = config.apiKey;

afterEach(() => {
  if (originalDeepSeekApiKey === undefined) {
    delete process.env.DEEPSEEK_API_KEY;
  } else {
    process.env.DEEPSEEK_API_KEY = originalDeepSeekApiKey;
  }
  config.apiKey = originalDeepCccApiKey;
});

describe("builtin ChatSession config", () => {
  it("defaults raw stream logs to enabled so compressed messages stay recoverable", () => {
    expect(DEFAULT_CONFIG.rawStreamLogs.enabled).toBe(true);
  });

  it("uses the builtin ~/.deepccc config when no apiKey is passed", () => {
    expect(() => new ChatSession()).not.toThrow();
  });

  it("allows constructor parameters to override config defaults", () => {
    expect(() => new ChatSession({ apiKey: "sk-test" })).not.toThrow();
  });
});
