import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface DeepCccConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  /** Reasoning effort（none/minimal/low/medium/high/xhigh/max），留空不传 reasoning_effort */
  effort: string;
  /** 主对话是否使用流式请求；默认开启 */
  streaming: boolean;
  rawStreamLogs: {
    enabled: boolean;
    maxBytesPerTurn: number;
    retentionDays: number;
    keepCompleted: boolean;
  };
}

export const DEEPCCC_HOME = join(homedir(), ".deepccc");
export const RAW_STREAM_LOGS_DIR = join(DEEPCCC_HOME, "raw-stream-logs");
const CONFIG_PATH = join(DEEPCCC_HOME, "config.json");

const DEFAULT_CONFIG: DeepCccConfig = {
  apiKey: "",
  baseURL: "https://api.deepseek.com/v1",
  model: "deepseek-v4-pro",
  effort: "",
  streaming: true,
  rawStreamLogs: {
    enabled: false,
    maxBytesPerTurn: 1024 * 1024,
    retentionDays: 7,
    keepCompleted: false,
  },
};

function readConfigFile(): Partial<DeepCccConfig> {
  if (!existsSync(CONFIG_PATH)) return {};
  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<DeepCccConfig>;
  return raw && typeof raw === "object" ? raw : {};
}

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function boolEnv(name: string): boolean | undefined {
  const value = env(name)?.toLowerCase();
  if (value === undefined) return undefined;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return undefined;
}

function numberEnv(name: string): number | undefined {
  const value = Number(env(name));
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function loadConfig(): DeepCccConfig {
  const file = readConfigFile();
  const rawLogs: Partial<DeepCccConfig["rawStreamLogs"]> = file.rawStreamLogs && typeof file.rawStreamLogs === "object"
    ? file.rawStreamLogs
    : {};

  return {
    apiKey: env("DEEPCCC_API_KEY") ?? env("DEEPSEEK_API_KEY") ?? file.apiKey ?? DEFAULT_CONFIG.apiKey,
    baseURL: env("DEEPCCC_BASE_URL") ?? env("DEEPSEEK_BASE_URL") ?? file.baseURL ?? DEFAULT_CONFIG.baseURL,
    model: env("DEEPCCC_MODEL") ?? env("DEEPSEEK_MODEL") ?? file.model ?? DEFAULT_CONFIG.model,
    effort: env("DEEPCCC_EFFORT") ?? env("DEEPSEEK_EFFORT") ?? file.effort ?? DEFAULT_CONFIG.effort,
    streaming: boolEnv("DEEPCCC_STREAMING") ?? file.streaming ?? DEFAULT_CONFIG.streaming,
    rawStreamLogs: {
      enabled: boolEnv("DEEPCCC_RAW_STREAM_LOGS") ?? rawLogs.enabled ?? DEFAULT_CONFIG.rawStreamLogs.enabled,
      maxBytesPerTurn: numberEnv("DEEPCCC_RAW_STREAM_MAX_BYTES") ?? rawLogs.maxBytesPerTurn ?? DEFAULT_CONFIG.rawStreamLogs.maxBytesPerTurn,
      retentionDays: numberEnv("DEEPCCC_RAW_STREAM_RETENTION_DAYS") ?? rawLogs.retentionDays ?? DEFAULT_CONFIG.rawStreamLogs.retentionDays,
      keepCompleted: boolEnv("DEEPCCC_RAW_STREAM_KEEP_COMPLETED") ?? rawLogs.keepCompleted ?? DEFAULT_CONFIG.rawStreamLogs.keepCompleted,
    },
  };
}

export function ensureConfigDir(): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
}

export const config = loadConfig();
