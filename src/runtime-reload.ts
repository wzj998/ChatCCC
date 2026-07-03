import {
  APP_ID,
  CONFIG_FILE,
  maskAppId,
  reloadConfigFromDisk,
  resolveDefaultAgentTool,
  type AgentTool,
} from "./config.ts";
import { appendStartupTrace } from "./shared.ts";
import { clearAdapterCache } from "./session.ts";
import { startChromeDevtoolsGuard } from "./chrome-devtools-guard.ts";

export interface RuntimeReloadResult {
  configPath: string;
  defaultAgent: AgentTool;
  reloadedAt: string;
}

export function reloadRuntimeConfig(source: string): RuntimeReloadResult {
  reloadConfigFromDisk();
  clearAdapterCache();
  startChromeDevtoolsGuard();

  const result: RuntimeReloadResult = {
    configPath: CONFIG_FILE,
    defaultAgent: resolveDefaultAgentTool(),
    reloadedAt: new Date().toISOString(),
  };
  appendStartupTrace(`${source}: config reloaded`, {
    appIdMask: maskAppId(APP_ID),
    defaultAgent: result.defaultAgent,
  });
  return result;
}
