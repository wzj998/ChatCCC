export interface PlatformStartupPlanInput {
  feishuEnabled: boolean;
  ilinkEnabled: boolean;
}

export interface PlatformStartupPlan {
  startFeishu: boolean;
  startIlink: boolean;
}

export function buildPlatformStartupPlan(input: PlatformStartupPlanInput): PlatformStartupPlan {
  return {
    startFeishu: input.feishuEnabled,
    startIlink: input.ilinkEnabled,
  };
}
