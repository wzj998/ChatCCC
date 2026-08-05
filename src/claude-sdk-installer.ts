// =============================================================================
// claude-sdk-installer.ts — Claude Code 引擎（Agent SDK）按需安装器
// =============================================================================
// 背景：@anthropic-ai/claude-agent-sdk 通过 optionalDependencies 内置各平台
// 的原生 CLI 二进制（Windows 上 claude.exe 约 215MB），若作为 chatccc 的硬依赖，
// 所有用户（包括不用 Claude Code 的）都要白白下载 220MB+。
//
// 方案：把 SDK 从 chatccc 的 dependencies 中移除，改为**按需安装**到
// `~/.chatccc/claude-sdk/`：
//   - 用户未启用 Claude Code → 完全不下载，npm 包体积大幅下降；
//   - 用户在设置页打开 Claude Code 开关时，点「安装引擎」触发后台安装，
//     带进度条（状态式：检测环境 → 下载中 → 安装中 → 完成/失败）。
//
// 设计约束：
//   - **不 import config.ts**（config.ts 顶层有 loadConfig 副作用，web-ui.ts
//     依赖本模块，间接 import config.ts 会污染依赖 web-ui.ts 的单测）。
//   - 始终使用 SDK 内置的 CLI 二进制（用户拍板档位 b），不依赖用户自装 CLI。
//   - 安装目录可注入（dir 参数），便于单测用临时目录，不碰真实用户目录。
// =============================================================================

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** 与当前代码配套的 SDK 版本（package.json 移除依赖后此常量成为唯一版本来源） */
export const CLAUDE_SDK_VERSION = "0.2.133";

/** 按需安装目录：~/.chatccc/claude-sdk */
export const CLAUDE_SDK_DIR = join(homedir(), ".chatccc", "claude-sdk");

const SDK_PKG_REL = join("node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json");
const SDK_ENTRY_REL = join("node_modules", "@anthropic-ai", "claude-agent-sdk", "sdk.mjs");
const LOCK_FILE = ".installing";

/** 估算的完整安装体积（含内置 CLI 二进制），用于进度条展示 */
export const CLAUDE_SDK_EXPECTED_BYTES = 240 * 1024 * 1024;

export type SdkInstallPhase =
  | "idle"
  | "detecting"
  | "downloading"
  | "installing"
  | "done"
  | "error";

export interface SdkInstallProgress {
  phase: SdkInstallPhase;
  /** 0-100 */
  percent: number;
  message: string;
  error?: string;
}

export interface SdkInstallOptions {
  /** 安装目录（测试注入临时目录） */
  dir?: string;
  /** npm 命令（测试注入 fake） */
  npmCommand?: string;
  /** 期望版本（默认 CLAUDE_SDK_VERSION） */
  expectedVersion?: string;
  /** 进度回调 */
  onProgress?: (p: SdkInstallProgress) => void;
}

// ---------------------------------------------------------------------------
// 状态查询
// ---------------------------------------------------------------------------

/** SDK 入口文件绝对路径（供动态 import） */
export function getClaudeSdkEntryPath(dir: string = CLAUDE_SDK_DIR): string {
  return join(dir, SDK_ENTRY_REL);
}

/** 是否已安装（node_modules 里存在 SDK package.json 即视为已装） */
export function isClaudeSdkInstalled(dir: string = CLAUDE_SDK_DIR): boolean {
  return existsSync(join(dir, SDK_PKG_REL));
}

