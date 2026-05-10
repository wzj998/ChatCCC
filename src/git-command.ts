// =============================================================================
// git-command.ts — /git 命令的执行与结果格式化
// =============================================================================
// 解析自 /git 后的原始字符串作为 shell 参数，在指定 cwd 下通过 shell 调起
// `git ...`，收集 stdout/stderr 与退出码。带超时（kill）与逐路输出字节上限
// （超过即截断），避免长输出撑爆内存或刷屏。
//
// 抽成独立模块是为了便于在不依赖飞书 SDK / 网络的前提下跑单元测试。
// =============================================================================

import { spawn } from "node:child_process";

import { truncateContent } from "./cards.ts";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface GitCommandResult {
  /** 进程退出码；spawn 失败或被 kill 时为 null */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** 任意一路输出超过 maxBytes 上限，已被截断 */
  truncated: boolean;
  /** 命令超过 timeoutMs 被强制终止 */
  timedOut: boolean;
  /** spawn 自身错误（如 git 不在 PATH）；正常退出（含非 0）时为 undefined */
  spawnError?: string;
}

export interface RunGitOptions {
  /** 命令最大允许执行毫秒数；超过则 SIGKILL，默认 60_000 */
  timeoutMs?: number;
  /** stdout 与 stderr 各自最多采集多少字节；默认 64 KiB */
  maxBytes?: number;
  /** 注入测试桩用：自定义 spawn 函数；默认使用 node:child_process 的 spawn */
  spawnImpl?: typeof spawn;
}

// ---------------------------------------------------------------------------
// runGitCommand —— 在 cwd 下执行 `git <args>`
// ---------------------------------------------------------------------------

/**
 * 在 `cwd` 目录下执行 `git <args>`。
 * - 通过 shell 执行（`shell: true`），允许用户使用引号、管道等 shell 语法
 * - stdout/stderr 各自最多采集 `maxBytes` 字节，超过则置 truncated=true 并丢弃后续片段
 * - 超时则 SIGKILL 并置 timedOut=true，仍返回已收集的部分输出
 *
 * 注意：本函数 **不会抛错**——任何失败都通过返回值传递（退出码、spawnError 等），
 * 调用方需通过 exitCode/spawnError/timedOut/truncated 判断结果。
 */
export function runGitCommand(
  args: string,
  cwd: string,
  opts: RunGitOptions = {},
): Promise<GitCommandResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const maxBytes = opts.maxBytes ?? 64 * 1024;
  const spawnImpl = opts.spawnImpl ?? spawn;
  const startTime = Date.now();

  return new Promise<GitCommandResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnImpl(`git ${args}`, {
        cwd,
        shell: true,
        windowsHide: true,
      });
    } catch (err) {
      resolve({
        exitCode: null,
        stdout: "",
        stderr: "",
        durationMs: Date.now() - startTime,
        truncated: false,
        timedOut: false,
        spawnError: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let spawnError: string | undefined;

    const collect = (chunk: Buffer, current: { bytes: number; text: string }): void => {
      const room = maxBytes - current.bytes;
      if (room <= 0) {
        truncated = true;
        return;
      }
      const slice = chunk.length <= room ? chunk : chunk.subarray(0, room);
      current.text += slice.toString("utf-8");
      current.bytes += slice.length;
      if (chunk.length > room) truncated = true;
    };

    const stdoutState = { bytes: 0, text: "" };
    const stderrState = { bytes: 0, text: "" };

    child.stdout?.on("data", (chunk: Buffer) => {
      collect(chunk, stdoutState);
      stdout = stdoutState.text;
      stdoutBytes = stdoutState.bytes;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      collect(chunk, stderrState);
      stderr = stderrState.text;
      stderrBytes = stderrState.bytes;
    });

    const killTimer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore: 进程可能已退出
      }
    }, timeoutMs);

    child.on("error", (err: Error) => {
      spawnError = err.message;
    });

    child.on("close", (code: number | null) => {
      clearTimeout(killTimer);
      // 仅引用未直接使用的字节计数变量以避免编译告警
      void stdoutBytes; void stderrBytes;
      resolve({
        exitCode: code,
        stdout,
        stderr,
        durationMs: Date.now() - startTime,
        truncated,
        timedOut,
        spawnError,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// formatGitResult —— 把执行结果渲染为飞书卡片用的 markdown
// ---------------------------------------------------------------------------

/**
 * 渲染 `/git` 执行结果为发送给用户的 markdown 字符串。
 * stdout/stderr 单路各最多保留 `maxLines` 行 / `maxChars` 字符（沿用 truncateContent），
 * 命令本身的截断状态（truncated/timedOut/spawnError）也会在头部说明。
 */
export function formatGitResult(
  args: string,
  cwd: string,
  result: GitCommandResult,
  opts: { maxLines?: number; maxChars?: number } = {},
): string {
  const maxLines = opts.maxLines ?? 50;
  const maxChars = opts.maxChars ?? 6000;
  const sec = (result.durationMs / 1000).toFixed(2);
  const lines: string[] = [];

  lines.push(`**\$ git ${args}**`);
  lines.push(`工作目录: \`${cwd}\``);
  const exitDisplay = result.exitCode === null ? "(无)" : String(result.exitCode);
  lines.push(`退出码: \`${exitDisplay}\` | 用时: \`${sec}s\``);
  if (result.timedOut) lines.push(`⏱️ 命令超时被强制终止`);
  if (result.truncated) lines.push(`⚠️ 输出超出采集上限，已截断`);
  if (result.spawnError) lines.push(`❌ 启动失败: ${result.spawnError}`);

  const stdoutTrim = result.stdout.trim();
  const stderrTrim = result.stderr.trim();

  if (stdoutTrim) {
    lines.push("", "**stdout:**", "```", truncateContent(stdoutTrim, maxLines, maxChars), "```");
  }
  if (stderrTrim) {
    lines.push("", "**stderr:**", "```", truncateContent(stderrTrim, maxLines, maxChars), "```");
  }
  if (!stdoutTrim && !stderrTrim && !result.spawnError) {
    lines.push("", "_(命令无输出)_");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 头部颜色：成功绿色，失败红色，超时黄色
// ---------------------------------------------------------------------------

export function gitResultHeaderTemplate(result: GitCommandResult): string {
  if (result.timedOut || result.spawnError) return "yellow";
  if (result.exitCode === 0) return "green";
  return "red";
}
