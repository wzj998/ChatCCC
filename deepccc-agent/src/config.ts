import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type DeepCccProvider = "openai" | "anthropic";

export interface DeepCccConfig {
  /** API protocol/provider. Defaults to OpenAI-compatible. */
  provider: DeepCccProvider;
  apiKey: string;
  baseURL: string;
  model: string;
  /**
   * 子模型（可选）：用于内部轻量环节（上下文压缩摘要生成、task 子代理任务）。
   * 留空（""）时跟随主模型，行为与旧版完全一致。
   */
  subModel: string;
  /** Reasoning effort（none/minimal/low/medium/high/xhigh/max），留空不传 reasoning_effort */
  effort: string;
  /** 主对话是否使用流式请求；默认开启 */
  streaming: boolean;
  /**
   * 模型上下文窗口（token），默认 1048576（1M，DeepSeek V4 Pro/Flash 原生规格）。
   * 上下文压缩阈值自动 = contextWindow × 0.8；超过模型/服务端实际上限会被 API 拒绝。
   */
  contextWindow: number;
  git: {
    coAuthor: {
      enabled: boolean;
      name: string;
      email: string;
    };
  };
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

/**
 * 默认配置（不读环境/文件）。导出供测试断言默认值；运行时请用 loadConfig 结果。
 */
export const DEFAULT_CONFIG: DeepCccConfig = {
  provider: "openai",
  apiKey: "",
  baseURL: "https://api.deepseek.com/v1",
  model: "deepseek-v4-pro",
  subModel: "",
  effort: "",
  streaming: true,
  contextWindow: 1_048_576,
  git: {
    coAuthor: {
      enabled: true,
      name: "DeepCCC",
      email: "20184052+wzj998@users.noreply.github.com",
    },
  },
  rawStreamLogs: {
    // 默认开启：压缩后可通过 session_search（include_raw_logs=true）找回原文。
    // 如需关闭，在 ~/.deepccc/config.json 中设置 rawStreamLogs.enabled=false。
    enabled: true,
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

export function normalizeDeepCccProvider(value: unknown): DeepCccProvider {
  if (value === undefined || value === null || String(value).trim() === "") return "openai";
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "openai" || normalized === "anthropic") return normalized;
  throw new Error(`DEEPCCC_PROVIDER/provider must be "openai" or "anthropic", received: ${String(value)}`);
}

function loadConfig(): DeepCccConfig {
  const file = readConfigFile();
  const rawLogs: Partial<DeepCccConfig["rawStreamLogs"]> = file.rawStreamLogs && typeof file.rawStreamLogs === "object"
    ? file.rawStreamLogs
    : {};
  const git: Partial<DeepCccConfig["git"]> = file.git && typeof file.git === "object" ? file.git : {};
  const coAuthor: Partial<DeepCccConfig["git"]["coAuthor"]> = git.coAuthor && typeof git.coAuthor === "object" ? git.coAuthor : {};

  return {
    provider: normalizeDeepCccProvider(env("DEEPCCC_PROVIDER") ?? file.provider ?? DEFAULT_CONFIG.provider),
    apiKey: env("DEEPCCC_API_KEY") ?? env("DEEPSEEK_API_KEY") ?? file.apiKey ?? DEFAULT_CONFIG.apiKey,
    baseURL: env("DEEPCCC_BASE_URL") ?? env("DEEPSEEK_BASE_URL") ?? file.baseURL ?? DEFAULT_CONFIG.baseURL,
    model: env("DEEPCCC_MODEL") ?? env("DEEPSEEK_MODEL") ?? file.model ?? DEFAULT_CONFIG.model,
    subModel: env("DEEPCCC_SUB_MODEL") ?? file.subModel ?? DEFAULT_CONFIG.subModel,
    effort: env("DEEPCCC_EFFORT") ?? env("DEEPSEEK_EFFORT") ?? file.effort ?? DEFAULT_CONFIG.effort,
    streaming: boolEnv("DEEPCCC_STREAMING") ?? file.streaming ?? DEFAULT_CONFIG.streaming,
    contextWindow: numberEnv("DEEPCCC_CONTEXT_WINDOW") ?? file.contextWindow ?? DEFAULT_CONFIG.contextWindow,
    git: {
      coAuthor: {
        enabled: boolEnv("DEEPCCC_GIT_COAUTHOR") ?? coAuthor.enabled ?? DEFAULT_CONFIG.git.coAuthor.enabled,
        name: coAuthor.name?.trim() || DEFAULT_CONFIG.git.coAuthor.name,
        email: coAuthor.email?.trim() || DEFAULT_CONFIG.git.coAuthor.email,
      },
    },
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
