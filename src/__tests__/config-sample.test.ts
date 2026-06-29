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

  it("leaves Cursor and Codex alternative models empty by default", () => {
    const configSamplePath = join(process.cwd(), "config.sample.json");
    const sample = JSON.parse(readFileSync(configSamplePath, "utf8")) as {
      cursor?: { alternativeModel?: unknown };
      codex?: { alternativeModel?: unknown };
    };

    expect(sample.cursor?.alternativeModel).toBe("");
    expect(sample.codex?.alternativeModel).toBe("");
  });

  it("sets ccc agent DeepSeek defaults in the sample config", () => {
    const configSamplePath = join(process.cwd(), "config.sample.json");
    const sample = JSON.parse(readFileSync(configSamplePath, "utf8")) as {
      ccc?: { DEEPSEEK_API_KEY?: unknown; DEEPSEEK_BASE_URL?: unknown; model?: unknown };
    };

    expect(sample.ccc?.DEEPSEEK_API_KEY).toBe("");
    expect(sample.ccc?.DEEPSEEK_BASE_URL).toBe("https://api.deepseek.com/v1");
    expect(sample.ccc?.model).toBe("deepseek-v4-pro[1m]");
  });

  it("keeps Chrome CDP guard disabled by default with port 15166", () => {
    const configSamplePath = join(process.cwd(), "config.sample.json");
    const sample = JSON.parse(readFileSync(configSamplePath, "utf8")) as {
      chromeDevtools?: { enabled?: unknown; port?: unknown; chromePath?: unknown };
    };

    expect(sample.chromeDevtools?.enabled).toBe(false);
    expect(sample.chromeDevtools?.port).toBe(15166);
    expect(sample.chromeDevtools?.chromePath).toBe("");
  });

  it("keeps raw stream logs disabled by default for every agent", () => {
    const configSamplePath = join(process.cwd(), "config.sample.json");
    const sample = JSON.parse(readFileSync(configSamplePath, "utf8")) as {
      rawStreamLogs?: Record<string, {
        enabled?: unknown;
        maxBytesPerTurn?: unknown;
        retentionDays?: unknown;
        keepCompleted?: unknown;
      }>;
    };

    for (const tool of ["claude", "cursor", "codex"]) {
      expect(sample.rawStreamLogs?.[tool]?.enabled).toBe(false);
      expect(sample.rawStreamLogs?.[tool]?.maxBytesPerTurn).toBe(52_428_800);
      expect(sample.rawStreamLogs?.[tool]?.retentionDays).toBe(7);
      expect(sample.rawStreamLogs?.[tool]?.keepCompleted).toBe(false);
    }
  });
});
