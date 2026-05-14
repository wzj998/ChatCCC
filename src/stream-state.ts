import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { USER_DATA_DIR, ts } from "./config.ts";

// ---------------------------------------------------------------------------
// stream-state.json — 每个 session 的流式输出持久化文件
// ---------------------------------------------------------------------------

export const STREAMS_DIR = join(USER_DATA_DIR, "state", "streams");

export interface StreamState {
  sessionId: string;
  status: "running" | "done" | "stopped" | "error";
  accumulatedContent: string;
  finalReply: string;
  chunkCount: number;
  turnCount: number;
  contextTokens: number;
  updatedAt: number;
  cwd: string;
  tool: string;
}

function getStreamStatePath(sessionId: string): string {
  return join(STREAMS_DIR, `${sessionId}.json`);
}

export async function readStreamState(sessionId: string): Promise<StreamState | null> {
  try {
    const raw = await readFile(getStreamStatePath(sessionId), "utf-8");
    const parsed = JSON.parse(raw) as StreamState;
    if (parsed && typeof parsed.sessionId === "string") return parsed;
    return null;
  } catch {
    return null;
  }
}

// rename 的可注入实现——仅供测试模拟"Windows EPERM 降级"路径。
// 生产代码使用 node:fs/promises.rename。
let renameImpl: typeof rename = rename;

/**
 * 仅供单测：注入自定义 rename 实现以验证降级分支。
 * 调用方负责测试结束后用 _resetRenameForTest 还原。
 */
export function _setRenameForTest(impl: typeof rename): void {
  renameImpl = impl;
}

export function _resetRenameForTest(): void {
  renameImpl = rename;
}

/**
 * 把 StreamState 持久化到磁盘——尽量原子地写。
 *
 * 为什么需要原子写：display loop 每 3 秒读一次 stream-state.json,而
 * runAgentSession 每 2 秒写一次。如果用 `writeFile(filePath, ...)` 直接
 * 覆盖,reader 在写入过程中读会拿到半截 JSON,JSON.parse 报错——虽然
 * readStreamState 包了 try/catch 返回 null 不会崩,但相当于"丢一帧"。
 *
 * 实现：
 *   1) 先把内容写到 `<filePath>.tmp`（reader 不会读 .tmp）
 *   2) 再用 `rename` 把 .tmp 替换成正式文件——`rename` 在 POSIX 上是真原子
 *      操作,reader 任何时刻读到的都是某个完整的旧/新版本
 *
 * Windows 兼容性：Windows 上 `rename` 偶尔会因为目标文件正被 reader 打开
 * 抛 EPERM/EBUSY（实测罕见,但非零概率）。降级方案：直接 writeFile 覆盖
 * 真文件,这一帧可能被 reader 读到半截,但 readStreamState 的 try/catch 兜底
 * 会让 loop 跳过这一帧,2 秒后下次 write 大概率成功——比写盘失败丢数据好。
 */
export async function writeStreamState(state: StreamState): Promise<void> {
  const filePath = getStreamStatePath(state.sessionId);
  const payload = JSON.stringify(state, null, 2);
  try {
    await mkdir(dirname(filePath), { recursive: true });
    const tmpPath = filePath + ".tmp";
    await writeFile(tmpPath, payload, "utf-8");
    try {
      await renameImpl(tmpPath, filePath);
    } catch (renameErr) {
      // Windows 偶发 EPERM/EBUSY：rename 失败时降级为直接覆盖写。
      // 此次写入失去原子性（reader 可能读到半截 JSON,但 readStreamState
      // 的 try/catch 会兜底返回 null,只是丢一帧 display 更新）。
      console.warn(
        `[${ts()}] [STREAM-STATE] rename failed for ${state.sessionId}, ` +
          `fallback to overwrite: ${(renameErr as Error).message}`,
      );
      await writeFile(filePath, payload, "utf-8");
      // 尽力清理 .tmp,失败也无所谓——下次 write 会覆盖它
      await unlink(tmpPath).catch(() => {});
    }
  } catch (err) {
    console.error(`[${ts()}] Failed to write stream-state for ${state.sessionId}: ${(err as Error).message}`);
  }
}

export function createEmptyStreamState(sessionId: string, cwd: string, tool: string, turnCount: number): StreamState {
  return {
    sessionId,
    status: "running",
    accumulatedContent: "",
    finalReply: "",
    chunkCount: 0,
    turnCount,
    contextTokens: 0,
    updatedAt: Date.now(),
    cwd,
    tool,
  };
}

/** 进程重启时修正虚假的 "running" 状态 */
export async function fixStaleStreamStates(): Promise<void> {
  // 启动时将残留的 running 标记为 error
  // 实际 agent 进程已不存在，下次 prompt 时会自然覆盖
  try {
    const { readdir } = await import("node:fs/promises");
    let entries: string[];
    try {
      entries = await readdir(STREAMS_DIR);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const state = await readStreamState(entry.replace(".json", ""));
      if (state && state.status === "running") {
        state.status = "error";
        state.accumulatedContent += "\n\n⚠️ 进程重启，流式输出中断。";
        state.updatedAt = Date.now();
        await writeStreamState(state);
        console.log(`[${ts()}] [STREAM-STATE] marked stale running as error: ${state.sessionId}`);
      }
    }
  } catch (err) {
    console.error(`[${ts()}] [STREAM-STATE] fixStaleStreamStates failed: ${(err as Error).message}`);
  }
}