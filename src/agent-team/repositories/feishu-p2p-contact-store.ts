import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface FeishuP2pContact {
  openId: string;
  chatId: string;
  receivedAt: string;
}

export interface FeishuP2pContactStoreOptions {
  filePath?: string;
}

export class FeishuP2pContactStore {
  readonly filePath: string;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(options: FeishuP2pContactStoreOptions = {}) {
    this.filePath = options.filePath ?? join(homedir(), ".chatccc", "state", "last-feishu-p2p-contact.json");
  }

  async get(): Promise<FeishuP2pContact | null> {
    try {
      return parseContact(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      if (err instanceof InvalidFeishuOpenIdError) return null;
      throw err;
    }
  }

  async record(contact: FeishuP2pContact): Promise<void> {
    const parsed = parseContact(contact);
    await this.exclusive(async () => {
      await writeJsonAtomic(this.filePath, parsed);
    });
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release!: () => void;
    this.operationQueue = new Promise<void>((resolveQueue) => { release = resolveQueue; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function parseContact(value: unknown): FeishuP2pContact {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Feishu P2P contact");
  const contact = value as Partial<FeishuP2pContact>;
  if (!isValidFeishuOpenId(contact.openId)) throw new InvalidFeishuOpenIdError(String(contact.openId));
  if (typeof contact.chatId !== "string" || !contact.chatId) throw new Error("Feishu P2P contact is missing chatId");
  if (typeof contact.receivedAt !== "string" || !contact.receivedAt) throw new Error("Feishu P2P contact is missing receivedAt");
  return { openId: contact.openId, chatId: contact.chatId, receivedAt: contact.receivedAt };
}

export function isValidFeishuOpenId(value: unknown): value is string {
  return typeof value === "string" && /^ou_[A-Za-z0-9]+$/.test(value);
}

class InvalidFeishuOpenIdError extends Error {
  constructor(value: string) {
    super(`Invalid Feishu openId: ${value}`);
    this.name = "InvalidFeishuOpenIdError";
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await rename(tempPath, path);
  } catch (err) {
    await unlink(tempPath).catch(() => {});
    throw err;
  }
}

export const feishuP2pContactStore = new FeishuP2pContactStore();
