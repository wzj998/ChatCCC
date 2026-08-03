/**
 * file-log.ts — DeepCCC 文件日志（写入 ~/.deepccc/logs/）
 *
 * 交互渲染模式下渲染器独占终端 stdout：普通 console 日志只写文件、不回显
 * 到终端，避免生成过程中任何 console 输出混入过程区块、破坏行数计数
 * （导致重绘上移不足、把上方历史内容"吃掉"）。
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function setupFileLogging(logDir: string, prefix: string): { logPath: string } {
  mkdirSync(logDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const logPath = join(logDir, `${prefix}-${ts}.log`);
  appendFileSync(logPath, "", { flag: "a", encoding: "utf8" });
  return { logPath };
}

/** 默认日志目录：~/.deepccc/logs */
export function defaultLogDir(): string {
  return join(homedir(), ".deepccc", "logs");
}

export function writeLogLine(logPath: string, level: string, args: unknown[]): void {
  try {
    const text = args
      .map((a) =>
        typeof a === "string" ? a
          : a instanceof Error ? (a.stack ?? a.message)
          : JSON.stringify(a))
      .join(" ");
    appendFileSync(logPath, `[${new Date().toISOString()}] [${level}] ${text}\n`, "utf8");
  } catch {
    // 日志系统自身失败不影响主流程
  }
}
