// ---------------------------------------------------------------------------
// 纯函数/常量工具集
//
// 这些工具与 fs / 进程状态完全无关（CLI 路径探测函数虽然要查文件/PATH，但所有
// I/O 通过参数注入，函数本身仍然是纯函数，可被单测无副作用地调用）。
// 其它生产代码应优先从 `./config.ts` 引用（`config.ts` 会 re-export 这里的符号），
// 仅在需要避免触发 config.ts 副作用的场景（如单测）才直接 import 本文件。
// ---------------------------------------------------------------------------

import { join } from "node:path";

/**
 * 把 model / effort 等"可选向 SDK/CLI 透传"的字段标准化为字符串。
 *
 * 项目内部统一约定：`""`（空字符串/全空白）表示**不向 SDK/CLI 传该字段**。
 * 旧版本曾使用字面量 `"default"` 表达同样的意思，本函数兼容性地把它视作 `""`，
 * 并在每次启动时打印一次 warning，提示用户更新 config.json。
 *
 * - `value` 不是字符串（例如 undefined / 缺失）→ 使用 `fallback`（默认 `""`）。
 * - `value` 去除空白后等于 `"default"`（不区分大小写）→ 视作 `""` 并 warn。
 * - 其余情况原样返回（不裁剪两端空白，留给具体调用方决定）。
 */
export function normalizeOptionalConfigField(
  value: unknown,
  options: { label: string; fallback?: string },
): string {
  const fallback = options.fallback ?? "";
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (trimmed.toLowerCase() === "default") {
    console.warn(
      `[CONFIG] ${options.label} 的值 "${trimmed}" 已废弃，请改为 ""（空字符串）表示不向 SDK/CLI 传该字段；本次启动按 "" 处理。`,
    );
    return "";
  }
  return value;
}

// ---------------------------------------------------------------------------
// /git 超时配置相关
// ---------------------------------------------------------------------------

/** /git 命令默认超时秒数（用户未配置时使用） */
export const DEFAULT_GIT_TIMEOUT_SECONDS = 180;
/** /git 超时允许的下限/上限（防止 0、负数、过大值导致行为异常） */
export const MIN_GIT_TIMEOUT_SECONDS = 1;
export const MAX_GIT_TIMEOUT_SECONDS = 3600; // 1 小时

export interface ParsedGitTimeout {
  /** 实际使用的超时秒数（无效时回退为 default） */
  seconds: number;
  /** 用户提供的原始字符串是否为合法整数秒（true 表示采纳了用户值或未提供） */
  valid: boolean;
  /** 用户原始字符串 */
  raw?: string;
  /** 是否使用了内置默认值（即用户未提供有效值） */
  usingDefault: boolean;
}

export function parseGitTimeoutSeconds(
  raw: string | number | undefined,
  defaultSeconds = DEFAULT_GIT_TIMEOUT_SECONDS,
): ParsedGitTimeout {
  if (typeof raw === "number") {
    if (
      !Number.isFinite(raw) ||
      !Number.isInteger(raw) ||
      raw < MIN_GIT_TIMEOUT_SECONDS ||
      raw > MAX_GIT_TIMEOUT_SECONDS
    ) {
      return { seconds: defaultSeconds, valid: false, raw: String(raw), usingDefault: true };
    }
    return { seconds: raw, valid: true, raw: String(raw), usingDefault: false };
  }

  const trimmed = raw?.trim();
  if (!trimmed) {
    return { seconds: defaultSeconds, valid: true, usingDefault: true };
  }
  const n = Number(trimmed);
  if (
    !Number.isFinite(n) ||
    !Number.isInteger(n) ||
    n < MIN_GIT_TIMEOUT_SECONDS ||
    n > MAX_GIT_TIMEOUT_SECONDS
  ) {
    return { seconds: defaultSeconds, valid: false, raw: trimmed, usingDefault: true };
  }
  return { seconds: n, valid: true, raw: trimmed, usingDefault: false };
}

