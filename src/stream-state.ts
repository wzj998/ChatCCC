import { readFile, writeFile, mkdir } from "node:fs/promises";
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

export async function writeStreamState(state: StreamState): Promise<void> {
  const filePath = getStreamStatePath(state.sessionId);
  try {
    await mkdir(dirname(filePath), { recursive: true });
    // 先写临时文件再 rename，保证原子性
    const tmpPath = filePath + ".tmp";
    await writeFile(tmpPath, JSON.stringify(state, null, 2), "utf-8");
    await writeFile(filePath, JSON.stringify(state, null, 2), "utf-8");
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