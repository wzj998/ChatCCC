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

  it("leaves alternative models empty and Codex Fast mode off by default", () => {
    const configSamplePath = join(process.cwd(), "config.sample.json");
    const sample = JSON.parse(readFileSync(configSamplePath, "utf8")) as {
      cursor?: { alternativeModel?: unknown };
      codex?: { alternativeModel?: unknown; fastMode?: unknown };
      ccc?: { alternativeModel?: unknown };
      dsh?: { subModel?: unknown; alternativeModel?: unknown };
    };

    expect(sample.cursor?.alternativeModel).toBe("");
    expect(sample.codex?.alternativeModel).toBe("");
    expect(sample.ccc?.alternativeModel).toBe("");
    expect(sample.codex?.fastMode).toBe(false);
    expect(sample.dsh?.subModel).toBe("");
    expect(sample.dsh?.alternativeModel).toBe("");
  });

  it("sets ccc agent DeepSeek defaults in the sample config", () => {
    const configSamplePath = join(process.cwd(), "config.sample.json");
    const sample = JSON.parse(readFileSync(configSamplePath, "utf8")) as {
      ccc?: { enabled?: unknown; defaultAgent?: unknown; DEEPSEEK_API_KEY?: unknown; DEEPSEEK_BASE_URL?: unknown; model?: unknown; effort?: unknown; compactionTimeoutMs?: unknown };
    };

    expect(sample.ccc?.enabled).toBe(false);
    expect(sample.ccc?.defaultAgent).toBe(false);
    expect(sample.ccc?.DEEPSEEK_API_KEY).toBe("");
    expect(sample.ccc?.DEEPSEEK_BASE_URL).toBe("https://api.deepseek.com/v1");
    expect(sample.ccc?.model).toBe("deepseek-v4-pro");
    expect(sample.ccc?.effort).toBe("");
    expect(sample.ccc?.compactionTimeoutMs).toBe(5 * 60 * 1000);
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

  it("opens the Web UI on direct startup by default", () => {
    const configSamplePath = join(process.cwd(), "config.sample.json");
    const sample = JSON.parse(readFileSync(configSamplePath, "utf8")) as {
      webUi?: { openOnStart?: unknown };
    };

    expect(sample.webUi?.openOnStart).toBe(true);
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

    for (const tool of ["claude", "cursor", "codex", "ccc", "dsh"]) {
      expect(sample.rawStreamLogs?.[tool]?.enabled).toBe(false);
      expect(sample.rawStreamLogs?.[tool]?.maxBytesPerTurn).toBe(52_428_800);
      expect(sample.rawStreamLogs?.[tool]?.retentionDays).toBe(7);
      expect(sample.rawStreamLogs?.[tool]?.keepCompleted).toBe(false);
    }
  });
});
