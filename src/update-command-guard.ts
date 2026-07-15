import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const UPDATE_COMMAND_GUARD_FILE = join(
  homedir(),
  ".chatccc",
  "state",
  "update-command-guard.json",
);

const UPDATE_COMMAND_GUARD_VERSION = 1;
const DEFAULT_MAX_PROCESSED_IDS = 100;

interface ProcessedUpdateCommand {
  id: string;
  recordedAt: number;
}

interface UpdateCommandGuardState {
  version: 1;
  processed: ProcessedUpdateCommand[];
}

export type UpdateCommandGuardResult =
  | { allowed: true; reason: "accepted" | "missing_id" }
  | { allowed: false; reason: "duplicate_id" | "state_write_failed" };

export interface AcquireUpdateCommandGuardOptions {
  filePath?: string;
  commandId?: string;
  now?: number;
  maxEntries?: number;
  warn?: (message: string) => void;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

/** 从飞书事件信封中读取重投时保持不变的 event_id。 */
export function extractFeishuEventId(data: unknown): string | undefined {
  const envelope = asRecord(data);
  const event = asRecord(envelope?.event);
  const header = asRecord(envelope?.header) ?? asRecord(event?.header);
  const context = asRecord(event?.context);
  const candidates = [header?.event_id, envelope?.event_id, event?.event_id, context?.event_id];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

/** 分隔文字消息和卡片回调 ID 的命名空间。 */
export function buildUpdateCommandId(
  source: "message" | "card",
  id: string | undefined,
): string | undefined {
  const normalized = id?.trim();
  return normalized ? `${source}:${normalized}` : undefined;
}

function emptyState(): UpdateCommandGuardState {
  return { version: UPDATE_COMMAND_GUARD_VERSION, processed: [] };
}

function parseState(raw: string, maxEntries: number): UpdateCommandGuardState {
  const parsed = JSON.parse(raw) as Partial<UpdateCommandGuardState>;
  if (parsed.version !== UPDATE_COMMAND_GUARD_VERSION || !Array.isArray(parsed.processed)) {
    throw new Error("invalid update command guard schema");
  }

  const processed = parsed.processed.map((entry) => {
    if (
      typeof entry !== "object"
      || entry === null
      || typeof entry.id !== "string"
      || entry.id.length === 0
      || typeof entry.recordedAt !== "number"
      || !Number.isFinite(entry.recordedAt)
      || entry.recordedAt < 0
    ) {
      throw new Error("invalid processed update command entry");
    }
    return { id: entry.id, recordedAt: entry.recordedAt };
  });

  return {
    version: UPDATE_COMMAND_GUARD_VERSION,
    processed: processed.slice(-maxEntries),
  };
}

function loadState(
  filePath: string,
  maxEntries: number,
  warn: (message: string) => void,
): UpdateCommandGuardState {
  if (!existsSync(filePath)) return emptyState();
  try {
    return parseState(readFileSync(filePath, "utf8"), maxEntries);
  } catch (err) {
    warn(`[UPDATE-GUARD] 状态文件损坏，将重建 ${filePath}: ${(err as Error).message}`);
    return emptyState();
  }
}

/**
 * 原子写入更新命令 ID。写失败时调用方必须拒绝更新：只有先落盘，
 * 新进程才能识别飞书在旧进程退出后重投的同一条 `/update`。
 */
function persistState(filePath: string, state: UpdateCommandGuardState): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    renameSync(tempPath, filePath);
  } catch (err) {
    try { rmSync(tempPath, { force: true }); } catch {}
    throw err;
  }
}

/**
 * 获取 `/update` 执行资格。只比较稳定消息/事件 ID，因此用户主动发送的
 * 不同 `/update` 消息仍可立即执行。
 */
export function acquireUpdateCommandGuard(
  options: AcquireUpdateCommandGuardOptions = {},
): UpdateCommandGuardResult {
  const filePath = options.filePath ?? UPDATE_COMMAND_GUARD_FILE;
  const commandId = options.commandId?.trim() || undefined;
  const now = options.now ?? Date.now();
  const maxEntries = Number.isInteger(options.maxEntries) && (options.maxEntries ?? 0) > 0
    ? options.maxEntries!
    : DEFAULT_MAX_PROCESSED_IDS;
  const warn = options.warn ?? ((message: string) => console.warn(message));

  // 模拟注入等没有稳定事件 ID 的入口无法做跨重启判断，保持原有行为。
  if (!commandId) return { allowed: true, reason: "missing_id" };

  const state = loadState(filePath, maxEntries, warn);
  if (state.processed.some((entry) => entry.id === commandId)) {
    return { allowed: false, reason: "duplicate_id" };
  }

  state.processed.push({ id: commandId, recordedAt: now });
  state.processed = state.processed.slice(-maxEntries);
  try {
    persistState(filePath, state);
  } catch (err) {
    warn(`[UPDATE-GUARD] 无法写入状态文件 ${filePath}: ${(err as Error).message}`);
    return { allowed: false, reason: "state_write_failed" };
  }
  return { allowed: true, reason: "accepted" };
}