/** 已安装版本号；未安装/解析失败返回 null */
export function getClaudeSdkInstalledVersion(dir: string = CLAUDE_SDK_DIR): string | null {
  try {
    const raw = readFileSync(join(dir, SDK_PKG_REL), "utf8");
    const pkg = JSON.parse(raw) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/** 是否正在安装（锁文件存在且 pid 存活）；pid 已死视为过期锁并自动清理 */
export function isClaudeSdkInstalling(dir: string = CLAUDE_SDK_DIR): boolean {
  const lockPath = join(dir, LOCK_FILE);
  if (!existsSync(lockPath)) return false;
  try {
    const pid = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
    if (Number.isFinite(pid) && pid > 0 && isPidAlive(pid)) return true;
  } catch {
    // 锁文件损坏 → 按过期处理，走清理
  }
  try {
    unlinkSync(lockPath);
  } catch {
    // 清理失败不阻塞判断
  }
  return false;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// ---------------------------------------------------------------------------
// 安装（后台任务 + 进度）
// ---------------------------------------------------------------------------

/** 最近一次安装的进度快照，供 web-ui 轮询 */
let lastProgress: SdkInstallProgress = { phase: "idle", percent: 0, message: "" };
let installInProgress = false;

export function getLastInstallProgress(): SdkInstallProgress {
  return { ...lastProgress, ...(lastProgress.error ? { error: lastProgress.error } : {}) };
}

export function isInstallRunning(): boolean {
  return installInProgress;
}

function setProgress(p: SdkInstallProgress, onProgress?: (p: SdkInstallProgress) => void): void {
  lastProgress = { ...p };
  onProgress?.(lastProgress);
}

/**
 * 启动按需安装。返回 Promise，安装完成 resolve、失败 reject。
 * 调用方通常不 await（后台执行），通过 onProgress / getLastInstallProgress() 获取进度。
 */
export async function installClaudeSdk(options: SdkInstallOptions = {}): Promise<void> {
  const dir = options.dir ?? CLAUDE_SDK_DIR;
  const npmCommand = options.npmCommand ?? "npm";
  const expected = options.expectedVersion ?? CLAUDE_SDK_VERSION;
  const onProgress = options.onProgress;

  if (installInProgress) {
    throw new Error("Claude Code 引擎正在安装中，请等待完成后再试。");
  }
  if (isClaudeSdkInstalling(dir)) {
    throw new Error("检测到另一个安装任务正在进行（锁文件存在），请稍后再试。");
  }

  const installedVersion = isClaudeSdkInstalled(dir) ? getClaudeSdkInstalledVersion(dir) : null;
  if (installedVersion === expected) {
    setProgress({ phase: "done", percent: 100, message: `已安装 v${installedVersion}` }, onProgress);
    return;
  }
  if (installedVersion !== null && installedVersion !== expected) {
    setProgress(
      {
        phase: "detecting",
        percent: 3,
        message: `已装 v${installedVersion} ≠ 期望 v${expected}，开始重装…`,
      },
      onProgress,
    );
  }

  installInProgress = true;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, LOCK_FILE), String(process.pid), "utf8");

  setProgress({ phase: "detecting", percent: 2, message: "检测环境…" }, onProgress);

  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      npmCommand,
      [
        "install",
        "--prefix",
        dir,
        `@anthropic-ai/claude-agent-sdk@${expected}`,
        "--no-audit",
        "--no-fund",
        "--loglevel=http",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        // Windows 下 npm 是 npm.cmd，需要 shell 才能解析
        shell: process.platform === "win32",
      },
    );

    let stderrBuf = "";
    let requestCount = 0;
    let sizeTimer: ReturnType<typeof setInterval> | null = null;

    const updateBySize = (): void => {
      const size = dirSizeBytes(dir);
      const sizePercent = Math.min((size / CLAUDE_SDK_EXPECTED_BYTES) * 90, 90);
      const requestPercent = Math.min(5 + requestCount * 4, 70);
      const percent = Math.max(sizePercent, requestPercent);
      const mb = (size / 1048576).toFixed(0);
      setProgress(
        {
          phase: "downloading",
          percent: Math.min(percent, 94),
          message: `下载中… 已下载 ${mb} MB / 约 220 MB`,
        },
        onProgress,
      );
    };

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      // npm --loglevel=http 每完成一个请求输出一行 "npm http fetch GET 200 ..."
      requestCount += (text.match(/http fetch GET|GET \d{3}/g) ?? []).length;
      updateBySize();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });

    child.on("error", (err) => {
      cleanupAfterFailure(dir, err, onProgress, () => {
        installInProgress = false;
        reject(err);
      });
    });

    child.on("close", (code) => {
      if (sizeTimer) clearInterval(sizeTimer);
      if (code === 0 && isClaudeSdkInstalled(dir)) {
        const version = getClaudeSdkInstalledVersion(dir);
        installInProgress = false;
        try {
          unlinkSync(join(dir, LOCK_FILE));
        } catch {
          // 锁文件不存在可忽略
        }
        setProgress(
          { phase: "done", percent: 100, message: `安装完成（v${version ?? expected}）` },
          onProgress,
        );
        resolve();
      } else {
        const tail = stderrBuf.trim().split("\n").slice(-5).join(" | ");
        const detail = code !== 0 ? `npm 退出码 ${code}` : "安装后校验未通过";
        const message = tail ? `${detail}：${tail.slice(0, 400)}` : detail;
        cleanupAfterFailure(dir, new Error(message), onProgress, () => {
          installInProgress = false;
          reject(new Error(message));
        });
      }
    });

    // 定期按目录体积刷新进度（大文件下载时 stdout 事件稀疏）
    sizeTimer = setInterval(() => {
      if (installInProgress) updateBySize();
    }, 400);
    if (typeof sizeTimer.unref === "function") sizeTimer.unref();
  });
}

function cleanupAfterFailure(
  dir: string,
  err: Error,
  onProgress: ((p: SdkInstallProgress) => void) | undefined,
  after: () => void,
): void {
  setProgress(
    { phase: "error", percent: 0, message: "安装失败", error: err.message.slice(0, 500) },
    onProgress,
  );
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // 清理失败不阻塞
  }
  after();
}

function dirSizeBytes(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          total += statSync(full).size;
        } catch {
          // 文件被并发删除可忽略
        }
      }
    }
  }
  return total;
}
