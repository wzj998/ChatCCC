import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";

export const MAX_PROCESSED = 5000;

export type FeishuMessageDisposition = "accepted" | "duplicate" | "stale";

export interface FeishuMessageIdentity {
  messageId?: string;
  chatId: string;
  createTime: number;
}

interface PersistedMessageEntry {
  messageId: string;
  chatId: string;
  createTime: number;
}

interface PersistedMessageLedger {
  version: 1;
  entries: PersistedMessageEntry[];
}

type ScheduleTask = (task: () => void) => void;

const defaultSchedule: ScheduleTask = (task) => {
  setImmediate(task);
};

/**
 * The Feishu SDK waits for an event handler's return value before sending its
 * WebSocket response. Schedule the real work for the next event-loop turn so
 * the SDK callback can return and acknowledge the event immediately.
 */
export function createAckFirstEventHandler<T>(
  worker: (data: T) => Promise<void>,
  onError: (error: unknown) => void,
  schedule: ScheduleTask = defaultSchedule,
): (data: T) => Promise<void> {
  return async (data) => {
    schedule(() => {
      void worker(data).catch(onError);
    });
  };
}

function isPersistedEntry(value: unknown): value is PersistedMessageEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.messageId === "string"
    && entry.messageId.length > 0
    && typeof entry.chatId === "string"
    && typeof entry.createTime === "number"
    && Number.isFinite(entry.createTime);
}

export class FeishuMessageLedger {
  private readonly messageIds: Set<string>;
  private entries: PersistedMessageEntry[] = [];
  private latestCreateTimeByChat = new Map<string, number>();
  private persistTail: Promise<void> = Promise.resolve();

  constructor(
    public readonly filePath: string,
    private readonly maxEntries = MAX_PROCESSED,
    messageIds?: Set<string>,
  ) {
    this.messageIds = messageIds ?? new Set<string>();
  }

  async load(): Promise<void> {
    this.clearMemory();

    try {
      const raw = await readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<PersistedMessageLedger>;
      const entries = Array.isArray(parsed.entries)
        ? parsed.entries.filter(isPersistedEntry)
        : [];
      this.entries = entries.slice(-this.maxEntries);
      this.rebuildIndexes();

      if (entries.length > this.maxEntries) {
        await this.persist();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(
          `[FEISHU-DEDUP] Failed to load ${this.filePath}: ${(error as Error).message}`,
        );
      }
    }
  }

  async accept(identity: FeishuMessageIdentity): Promise<FeishuMessageDisposition> {
    const { messageId, chatId, createTime } = identity;

    if (messageId && this.messageIds.has(messageId)) {
      return "duplicate";
    }

    const latestCreateTime = this.latestCreateTimeByChat.get(chatId);
    if (latestCreateTime !== undefined && createTime < latestCreateTime) {
      return "stale";
    }

    if (!messageId) {
      this.recordLatestCreateTime(chatId, createTime);
      return "accepted";
    }

    this.entries.push({ messageId, chatId, createTime });
    this.messageIds.add(messageId);
    this.recordLatestCreateTime(chatId, createTime);

    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
      this.rebuildIndexes();
    }

    try {
      await this.persist();
    } catch (error) {
      console.error(
        `[FEISHU-DEDUP] Failed to persist ${this.filePath}: ${(error as Error).message}`,
      );
    }
    return "accepted";
  }

  clearMemory(): void {
    this.entries = [];
    this.messageIds.clear();
    this.latestCreateTimeByChat.clear();
    this.persistTail = Promise.resolve();
  }

  private recordLatestCreateTime(chatId: string, createTime: number): void {
    const current = this.latestCreateTimeByChat.get(chatId);
    if (current === undefined || createTime > current) {
      this.latestCreateTimeByChat.set(chatId, createTime);
    }
  }

  private rebuildIndexes(): void {
    this.messageIds.clear();
    this.latestCreateTimeByChat.clear();
    for (const entry of this.entries) {
      this.messageIds.add(entry.messageId);
      this.recordLatestCreateTime(entry.chatId, entry.createTime);
    }
  }

  private persist(): Promise<void> {
    const snapshot: PersistedMessageLedger = {
      version: 1,
      entries: this.entries.map((entry) => ({ ...entry })),
    };

    const nextPersist = this.persistTail
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(this.filePath), { recursive: true });
        const tempPath = `${this.filePath}.${process.pid}.tmp`;
        try {
          await writeFile(tempPath, JSON.stringify(snapshot), "utf-8");
          await rename(tempPath, this.filePath);
        } finally {
          await rm(tempPath, { force: true }).catch(() => {});
        }
      });
    this.persistTail = nextPersist;
    return nextPersist;
  }
}

const defaultLedgerPath = join(
  homedir(),
  ".chatccc",
  "state",
  "feishu-message-ledger.json",
);

export const processedMessages = new Set<string>();
export const feishuMessageLedger = new FeishuMessageLedger(
  defaultLedgerPath,
  MAX_PROCESSED,
  processedMessages,
);

export function clearFeishuMessageLedgerMemory(): void {
  feishuMessageLedger.clearMemory();
}
