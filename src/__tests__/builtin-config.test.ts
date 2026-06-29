import { afterEach, describe, expect, it } from "vitest";

import { ChatSession } from "../builtin/index.ts";
import { config } from "../config.ts";

const originalDeepSeekApiKey = process.env.DEEPSEEK_API_KEY;
const originalCccConfig = structuredClone(config.ccc);

afterEach(() => {
  if (originalDeepSeekApiKey === undefined) {
    delete process.env.DEEPSEEK_API_KEY;
  } else {
    process.env.DEEPSEEK_API_KEY = originalDeepSeekApiKey;
  }
  config.ccc = structuredClone(originalCccConfig);
});

describe("builtin ChatSession config", () => {
  it("does not fall back to DEEPSEEK_API_KEY environment variable", () => {
    config.ccc = {
      DEEPSEEK_API_KEY: "",
      DEEPSEEK_BASE_URL: "https://api.deepseek.com/v1",
      model: "deepseek-v4-pro[1m]",
    };
    process.env.DEEPSEEK_API_KEY = "sk-env-should-not-be-used";

    expect(() => new ChatSession()).toThrow("ccc.DEEPSEEK_API_KEY 未设置");
  });

  it("allows constructor parameters to override config defaults", () => {
    expect(() => new ChatSession({ apiKey: "sk-test" })).not.toThrow();
  });
});
