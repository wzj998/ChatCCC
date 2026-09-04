import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { USER_DATA_DIR } from "./config.ts";

export interface CachedCodexResetCredit {
  grantedAt: string | null;
  expiresAt: string;
}

export interface CodexResetCreditsSnapshot {
  availableCount: number;
  credits: CachedCodexResetCredit[];
  queriedAt: string;
  locallyAdjusted: boolean;
}

interface CodexResetCreditsCacheFile {
  version: 1;
  accounts: Record<string, CodexResetCreditsSnapshot>;
}

const CACHE_FILE = join(USER_DATA_DIR, "state", "codex-reset-credits.json");
let mutationQueue: Promise<void> = Promise.resolve();

export function codexResetCreditsAccountKey(accountId: string | undefined, accessToken: string): string {
  if (accountId?.trim()) return `account:${accountId.trim()}`;
  const digest = createHash("sha256").update(accessToken).digest("hex").slice(0, 24);
  return `token-sha256:${digest}`;
}

function emptyCache(): CodexResetCreditsCacheFile {
  return { version: 1, accounts: {} };
}

function normalizeSnapshot(raw: unknown): CodexResetCreditsSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<CodexResetCreditsSnapshot>;
  const availableCount = Number(value.availableCount);
  if (!Number.isFinite(availableCount) || typeof value.queriedAt !== "string" || !value.queriedAt.trim()) return null;
  const credits = Array.isArray(value.credits)
    ? value.credits.flatMap((credit) => {
      if (!credit || typeof credit !== "object") return [];
      const item = credit as Partial<CachedCodexResetCredit>;
      if (typeof item.expiresAt !== "string" || !item.expiresAt.trim()) return [];
      return [{
        grantedAt: typeof item.grantedAt === "string" && item.grantedAt.trim() ? item.grantedAt : null,
        expiresAt: item.expiresAt,
      }];
    })
    : [];
  return {
    availableCount: Math.max(0, Math.trunc(availableCount)),
    credits,
    queriedAt: value.queriedAt,
    locallyAdjusted: value.locallyAdjusted === true,
  };
}

async function readCache(): Promise<CodexResetCreditsCacheFile> {
  try {
    const parsed = JSON.parse(await readFile(CACHE_FILE, "utf-8")) as Partial<CodexResetCreditsCacheFile>;
    const accounts: Record<string, CodexResetCreditsSnapshot> = {};
    if (parsed.accounts && typeof parsed.accounts === "object") {
      for (const [key, raw] of Object.entries(parsed.accounts)) {
        const snapshot = normalizeSnapshot(raw);
        if (snapshot) accounts[key] = snapshot;
      }
    }
    return { version: 1, accounts };
  } catch {
    return emptyCache();
  }
}

async function writeCache(cache: CodexResetCreditsCacheFile): Promise<void> {
  await mkdir(dirname(CACHE_FILE), { recursive: true });
  const tempFile = `${CACHE_FILE}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempFile, JSON.stringify(cache, null, 2), "utf-8");
  try {
    await rename(tempFile, CACHE_FILE);
  } catch {
    await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
    await rm(tempFile, { force: true }).catch(() => {});
  }
}

async function mutateCache(mutate: (cache: CodexResetCreditsCacheFile) => void): Promise<void> {
  const operation = mutationQueue.then(async () => {
    const cache = await readCache();
    mutate(cache);
    await writeCache(cache);
  });
  mutationQueue = operation.catch(() => {});
  return operation;
}

export async function readCodexResetCreditsSnapshot(accountKey: string): Promise<CodexResetCreditsSnapshot | null> {
  return (await readCache()).accounts[accountKey] ?? null;
}

export async function saveCodexResetCreditsSnapshot(
  accountKey: string,
  snapshot: Omit<CodexResetCreditsSnapshot, "locallyAdjusted">,
): Promise<void> {
  await mutateCache((cache) => {
    cache.accounts[accountKey] = {
      ...snapshot,
      availableCount: Math.max(0, Math.trunc(snapshot.availableCount)),
      locallyAdjusted: false,
    };
  });
}

export async function decrementCachedCodexResetCredits(accountKey: string): Promise<void> {
  await mutateCache((cache) => {
    const current = cache.accounts[accountKey];
    if (!current) return;
    cache.accounts[accountKey] = {
      ...current,
      availableCount: Math.max(0, current.availableCount - 1),
      credits: current.credits.slice(1),
      locallyAdjusted: true,
    };
  });
}
