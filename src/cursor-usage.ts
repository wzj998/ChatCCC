import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);

const CURSOR_USAGE_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";

export type CursorUsageSummary = {
  billingCycleStart?: string;
  billingCycleEnd?: string;
  planUsage?: {
    totalSpend?: number;
    includedSpend?: number;
    bonusSpend?: number;
    limit?: number;
    remainingBonus?: boolean;
    bonusTooltip?: string;
    autoPercentUsed?: number;
    apiPercentUsed?: number;
    totalPercentUsed?: number;
  };
  spendLimitUsage?: {
    totalSpend?: number;
    pooledLimit?: number;
    pooledUsed?: number;
    pooledRemaining?: number;
    individualUsed?: number;
    limitType?: string;
  };
  displayThreshold?: number;
  enabled?: boolean;
  displayMessage?: string;
  autoModelSelectedDisplayMessage?: string;
  namedModelSelectedDisplayMessage?: string;
  autoBucketModels?: string[];
};

type SqliteStatement = {
  get(value?: unknown): unknown;
  all(value?: unknown): unknown[];
};

type SqliteDatabase = {
  prepare(sql: string): SqliteStatement;
  close(): void;
};

function getCursorDbPath(): string {
  if (process.platform === "win32") {
    return join(process.env.APPDATA || "", "Cursor", "User", "globalStorage", "state.vscdb");
  }

  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
  }

  return join(homedir(), ".config", "Cursor", "User", "globalStorage", "state.vscdb");
}

function openSqliteDatabase(dbPath: string): SqliteDatabase {
  try {
    const { DatabaseSync } = require("node:sqlite") as {
      DatabaseSync?: new (path: string, opts: { readOnly: boolean }) => SqliteDatabase;
    };
    if (DatabaseSync) return new DatabaseSync(dbPath, { readOnly: true });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== "ERR_UNKNOWN_BUILTIN_MODULE" && code !== "MODULE_NOT_FOUND") {
      throw error;
    }
  }

  try {
    const Database = require("better-sqlite3") as new (path: string, opts: { readonly: boolean }) => SqliteDatabase;
    return new Database(dbPath, { readonly: true });
  } catch {
    throw new Error("node:sqlite is unavailable and better-sqlite3 is not installed");
  }
}

function parseStorageValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function getCursorAccessToken(dbPath = getCursorDbPath()): string {
  if (!existsSync(dbPath)) {
    throw new Error(`Cursor database not found: ${dbPath}`);
  }

  const db = openSqliteDatabase(dbPath);

  try {
    const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get("cursorAuth/accessToken") as
      | { value?: unknown }
      | undefined;
    const token = parseStorageValue(row?.value);
    if (typeof token === "string" && token.length > 0) return token;
    throw new Error("Cursor access token not found");
  } finally {
    db.close();
  }
}

export async function getCursorUsageSummary(): Promise<CursorUsageSummary> {
  const token = getCursorAccessToken();
  const response = await fetch(CURSOR_USAGE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
    },
    body: "{}",
  });

  if (!response.ok) {
    throw new Error(`Cursor usage API returned ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as CursorUsageSummary;
}
