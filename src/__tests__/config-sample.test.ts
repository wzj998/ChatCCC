import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("config.sample.json", () => {
  it("enables Feishu and WeChat iLink by default", () => {
    const configSamplePath = join(process.cwd(), "config.sample.json");
    const sample = JSON.parse(readFileSync(configSamplePath, "utf8")) as {
      platforms?: {
        feishu?: { enabled?: unknown };
        ilink?: { enabled?: unknown };
      };
      claude?: { model?: unknown; subagentModel?: unknown };
    };

    expect(sample.platforms?.feishu?.enabled).toBe(true);
    expect(sample.platforms?.ilink?.enabled).toBe(true);
  });

  it("leaves Claude model and subagent model empty by default so the SDK uses its own defaults", () => {
    const configSamplePath = join(process.cwd(), "config.sample.json");
    const sample = JSON.parse(readFileSync(configSamplePath, "utf8")) as {
      claude?: { model?: unknown; subagentModel?: unknown };
    };

    expect(sample.claude?.model).toBe("");
    expect(sample.claude?.subagentModel).toBe("");
  });
});
