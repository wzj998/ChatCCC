import { describe, expect, it } from "vitest";

import { buildPlatformStartupPlan } from "../platform-startup.ts";

describe("buildPlatformStartupPlan", () => {
  it("starts WeChat iLink without requiring Feishu when Feishu is disabled", () => {
    expect(buildPlatformStartupPlan({ feishuEnabled: false, ilinkEnabled: true })).toEqual({
      startFeishu: false,
      startIlink: true,
    });
  });

  it("can start both platforms when both are enabled", () => {
    expect(buildPlatformStartupPlan({ feishuEnabled: true, ilinkEnabled: true })).toEqual({
      startFeishu: true,
      startIlink: true,
    });
  });
});