/**
 * 判断 model / effort 等"可选向 SDK/CLI 透传"的字段是否为"不传值"。
 * 项目内部统一以空字符串（含全空白）表示该语义。
 */
export function isAnthropicConfigEmpty(value: string): boolean {
  return value.trim() === "";
}

/** 状态展示用：留空时显示 `(留空)`，否则原样返回。 */
export function anthropicConfigDisplay(value: string): string {
  return isAnthropicConfigEmpty(value) ? "(留空)" : value;
}

// ---------------------------------------------------------------------------
// CLI 可执行文件路径探测（依赖 fs/PATH，但通过参数注入保持纯函数特性）
// ---------------------------------------------------------------------------

export interface PathDetectorDeps {
  /** 用于检查文件是否存在的同步函数（生产环境注入 fs.existsSync） */
  existsSync: (path: string) => boolean;
  /** 通过 `where` (Win) / `which` (Mac/Linux) 解析命令绝对路径，找不到返回 null */
  whichSync: (cmd: string) => string | null;
  /** process.env.LOCALAPPDATA（Windows 上 Cursor IDE 默认安装根） */
  localAppData?: string | undefined;
  /** process.platform（用于判定 Windows 默认安装路径是否适用） */
  platform: NodeJS.Platform;
}

/**
 * 探测 Cursor Agent CLI 的可执行文件绝对路径。
 *
 * 优先级（依次尝试，命中即返回）：
 *   1. Windows + `%LOCALAPPDATA%\cursor-agent\agent.cmd`（Cursor IDE 默认安装位置）
 *   2. PATH 中查找 `cursor-agent`（独立 CLI 安装常见名）
 *   3. PATH 中查找 `agent`（旧版默认名）
 *
 * 全部命中失败时返回 `null`，调用方可选择留空让运行时回退到 PATH 兜底。
 */
export function autoDetectCursorPath(deps: PathDetectorDeps): string | null {
  if (deps.platform === "win32" && deps.localAppData) {
    const localPath = join(deps.localAppData, "cursor-agent", "agent.cmd");
    if (deps.existsSync(localPath)) return localPath;
  }
  return deps.whichSync("cursor-agent") ?? deps.whichSync("agent");
}

/**
 * 探测 Codex CLI 的可执行文件绝对路径。
 *
 * Codex 没有固定安装位置，只通过 PATH 查找 `codex` 命令。
 * 找不到时返回 `null`，由调用方决定留空或后续重试。
 */
export function autoDetectCodexPath(
  deps: Pick<PathDetectorDeps, "whichSync">,
): string | null {
  return deps.whichSync("codex");
}

// ---------------------------------------------------------------------------
// CLI 路径字段（cursor.path / codex.path）的兼容性读取
// ---------------------------------------------------------------------------

/**
 * 从 raw config 对象中读取 cursor / codex 的 CLI 路径，兼容旧字段名 `command`。
 *
 * - 优先读 `path`，回退到旧字段 `command`（升级前的 config.json 仍然可用）
 * - 回退命中时通过 `onLegacyField` 回调通知调用方（用于打印一次性 warning）
 * - 不要在此函数里写文件，迁移交给上层
 */
export function readToolCliPath(
  raw: { path?: unknown; command?: unknown } | undefined,
  options: {
    /** 工具标签，仅用于 warning 文案，例如 "cursor" / "codex" */
    label: string;
    /** 命中旧字段时调用，调用方负责打印或记录 warning */
    onLegacyField?: (label: string, legacyValue: string) => void;
  },
): string {
  if (!raw) return "";
  if (typeof raw.path === "string" && raw.path.trim() !== "") return raw.path;
  if (typeof raw.command === "string" && raw.command.trim() !== "") {
    options.onLegacyField?.(options.label, raw.command);
    return raw.command;
  }
  return "";
}
