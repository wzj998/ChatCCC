import { existsSync, readFileSync, copyFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendFile, cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";

import { printServiceDidNotStart } from "./exit-banner.ts";
import { appendStartupTrace, setupFileLogging } from "./shared.ts";
import {
  anthropicConfigDisplay,
  autoDetectCodexPath,
  autoDetectCursorPath,
  normalizeOptionalConfigField,
  readToolCliPath,
} from "./config-utils.ts";

// 重新导出 config-utils 中的纯函数/常量，保持对外 API 不变
// （历史上这些符号都从 ./config.ts 导入；新代码可直接从 ./config-utils.ts 导入以避免触发本文件的副作用）
export {
  DEFAULT_GIT_TIMEOUT_SECONDS,
  MIN_GIT_TIMEOUT_SECONDS,
  MAX_GIT_TIMEOUT_SECONDS,
  parseGitTimeoutSeconds,
  normalizeOptionalConfigField,
  isAnthropicConfigEmpty,
  anthropicConfigDisplay,
} from "./config-utils.ts";
export type { ParsedGitTimeout } from "./config-utils.ts";

// ---------------------------------------------------------------------------
// Paths & logging
// ---------------------------------------------------------------------------

export const __dirname = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = join(__dirname, "..");
/** 用户持久化数据根目录（不随 npm 升级清空） */
export const USER_DATA_DIR = join(homedir(), ".chatccc");
export const PID_FILE = join(USER_DATA_DIR, "state", "runtime.pid");

export const LOG_DIR = join(USER_DATA_DIR, "logs");
export const fileLog = setupFileLogging(LOG_DIR, "index");

export const CHAT_LOGS_DIR = join(USER_DATA_DIR, "state", "chat_logs");
export const RAW_STREAM_LOGS_DIR = join(LOG_DIR, "raw-streams");

export async function appendChatLog(chatId: string, sender: string, text: string): Promise<void> {
  try {
    await mkdir(CHAT_LOGS_DIR, { recursive: true });
    const line = JSON.stringify({ ts: Date.now(), sender, text: text.slice(0, 200) }) + "\n";
    await appendFile(join(CHAT_LOGS_DIR, `${chatId}.jsonl`), line);
  } catch {
    // 静默失败，不影响主流程
  }
}

// ---------------------------------------------------------------------------
// Config file loading
// ---------------------------------------------------------------------------

export interface ClaudeConfig {
  /** 是否启用 Claude Code Agent；缺省时按"有任意字段非空"自动判定（向后兼容） */
  enabled: boolean;
  /** 是否作为 /new 未指定工具时使用的默认 Agent */
  defaultAgent: boolean;
  model: string;
  subagentModel: string;
  effort: string;
  /** Anthropic API Key（选填，留空则使用 Claude Code 默认认证） */
  apiKey: string;
  /** Anthropic 兼容 API Base URL（选填，留空则使用默认端点） */
  baseUrl: string;
  /** Claude Agent SDK maxTurns 设置，默认 0（无限制） */
  maxTurn: number;
}

export interface CursorConfig {
  /** 是否启用 Cursor Agent；缺省时按"有任意字段非空"自动判定（向后兼容） */
  enabled: boolean;
  /** 是否作为 /new 未指定工具时使用的默认 Agent */
  defaultAgent: boolean;
  /** Cursor Agent CLI 可执行文件绝对路径；留空时由运行时按 LocalAppData / PATH 兜底 */
  path: string;
  model: string;
  /** /model 可切换的单个备选模型；留空则不加入候选列表 */
  alternativeModel: string;
  avatarBatteryMode: CursorAvatarBatteryMode;
  onDemandMonthlyBudget: number;
}

export interface CodexConfig {
  /** 是否启用 Codex Agent；缺省时按"有任意字段非空"自动判定（向后兼容） */
  enabled: boolean;
  /** 是否作为 /new 未指定工具时使用的默认 Agent */
  defaultAgent: boolean;
  /** Codex CLI 可执行文件绝对路径；留空时退回到 PATH 中的 `codex` */
  path: string;
  model: string;
  /** /model 可切换的单个备选模型；留空则不加入候选列表 */
  alternativeModel: string;
  effort: string;
}

export interface CccConfig {
  /** DeepSeek API Key for the ChatCCC self-developed agent. */
  DEEPSEEK_API_KEY: string;
  /** DeepSeek-compatible API Base URL for the ChatCCC self-developed agent. */
  DEEPSEEK_BASE_URL: string;
  /** Model used by the ChatCCC self-developed agent. */
  model: string;
}

export interface FeishuConfig {
  appId: string;
  appSecret: string;
}

export interface PlatformConfig {
  enabled: boolean;
  reuseTokenOnStart?: boolean;
  /** 飞书平台类型：feishu（国内飞书）或 lark（国际版）；缺省按 feishu */
  platformType?: "feishu" | "lark";
}

export interface PlatformsConfig {
  feishu: PlatformConfig;
  ilink: PlatformConfig;
}

export interface ChromeDevtoolsConfig {
  /** 是否由 ChatCCC 守护一个常驻 Chrome CDP 实例 */
  enabled: boolean;
  /** Chrome remote debugging 端口，默认 15166 */
  port: number;
  /** Chrome 可执行文件路径；留空时按常见安装位置自动探测 */
  chromePath: string;
}

export interface RawStreamAgentLogConfig {
  enabled: boolean;
  maxBytesPerTurn: number;
  retentionDays: number;
  keepCompleted: boolean;
}

export interface RawStreamLogsConfig {
  claude: RawStreamAgentLogConfig;
  cursor: RawStreamAgentLogConfig;
  codex: RawStreamAgentLogConfig;
  ccc: RawStreamAgentLogConfig;
}

export interface AppConfig {
  feishu: FeishuConfig;
  platforms: PlatformsConfig;
  chromeDevtools: ChromeDevtoolsConfig;
  port: number;
  gitTimeoutSeconds: number;
  /** 若为 false，AI 生成过程中用户发送消息不会打断，须先点「停止」再发送新消息 */
  allowInterrupt: boolean;
  rawStreamLogs: RawStreamLogsConfig;
  claude: ClaudeConfig;
  cursor: CursorConfig;
  codex: CodexConfig;
  ccc: CccConfig;
}

export type AgentTool = "claude" | "cursor" | "codex";
export const AGENT_TOOLS: AgentTool[] = ["claude", "cursor", "codex"];
export type CursorAvatarBatteryMode = "apiPercent" | "onDemandUse";

/** 获取指定 agent 配置中所有模型相关的值（最多 100 个，去重） */
export function getAllModelsForTool(tool: string, cfg: AppConfig = config): string[] {
  const seen = new Set<string>();
  const collect = (v: unknown) => {
    if (typeof v === "string" && v.trim()) seen.add(v.trim());
  };

  if (tool === "claude") {
    collect(cfg.claude.model);
    collect(cfg.claude.subagentModel);
  } else if (tool === "cursor") {
    collect(cfg.cursor.model);
    collect(cfg.cursor.alternativeModel);
  } else if (tool === "codex") {
    collect(cfg.codex.model);
    collect(cfg.codex.alternativeModel);
  } else if (tool === "ccc") {
    collect(cfg.ccc.model);
  }

  return Array.from(seen).slice(0, 100);
}

export const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export const CODEX_EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const;

export function getAllEffortsForTool(tool: string): string[] {
  if (tool === "claude") return [...CLAUDE_EFFORT_LEVELS];
  if (tool === "codex") return [...CODEX_EFFORT_LEVELS];
  return [];
}

export function getDefaultEffortForTool(tool: AgentTool, cfg: AppConfig = config): string {
  if (tool === "claude") return cfg.claude.effort;
  if (tool === "codex") return cfg.codex.effort;
  return "";
}

const CONFIG_FILE = join(USER_DATA_DIR, "config.json");
const CONFIG_SAMPLE_FILE = join(PROJECT_ROOT, "config.sample.json");
export const DEFAULT_CCC_DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";
export const DEFAULT_CCC_MODEL = "deepseek-v4-pro";

/**
 * 将旧位置（PROJECT_ROOT）的持久化数据一次性迁移到 USER_DATA_DIR。
 * 仅当 USER_DATA_DIR 下没有 config.json 且 PROJECT_ROOT 下有旧数据时才执行。
 */
function migrateLegacyData(): void {
  const oldConfig = join(PROJECT_ROOT, "config.json");
  const oldState = join(PROJECT_ROOT, "state");
  const oldLogs = join(PROJECT_ROOT, "logs");
  const oldImagesDownloads = join(PROJECT_ROOT, "images", "downloads");

  if (existsSync(CONFIG_FILE)) return; // 已迁移过或全新安装

  let migrated = false;
  try {
    mkdirSync(USER_DATA_DIR, { recursive: true });

    if (existsSync(oldConfig)) {
      copyFileSync(oldConfig, CONFIG_FILE);
      console.log(`[MIGRATE] config.json → ${CONFIG_FILE}`);
      migrated = true;
    }

    if (existsSync(oldState)) {
      const destState = join(USER_DATA_DIR, "state");
      if (!existsSync(destState)) {
        // 同步递归复制（cpSync 不可用，改用 copyFileSync 遍历）
        copyDirSync(oldState, destState);
        console.log(`[MIGRATE] state/ → ${destState}`);
        migrated = true;
      }
    }

    if (existsSync(oldLogs)) {
      const destLogs = join(USER_DATA_DIR, "logs");
      if (!existsSync(destLogs)) {
        copyDirSync(oldLogs, destLogs);
        console.log(`[MIGRATE] logs/ → ${destLogs}`);
        migrated = true;
      }
    }

    if (existsSync(oldImagesDownloads)) {
      const destDownloads = join(USER_DATA_DIR, "images", "downloads");
      if (!existsSync(destDownloads)) {
        copyDirSync(oldImagesDownloads, destDownloads);
        console.log(`[MIGRATE] images/downloads/ → ${destDownloads}`);
        migrated = true;
      }
    }
  } catch (err) {
    console.error(`[MIGRATE] 迁移失败: ${(err as Error).message}`);
  }

  if (migrated) {
    console.log("[MIGRATE] 旧数据已迁移到 ~/.chatccc/，原位置文件保留未删除。");
  }
}

/** 递归同步复制目录（仅文件和子目录，不处理符号链接） */
function copyDirSync(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    const s = statSync(srcPath);
    if (s.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else if (s.isFile()) {
      copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * 是否处于 vitest 测试环境。
 *
 * 由于 `src/config.ts` 在模块顶层立即执行 `loadConfig()`，而很多生产模块
 * （session.ts、adapters/* 等）又会 import config.ts，因此**任何**一个
 * import 了这些生产模块的单测都会间接触发 config.ts 顶层副作用——这是不
 * 应该的：单测不应该改动工作区的文件系统。
 *
 * vitest 在运行测试时会自动设置 `VITEST=true`，据此跳过自动复制 sample 的
 * 写文件副作用即可（顶层依然会正常加载默认值与可能已存在的 config.json）。
 */
const IS_TEST_ENV = process.env.VITEST === "true" || process.env.NODE_ENV === "test";

/**
 * Windows 上用 `where`、其它平台用 `which` 查找命令的绝对路径。
 * 命令未安装、命令查找进程出错都视为"找不到"，返回 null。
 */
function whichSync(cmd: string): string | null {
  try {
    const tool = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(tool, [cmd], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      timeout: 5000,
    });
    const first = out.toString().split(/\r?\n/)[0]?.trim();
    return first || null;
  } catch {
    return null;
  }
}

/**
 * 在刚从 config.sample.json 复制出来的 config.json 上立即探测一次 cursor/codex
 * 路径，命中就回写，便于用户无需手动编辑就拿到可运行的默认配置。
 *
 * 仅在"复制 sample 这一刻"调用，已存在的 config.json 不会触发——避免悄悄改写
 * 用户主动留空的字段。
 */
function autofillToolPathsAfterSampleCopy(configFile: string): void {
  let raw: string;
  try {
    raw = readFileSync(configFile, "utf-8");
  } catch {
    return;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }

  const cursor = (parsed.cursor as Record<string, unknown> | undefined) ?? {};
  const codex = (parsed.codex as Record<string, unknown> | undefined) ?? {};
  const cursorEmpty =
    (typeof cursor.path !== "string" || cursor.path.trim() === "") &&
    (typeof cursor.command !== "string" || (cursor.command as string).trim() === "");
  const codexEmpty =
    (typeof codex.path !== "string" || codex.path.trim() === "") &&
    (typeof codex.command !== "string" || (codex.command as string).trim() === "");

  let mutated = false;
  if (cursorEmpty) {
    const detected = autoDetectCursorPath({
      platform: process.platform,
      localAppData: process.env.LOCALAPPDATA,
      existsSync,
      whichSync,
    });
    if (detected) {
      parsed.cursor = { ...cursor, path: detected };
      mutated = true;
      console.log(`[CONFIG] 已自动探测 Cursor CLI 路径: ${detected}`);
    } else {
      console.log("[CONFIG] 未探测到 Cursor CLI，cursor.path 留空（运行时按 PATH 兜底）。");
    }
  }
  if (codexEmpty) {
    const detected = autoDetectCodexPath({ whichSync });
    if (detected) {
      parsed.codex = { ...codex, path: detected };
      mutated = true;
      console.log(`[CONFIG] 已自动探测 Codex CLI 路径: ${detected}`);
    } else {
      console.log("[CONFIG] 未探测到 Codex CLI，codex.path 留空（运行时退回 PATH 中的 codex）。");
    }
  }

  if (mutated) {
    try {
      writeFileSync(configFile, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
    } catch (err) {
      console.error(
        `[CONFIG] 自动探测路径回写 config.json 失败: ${(err as Error).message}`,
      );
    }
  }
}

function normalizePlatformType(raw: string): "feishu" | "lark" {
  if (raw === "lark") return "lark";
  return "feishu";
}

function normalizeCursorAvatarBatteryMode(raw: unknown): CursorAvatarBatteryMode {
  return raw === "onDemandUse" ? "onDemandUse" : "apiPercent";
}

function normalizeCursorOnDemandMonthlyBudget(raw: unknown): number {
  const value = typeof raw === "string" ? Number(raw.trim()) : Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 1000;
}

function normalizePositiveInteger(raw: unknown, fallback: number): number {
  const value = typeof raw === "string" ? Number(raw.trim()) : Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function normalizeRawStreamAgentLogConfig(raw: unknown): RawStreamAgentLogConfig {
  const obj = typeof raw === "object" && raw !== null
    ? raw as Record<string, unknown>
    : {};
  return {
    enabled: typeof obj.enabled === "boolean" ? obj.enabled : false,
    maxBytesPerTurn: normalizePositiveInteger(obj.maxBytesPerTurn, 50 * 1024 * 1024),
    retentionDays: normalizePositiveInteger(obj.retentionDays, 7),
    keepCompleted: typeof obj.keepCompleted === "boolean" ? obj.keepCompleted : false,
  };
}

function loadConfig(): AppConfig {
  const defaults: AppConfig = {
    feishu: { appId: "", appSecret: "" },
    platforms: { feishu: { enabled: true }, ilink: { enabled: true } },
    chromeDevtools: { enabled: false, port: 15166, chromePath: "" },
    port: 18080,
    gitTimeoutSeconds: 180,
    allowInterrupt: false,
    rawStreamLogs: {
      claude: { enabled: false, maxBytesPerTurn: 50 * 1024 * 1024, retentionDays: 7, keepCompleted: false },
      cursor: { enabled: false, maxBytesPerTurn: 50 * 1024 * 1024, retentionDays: 7, keepCompleted: false },
      codex: { enabled: false, maxBytesPerTurn: 50 * 1024 * 1024, retentionDays: 7, keepCompleted: false },
      ccc: { enabled: false, maxBytesPerTurn: 50 * 1024 * 1024, retentionDays: 7, keepCompleted: false },
    },
    claude: { enabled: false, defaultAgent: true, model: "", subagentModel: "", effort: "", apiKey: "", baseUrl: "", maxTurn: 0 },
    cursor: {
      enabled: false,
      defaultAgent: false,
      path: "",
      model: "claude-opus-4-7-max",
      alternativeModel: "",
      avatarBatteryMode: "apiPercent",
      onDemandMonthlyBudget: 1000,
    },
    codex: { enabled: false, defaultAgent: false, path: "", model: "", alternativeModel: "", effort: "" },
    ccc: { DEEPSEEK_API_KEY: "", DEEPSEEK_BASE_URL: DEFAULT_CCC_DEEPSEEK_BASE_URL, model: DEFAULT_CCC_MODEL },
  };

  if (!IS_TEST_ENV) {
    migrateLegacyData();
  }

  if (!existsSync(CONFIG_FILE)) {
    if (IS_TEST_ENV) {
      // 测试环境下绝不写文件，直接走默认值
      return defaults;
    }
    if (existsSync(CONFIG_SAMPLE_FILE)) {
      console.log(`[CONFIG] config.json 不存在，基于 config.sample.json 创建...`);
      try {
        mkdirSync(dirname(CONFIG_FILE), { recursive: true });
        copyFileSync(CONFIG_SAMPLE_FILE, CONFIG_FILE);
      } catch (err) {
        console.error(`[CONFIG] 无法从 config.sample.json 创建 config.json: ${(err as Error).message}`);
        return defaults;
      }
      // 复制完成立即探测 CLI 路径并回写，让用户开箱即用而无须手编 config.json。
      autofillToolPathsAfterSampleCopy(CONFIG_FILE);
    } else {
      console.error(`[CONFIG] config.json 和 config.sample.json 都不存在，使用默认配置。`);
      return defaults;
    }
  }

  let raw: string;
  try {
    raw = readFileSync(CONFIG_FILE, "utf-8");
    // 移除可能意外写入的 UTF-8 BOM（如通过记事本编辑等场景），
    // 避免 JSON.parse 因 BOM 失败导致返回空默认值、丢失所有配置。
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  } catch (err) {
    console.error(`[CONFIG] 无法读取 config.json: ${(err as Error).message}`);
    return defaults;
  }

  let parsed: Partial<AppConfig> & {
    claude?: Partial<ClaudeConfig> & { enabled?: unknown };
    cursor?: {
      enabled?: unknown;
      defaultAgent?: unknown;
      path?: unknown;
      command?: unknown;
      model?: unknown;
      alternativeModel?: unknown;
      avatarBatteryMode?: unknown;
      onDemandMonthlyBudget?: unknown;
    };
    codex?: { enabled?: unknown; defaultAgent?: unknown; path?: unknown; command?: unknown; model?: unknown; alternativeModel?: unknown; effort?: unknown };
    ccc?: { DEEPSEEK_API_KEY?: unknown; DEEPSEEK_BASE_URL?: unknown; model?: unknown };
    chromeDevtools?: { enabled?: unknown; port?: unknown; chromePath?: unknown };
    rawStreamLogs?: unknown;
  };
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`[CONFIG] config.json 不是合法 JSON: ${(err as Error).message}`);
    return defaults;
  }

  const feishu = parsed.feishu ?? { appId: "", appSecret: "" };
  const claude = parsed.claude ?? {} as Partial<ClaudeConfig>;
  const cursorRaw = (parsed.cursor ?? {}) as NonNullable<typeof parsed.cursor>;
  const codexRaw = (parsed.codex ?? {}) as NonNullable<typeof parsed.codex>;
  const cccRaw = (parsed.ccc ?? {}) as NonNullable<typeof parsed.ccc>;
  const chromeDevtoolsRaw = (parsed.chromeDevtools ?? {}) as NonNullable<typeof parsed.chromeDevtools>;
  const rawStreamLogsRaw = typeof parsed.rawStreamLogs === "object" && parsed.rawStreamLogs !== null
    ? parsed.rawStreamLogs as unknown as Record<string, unknown>
    : {};

  // 兼容旧字段 `command`：命中时打印一次性 warning 提示用户改名
  const onLegacyField = (label: string, value: string): void => {
    console.warn(
      `[CONFIG] ${label}.command 字段已废弃，请改为 ${label}.path（当前仍按旧字段读到 "${value}"）。`,
    );
  };

  /**
   * 解析 `<agent>.enabled` 字段：
   * - 显式 boolean → 用原值
   * - 缺省 / 其它类型 → 按 `nonEmptyFn()` 推断（"有任意字段非空" 即视为启用），向后兼容旧 config.json
   */
  const resolveEnabled = (raw: unknown, nonEmptyFn: () => boolean): boolean => {
    if (typeof raw === "boolean") return raw;
    return nonEmptyFn();
  };

  const claudeNonEmpty = (): boolean =>
    Boolean(
      (typeof claude.model === "string" && claude.model.trim()) ||
      (typeof claude.subagentModel === "string" && claude.subagentModel.trim()) ||
      (typeof claude.effort === "string" && claude.effort.trim()) ||
      (typeof claude.apiKey === "string" && claude.apiKey.trim()) ||
      (typeof claude.baseUrl === "string" && claude.baseUrl.trim()),
    );
  const cursorNonEmpty = (): boolean =>
    Boolean(
      (typeof cursorRaw.path === "string" && cursorRaw.path.trim()) ||
      (typeof cursorRaw.command === "string" && (cursorRaw.command as string).trim()) ||
      (typeof cursorRaw.model === "string" && (cursorRaw.model as string).trim()) ||
      (typeof cursorRaw.alternativeModel === "string" && (cursorRaw.alternativeModel as string).trim()),
    );
  const codexNonEmpty = (): boolean =>
    Boolean(
      (typeof codexRaw.path === "string" && codexRaw.path.trim()) ||
      (typeof codexRaw.command === "string" && (codexRaw.command as string).trim()) ||
      (typeof codexRaw.model === "string" && (codexRaw.model as string).trim()) ||
      (typeof codexRaw.alternativeModel === "string" && (codexRaw.alternativeModel as string).trim()) ||
      (typeof codexRaw.effort === "string" && (codexRaw.effort as string).trim()),
    );

  const claudeEnabled = resolveEnabled(claude.enabled, claudeNonEmpty);
  const cursorEnabled = resolveEnabled(cursorRaw.enabled, cursorNonEmpty);
  const codexEnabled = resolveEnabled(codexRaw.enabled, codexNonEmpty);
  const chromeDevtoolsPort = Number(chromeDevtoolsRaw.port);
  const explicitDefaultTool: AgentTool | null =
    typeof claude.defaultAgent === "boolean" && claude.defaultAgent && claudeEnabled ? "claude" :
    typeof cursorRaw.defaultAgent === "boolean" && cursorRaw.defaultAgent && cursorEnabled ? "cursor" :
    typeof codexRaw.defaultAgent === "boolean" && codexRaw.defaultAgent && codexEnabled ? "codex" :
    null;
  const fallbackDefaultTool: AgentTool =
    claudeEnabled ? "claude" :
    cursorEnabled ? "cursor" :
    codexEnabled ? "codex" :
    "claude";
  const defaultTool = explicitDefaultTool ?? fallbackDefaultTool;

  return {
    feishu: {
      appId: feishu.appId ?? "",
      appSecret: feishu.appSecret ?? "",
    },
    platforms: {
      feishu: {
        enabled: typeof (parsed.platforms as unknown as Record<string, unknown> | undefined)?.feishu === "object"
          ? Boolean(((parsed.platforms as unknown as Record<string, unknown>).feishu as Record<string, unknown>).enabled ?? true)
          : true,
        platformType: normalizePlatformType(
          typeof (parsed.platforms as unknown as Record<string, unknown> | undefined)?.feishu === "object"
            ? String(((parsed.platforms as unknown as Record<string, unknown>).feishu as Record<string, unknown>).platformType ?? "feishu")
            : "feishu",
        ),
      },
      ilink: {
        enabled: typeof (parsed.platforms as unknown as Record<string, unknown> | undefined)?.ilink === "object"
          ? Boolean(((parsed.platforms as unknown as Record<string, unknown>).ilink as Record<string, unknown>).enabled ?? true)
          : true,
        reuseTokenOnStart: typeof (parsed.platforms as unknown as Record<string, unknown> | undefined)?.ilink === "object"
          ? Boolean(((parsed.platforms as unknown as Record<string, unknown>).ilink as Record<string, unknown>).reuseTokenOnStart ?? true)
          : true,
      },
    },
    chromeDevtools: {
      enabled: typeof chromeDevtoolsRaw.enabled === "boolean" ? chromeDevtoolsRaw.enabled : false,
      port: Number.isInteger(chromeDevtoolsPort) && chromeDevtoolsPort >= 1 && chromeDevtoolsPort <= 65535
        ? chromeDevtoolsPort
        : 15166,
      chromePath: normalizeOptionalConfigField(chromeDevtoolsRaw.chromePath, { label: "chromeDevtools.chromePath" }),
    },
    port: typeof parsed.port === "number" ? parsed.port : 18080,
    gitTimeoutSeconds: typeof parsed.gitTimeoutSeconds === "number" ? parsed.gitTimeoutSeconds : 180,
    allowInterrupt: typeof parsed.allowInterrupt === "boolean" ? parsed.allowInterrupt : false,
    rawStreamLogs: {
      claude: normalizeRawStreamAgentLogConfig(rawStreamLogsRaw.claude),
      cursor: normalizeRawStreamAgentLogConfig(rawStreamLogsRaw.cursor),
      codex: normalizeRawStreamAgentLogConfig(rawStreamLogsRaw.codex),
      ccc: normalizeRawStreamAgentLogConfig(rawStreamLogsRaw.ccc),
    },
    claude: {
      enabled: claudeEnabled,
      defaultAgent: defaultTool === "claude",
      model: normalizeOptionalConfigField(claude.model, { label: "claude.model" }),
      subagentModel: normalizeOptionalConfigField(claude.subagentModel, { label: "claude.subagentModel" }),
      effort: normalizeOptionalConfigField(claude.effort, { label: "claude.effort" }),
      apiKey: normalizeOptionalConfigField(claude.apiKey, { label: "claude.apiKey" }),
      baseUrl: normalizeOptionalConfigField(claude.baseUrl, { label: "claude.baseUrl" }),
      maxTurn: typeof (claude as Record<string, unknown>).maxTurn === "number"
        ? (claude as Record<string, unknown>).maxTurn as number
        : 0,
    },
    cursor: {
      enabled: cursorEnabled,
      defaultAgent: defaultTool === "cursor",
      path: readToolCliPath(cursorRaw, { label: "cursor", onLegacyField }),
      model: normalizeOptionalConfigField(cursorRaw.model, { label: "cursor.model", fallback: "claude-opus-4-7-max" }),
      alternativeModel: normalizeOptionalConfigField(cursorRaw.alternativeModel, { label: "cursor.alternativeModel" }),
      avatarBatteryMode: normalizeCursorAvatarBatteryMode(cursorRaw.avatarBatteryMode),
      onDemandMonthlyBudget: normalizeCursorOnDemandMonthlyBudget(cursorRaw.onDemandMonthlyBudget),
    },
    codex: {
      enabled: codexEnabled,
      defaultAgent: defaultTool === "codex",
      path: readToolCliPath(codexRaw, { label: "codex", onLegacyField }),
      model: normalizeOptionalConfigField(codexRaw.model, { label: "codex.model" }),
      alternativeModel: normalizeOptionalConfigField(codexRaw.alternativeModel, { label: "codex.alternativeModel" }),
      effort: normalizeOptionalConfigField(codexRaw.effort, { label: "codex.effort" }),
    },
    ccc: {
      DEEPSEEK_API_KEY: normalizeOptionalConfigField(cccRaw.DEEPSEEK_API_KEY, { label: "ccc.DEEPSEEK_API_KEY" }),
      DEEPSEEK_BASE_URL: normalizeOptionalConfigField(cccRaw.DEEPSEEK_BASE_URL, {
        label: "ccc.DEEPSEEK_BASE_URL",
        fallback: DEFAULT_CCC_DEEPSEEK_BASE_URL,
      }),
      model: normalizeOptionalConfigField(cccRaw.model, { label: "ccc.model", fallback: DEFAULT_CCC_MODEL }),
    },
  };
}

/**
 * 全局可变 config 对象。
 *
 * 故意用 `const + Object.assign(config, ...)` 而非 `let config = ...`：
 * 这样 `config` 这个 binding 永远指向同一个引用，下游模块只要在**函数体内**
 * 读 `config.xxx` 就能自动看到最新值（如 codex-adapter.ts 的 config.codex.*）。
 * 这是 setup → service「在线切换」复用 config 的核心机制。
 */
export const config: AppConfig = loadConfig();

// ---------------------------------------------------------------------------
// Re-exported config values
// ---------------------------------------------------------------------------
//
// 这些值用 `export let` 而非 `const`，是为了支持 `reloadConfigFromDisk()`：
// setup → service「在线切换」时，向导刚把新值写入 config.json，需要让进程
// 内的这些常量也跟着更新。ES module 的 live binding 保证：导入端通过命名导入
// 拿到的是 module 内的 slot，slot 在导出方被重新赋值后，导入端**自动看到新值**
// （前提是导入端在函数体内读，不是在模块顶层读）。

export const USE_LOCAL = process.argv.includes("--local");
export const USE_SIMULATE = process.argv.includes("--simulate");
export let APP_ID = config.feishu.appId;
export let APP_SECRET = config.feishu.appSecret;
export let FEISHU_ENABLED = config.platforms.feishu.enabled;
export let ILINK_ENABLED = config.platforms.ilink.enabled;
export let ILINK_REUSE_TOKEN_ON_START = config.platforms.ilink.reuseTokenOnStart ?? true;

function computeBaseUrl(platformType?: string): string {
  if (platformType === "lark") return "https://open.larksuite.com/open-apis";
  return "https://open.feishu.cn/open-apis";
}

export let BASE_URL = computeBaseUrl(config.platforms.feishu.platformType);
export let FEISHU_PLATFORM_TYPE: "feishu" | "lark" = config.platforms.feishu.platformType === "lark" ? "lark" : "feishu";
export const CHATCCC_PORT = config.port;

/** 与 CHATCCC_PORT 一致，供 --local 连接本机中继 */
export const LOCAL_RELAY_URL = `ws://127.0.0.1:${CHATCCC_PORT}`;

export let CLAUDE_MODEL = config.claude.model;
export let CLAUDE_SUBAGENT_MODEL = config.claude.subagentModel;
export let CLAUDE_EFFORT = config.claude.effort;
export let CLAUDE_MAX_TURN = config.claude.maxTurn;
export let CLAUDE_API_KEY = config.claude.apiKey;
export let CLAUDE_BASE_URL = config.claude.baseUrl;

/** 返回当前生效的 Claude 模型（per-session 覆盖由 session.ts 管理，此处仅返回全局配置） */
export function getEffectiveClaudeModel(): string {
  return CLAUDE_MODEL;
}

// ---------------------------------------------------------------------------
// /git 超时配置（实际值来自 config.json，纯函数与常量见 ./config-utils.ts）
// ---------------------------------------------------------------------------

export let GIT_TIMEOUT_SECONDS = config.gitTimeoutSeconds;
export let GIT_TIMEOUT_MS = GIT_TIMEOUT_SECONDS * 1000;
export let ALLOW_INTERRUPT = config.allowInterrupt;

/** 探测 cursor-agent 安装路径（优先配置，其次 LocalAppData，最后默认 agent） */
function detectCursorAgent(): string {
  if (config.cursor.path) return config.cursor.path;
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const defaultPath = join(localAppData, "cursor-agent", "agent.cmd");
    if (existsSync(defaultPath)) return defaultPath;
  }
  return "agent";
}
/**
 * spawn 第一参数：要启动的 Cursor Agent 可执行文件路径。
 * 命名沿用 Node.js spawn(command, args) 的"command"语义，
 * 与 config.json 的 `cursor.path` 字段不冲突。
 */
export let CURSOR_AGENT_COMMAND = detectCursorAgent();

function resolveCursorAgentArgs(): string[] {
  let args = "-p --force --approve-mcps --output-format stream-json --stream-partial-output";
  const model = config.cursor.model;
  if (model.trim() !== "") {
    args += ` --model ${model}`;
  }
  return args.split(/\s+/).filter(Boolean);
}

/** Cursor agent 参数：-p 非交互模式，--force 强制允许命令，--approve-mcps 自动批准 MCP，stream-json 流式 JSONL 输出 */
export let CURSOR_AGENT_ARGS = resolveCursorAgentArgs();

// ---------------------------------------------------------------------------
// reloadConfigFromDisk — setup → service「在线切换」时刷新进程内 config
// ---------------------------------------------------------------------------
//
// 触发场景：setup 模式下用户在向导里填好凭证、刚把 config.json 写入磁盘，
// 紧接着要在**同一个进程**里启动飞书 service。如果不调用本函数，进程内的
// APP_ID / APP_SECRET 还是 chatccc 启动时（凭证空）的旧值，飞书 API 调用必失败。
//
// 故意不重新触发 sample 复制 / cursor 自动探测等副作用：
// reload 是「读取最新磁盘配置同步到内存」，不应该再写文件。
//
// 注意：CHATCCC_PORT / LOCAL_RELAY_URL 不重新赋值——setup HTTP server 已经
// 监听在原端口上，原地切换复用同一个 server，重新读端口只会引入混乱。

/**
 * 把已加载好的 AppConfig 赋值到 module-level export let 常量里。
 *
 * 拆出独立函数（不直接 inline 进 reloadConfigFromDisk）的目的：
 *   1. 让测试可以用任意 AppConfig 验证"赋值映射"正确性，无需碰文件系统
 *   2. 把"读盘"和"赋值"两个职责分开，便于将来支持其它 config 来源
 */
export function applyLoadedConfig(next: AppConfig): void {
  // 就地更新 config 对象：保留原引用，让 codex-adapter 等"直接 import config"
  // 的下游模块在下次访问 config.codex.* 时就能拿到新值。
  Object.assign(config, next);

  APP_ID = next.feishu.appId;
  APP_SECRET = next.feishu.appSecret;
  FEISHU_ENABLED = next.platforms.feishu.enabled;
  ILINK_ENABLED = next.platforms.ilink.enabled;
  ILINK_REUSE_TOKEN_ON_START = next.platforms.ilink.reuseTokenOnStart ?? true;
  FEISHU_PLATFORM_TYPE = next.platforms.feishu.platformType === "lark" ? "lark" : "feishu";
  BASE_URL = computeBaseUrl(FEISHU_PLATFORM_TYPE);
  CLAUDE_MODEL = next.claude.model;
  CLAUDE_SUBAGENT_MODEL = next.claude.subagentModel;
  CLAUDE_EFFORT = next.claude.effort;
  CLAUDE_MAX_TURN = next.claude.maxTurn;
  CLAUDE_API_KEY = next.claude.apiKey;
  CLAUDE_BASE_URL = next.claude.baseUrl;
  GIT_TIMEOUT_SECONDS = next.gitTimeoutSeconds;
  GIT_TIMEOUT_MS = GIT_TIMEOUT_SECONDS * 1000;
  ALLOW_INTERRUPT = next.allowInterrupt;
  CURSOR_AGENT_COMMAND = detectCursorAgent();
  CURSOR_AGENT_ARGS = resolveCursorAgentArgs();
}

export function reloadConfigFromDisk(): void {
  applyLoadedConfig(loadConfig());
}

// 新建会话的默认工作路径（/cd 命令设置，按 chatId 持久化到本地文件）
// 该路径仅影响通过 /new 新建的会话，不影响已有会话的 resume。
export function getDefaultCwdFile(chatId: string): string {
  return join(USER_DATA_DIR, "state", `working_dir_${chatId}.txt`);
}

/** 会话工具类型持久化文件 */
export const SESSIONS_FILE = join(USER_DATA_DIR, "state", "sessions.json");

/** 最近成功新建会话的工作路径记录（最多 10 条） */
export const RECENT_DIRS_FILE = join(USER_DATA_DIR, "state", "recent_dirs.json");
export const MAX_RECENT_DIRS = 10;

/** 读取最近使用过的工作路径列表（最新的在前） */
export async function getRecentDirs(): Promise<string[]> {
  try {
    const raw = await readFile(RECENT_DIRS_FILE, "utf-8");
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      const seen = new Set<string>();
      return arr.filter((d: unknown): d is string => {
        if (typeof d !== "string") return false;
        if (seen.has(d)) return false;
        seen.add(d);
        return true;
      });
    }
  } catch { /* file doesn't exist or corrupted */ }
  return [];
}

/** 添加一个路径到最近使用列表（去重、限制数量、最新的在前） */
export async function addRecentDir(dir: string): Promise<void> {
  const dirs = await getRecentDirs();
  const filtered = dirs.filter(d => d !== dir);
  filtered.unshift(dir);
  const trimmed = filtered.slice(0, MAX_RECENT_DIRS);
  try {
    await mkdir(dirname(RECENT_DIRS_FILE), { recursive: true });
    await writeFile(RECENT_DIRS_FILE, JSON.stringify(trimmed, null, 2), "utf-8");
  } catch (err) {
    console.error(`[${ts()}] Failed to save recent_dirs.json: ${(err as Error).message}`);
    fileLog.flush();
  }
}

/** 读取 /cd 设置的默认工作路径。若 chatId 对应的文件不存在或路径已失效，回退到用户主目录。 */
export async function getDefaultCwd(chatId?: string): Promise<string> {
  if (chatId) {
    try {
      const content = await readFile(getDefaultCwdFile(chatId), "utf-8");
      const dir = content.trim();
      if (dir) {
        try {
          const s = await stat(dir);
          if (s.isDirectory()) return dir;
        } catch { /* path gone, fall through */ }
      }
    } catch { /* file doesn't exist yet */ }
  }
  return homedir();
}

/** 设置新建会话的默认工作路径（由 /cd 命令调用，按 chatId 持久化） */
export async function setDefaultCwd(dir: string, chatId: string): Promise<void> {
  await writeFile(getDefaultCwdFile(chatId), dir, "utf-8");
}

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

export function ts(): string {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

/** 仅用于日志确认「已读到某个 App」，不泄露 Secret */
export function maskAppId(id: string): string {
  if (!id) return "(空)";
  if (id.length <= 10) return `${id.slice(0, 4)}***`;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

/**
 * 启动时逐项说明配置读取结果。
 */
export function reportEnvironmentVariableReadout(): void {
  const ok = (label: string, name: string, kind: "必填" | "可选", ok: boolean, detail: string): void => {
    const state = ok ? "成功" : "失败";
    console.log(`  [${state}] [${kind}] ${name}`);
    console.log(`         ${label}: ${detail}`);
  };

  console.log("  --- 配置读取结果（成功=已读入；失败=必填缺失或格式错误；默认=未设置则用内置值）---");

  const configExists = existsSync(CONFIG_FILE);
  console.log(
    `  [信息] config.json: ${configExists ? "存在" : "不存在"} → ${CONFIG_FILE}`
  );
  if (!configExists) {
    console.log("          config.json 不存在时已从 config.sample.json 自动创建，请编辑后重新启动。");
  }

  ok(
    "飞书应用",
    "feishu.appId",
    "必填",
    Boolean(APP_ID.trim()),
    APP_ID.trim() ? `已读入，摘要 ${maskAppId(APP_ID)}` : "未读入或为空"
  );
  ok(
    "飞书应用",
    "feishu.appSecret",
    "必填",
    Boolean(APP_SECRET.trim()),
    APP_SECRET.trim() ? "已读入（内容不在日志中显示）" : "未读入或为空"
  );

  console.log(`  [默认] [可选] platforms.feishu.platformType`);
  console.log(`         平台类型: ${FEISHU_PLATFORM_TYPE === "lark" ? "Lark (open.larksuite.com)" : "飞书 (open.feishu.cn)"}`);

  console.log(`  [默认] [可选] port`);
  console.log(`         监听端口: ${CHATCCC_PORT}`);

  console.log(`  [默认] [可选] claude.model`);
  console.log(
    `         Claude 模型: ${anthropicConfigDisplay(CLAUDE_MODEL)}（留空时不向 SDK 传 model）`
  );

  console.log(`  [默认] [可选] claude.subagentModel`);
  console.log(
    `         Claude Subagent 模型: ${anthropicConfigDisplay(CLAUDE_SUBAGENT_MODEL)}（留空时不向 SDK 传 CLAUDE_CODE_SUBAGENT_MODEL）`
  );

  console.log(`  [默认] [可选] claude.effort`);
  console.log(
    `         思考深度: ${anthropicConfigDisplay(CLAUDE_EFFORT)}（留空时不向 SDK 传 effort）`
  );

  console.log(`  [默认] [可选] gitTimeoutSeconds`);
  console.log(`         /git 命令超时: ${GIT_TIMEOUT_SECONDS}s`);

  console.log("  ------------------------------------------------------------------");
}

/** 飞书凭证缺失时打印可操作的说明并退出 */
export function explainMissingFeishuCredentialsAndExit(): never {
  appendStartupTrace("explainMissingFeishuCredentialsAndExit: exiting", {
    hasAppId: Boolean(APP_ID.trim()),
    hasAppSecret: Boolean(APP_SECRET.trim()),
  });
  const missing: string[] = [];
  if (!APP_ID.trim()) missing.push("feishu.appId");
  if (!APP_SECRET.trim()) missing.push("feishu.appSecret");

  console.error("\n" + "=".repeat(64));
  console.error("  ChatCCC 启动失败：飞书应用凭证未就绪");
  console.error("=".repeat(64));
  console.error("\n【失败步骤】环境与变量检查（在连接飞书之前）");
  console.error(`\n【未配置的配置项】\n  - ${missing.join("\n  - ")}`);
  console.error(`\n【配置文件路径】\n  ${CONFIG_FILE}`);
  console.error(
    "  处理: 编辑 config.json 填入飞书开放平台的 App ID / App Secret；\n" +
      "        如 config.json 不存在，可复制 config.sample.json 为 config.json 后编辑。"
  );
  console.error(`\n【程序包根目录】\n  ${PROJECT_ROOT}`);
  console.error("\n" + "=".repeat(64) + "\n");
  printServiceDidNotStart(`未配置: ${missing.join("、")}`);
  process.exit(1);
}

/** 群描述中用于识别 Claude Code 会话的前缀 */
export const CLAUDE_SESSION_PREFIX = "Claude Code Session:";
/** 群描述中用于识别 Cursor 会话的前缀 */
export const CURSOR_SESSION_PREFIX = "Cursor Session:";
/** 群描述中用于识别 Codex 会话的前缀 */
export const CODEX_SESSION_PREFIX = "Codex Session:";
/** 群描述中用于识别 hidden ccc agent 会话的前缀 */
export const CCC_SESSION_PREFIX = "CCC Session:";

/** 根据 tool 名称返回对应的群描述前缀 */
export function sessionPrefixForTool(tool: string): string {
  if (tool === "cursor") return CURSOR_SESSION_PREFIX;
  if (tool === "codex") return CODEX_SESSION_PREFIX;
  if (tool === "ccc") return CCC_SESSION_PREFIX;
  return CLAUDE_SESSION_PREFIX;
}

/** 根据 tool 名称返回用于状态展示的标签 */
export function toolDisplayName(tool: string): string {
  if (tool === "cursor") return "Cursor";
  if (tool === "codex") return "Codex";
  if (tool === "ccc") return "CCC Agent";
  return "Claude Code";
}

/** 解析 /new 未指定工具时使用的默认 Agent。旧配置缺省 defaultAgent 时保持 Claude 优先。 */
export function resolveDefaultAgentTool(cfg: AppConfig = config): AgentTool {
  const explicit = AGENT_TOOLS.find((tool) => cfg[tool].enabled && cfg[tool].defaultAgent);
  if (explicit) return explicit;
  const enabledFallback = AGENT_TOOLS.find((tool) => cfg[tool].enabled);
  return enabledFallback ?? "claude";
}

// 导出 config 对象供其他模块直接访问原始配置
export { CONFIG_FILE, CONFIG_SAMPLE_FILE };
