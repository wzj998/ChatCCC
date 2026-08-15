import { afterEach, describe, expect, it } from "vitest";

import { ChatSession } from "../index.js";
import { config, DEFAULT_CONFIG, normalizeDeepCccProvider } from "../config.js";

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

  it("defaults context window to 1M tokens (DeepSeek V4 native spec)", () => {
    expect(DEFAULT_CONFIG.contextWindow).toBe(1_048_576);
  });

  it("defaults subModel to empty so internal lightweight steps follow the main model", () => {
    expect(DEFAULT_CONFIG.subModel).toBe("");
  });

  it("defaults Git co-author attribution to the linked DeepCCC identity", () => {
    expect(DEFAULT_CONFIG.git.coAuthor).toEqual({
      enabled: true,
      name: "DeepCCC",
      email: "20184052+wzj998@users.noreply.github.com",
    });
  });

  it("defaults provider selection to openai and accepts anthropic case-insensitively", () => {
    expect(normalizeDeepCccProvider(undefined)).toBe("openai");
    expect(normalizeDeepCccProvider("")).toBe("openai");
    expect(normalizeDeepCccProvider("OPENAI")).toBe("openai");
    expect(normalizeDeepCccProvider("Anthropic")).toBe("anthropic");
    expect(() => normalizeDeepCccProvider("antropic")).toThrow(/openai.*anthropic/i);
  });

  it("uses the builtin ~/.deepccc config when no apiKey is passed", () => {
    expect(() => new ChatSession()).not.toThrow();
  });

  it("allows constructor parameters to override config defaults", () => {
    expect(() => new ChatSession({ apiKey: "sk-test" })).not.toThrow();
  });
});
