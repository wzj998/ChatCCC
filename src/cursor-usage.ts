import { createDecipheriv } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);

const CURSOR_USAGE_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
const CURSOR_SAFE_STORAGE_PREFIX = "cursor-safe-storage:v1:";
export const DEFAULT_CURSOR_ON_DEMAND_MONTHLY_BUDGET = 500;

export type CursorAvatarBatteryMode = "apiPercent" | "onDemandUse";
export type CursorAccountKind = "team" | "personal" | "unknown";

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
    pooledLimit?: number | string;
    pooledUsed?: number | string;
    pooledRemaining?: number | string;
    individualLimit?: number | string;
    individualUsed?: number | string;
    individualRemaining?: number | string;
    limitType?: string;
  };
  displayThreshold?: number;
  enabled?: boolean;
  displayMessage?: string;
  autoModelSelectedDisplayMessage?: string;
  namedModelSelectedDisplayMessage?: string;
  autoBucketModels?: string[];
};

export type CursorUsageReport = {
  accountKind: "team" | "personal";
  current: CursorUsageSummary;
  team: CursorUsageSummary | null;
};

export type CursorAvatarMeters = {
  battery: number | null;
  ring: number | null;
};

type SqliteStatement = {
  get(value?: unknown): unknown;
  all(value?: unknown): unknown[];
};

type SqliteDatabase = {
  prepare(sql: string): SqliteStatement;
  close(): void;
};

let cachedWindowsAesKey: Buffer | null = null;

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

function readStorageValue(dbPath: string, key: string): unknown {
  if (!existsSync(dbPath)) return undefined;
  const db = openSqliteDatabase(dbPath);
  try {
    const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(key) as { value?: unknown } | undefined;
    return row?.value;
  } finally {
    db.close();
  }
}

export function parseCursorTeamId(value: unknown): number | null {
  const parsed = parseStorageValue(value);
  if (!parsed || typeof parsed !== "object") return null;
  const teamId = Number((parsed as { teamId?: unknown }).teamId);
  return Number.isInteger(teamId) && teamId > 0 ? teamId : null;
}

export function readCursorTeamId(dbPath = getCursorDbPath()): number | null {
  try {
    return parseCursorTeamId(readStorageValue(dbPath, "cursorAuth/cachedTeam"));
  } catch {
    return null;
  }
}

export function readCursorAccountKind(dbPath = getCursorDbPath()): CursorAccountKind {
  if (!existsSync(dbPath)) return "unknown";
  return readCursorTeamId(dbPath) === null ? "personal" : "team";
}

function unprotectDpapi(bytes: Buffer): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "chatccc-cursor-"));
  const inputPath = join(dir, "in.bin");
  const outputPath = join(dir, "out.bin");
  const scriptPath = join(dir, "unprotect.ps1");
  writeFileSync(inputPath, bytes);
  writeFileSync(scriptPath, `
Add-Type -AssemblyName System.Security
$bytes = [IO.File]::ReadAllBytes('${inputPath.replace(/'/g, "''")}')
$plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[IO.File]::WriteAllBytes('${outputPath.replace(/'/g, "''")}', $plain)
`, "utf8");
  try {
    const result = spawnSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-File", scriptPath],
      { encoding: "utf8", windowsHide: true },
    );
    if (result.status !== 0 || !existsSync(outputPath)) {
      const detail = (result.stderr || result.stdout || "DPAPI decrypt failed").trim().slice(0, 200);
      throw new Error(`Cursor token decryption failed: ${detail}`);
    }
    return readFileSync(outputPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function loadWindowsCursorAesKey(): Buffer {
  if (cachedWindowsAesKey) return cachedWindowsAesKey;
  const localStatePath = join(process.env.APPDATA || "", "Cursor", "Local State");
  if (!existsSync(localStatePath)) {
    throw new Error(`Cursor Local State not found: ${localStatePath}`);
  }
  const localState = JSON.parse(readFileSync(localStatePath, "utf8").replace(/^\uFEFF/, "")) as {
    os_crypt?: { encrypted_key?: string };
  };
  const encodedKey = localState.os_crypt?.encrypted_key;
  if (!encodedKey) throw new Error("Cursor Local State is missing os_crypt.encrypted_key");
  let encryptedKey = Buffer.from(encodedKey, "base64");
  if (encryptedKey.subarray(0, 5).toString("utf8") === "DPAPI") encryptedKey = encryptedKey.subarray(5);
  const key = unprotectDpapi(encryptedKey).subarray(0, 32);
  if (key.length !== 32) throw new Error("Cursor token key has an unexpected length");
  cachedWindowsAesKey = key;
  return key;
}

export function decryptCursorSafeStorageValue(stored: string, aesKey: Buffer): string {
  if (!stored.startsWith(CURSOR_SAFE_STORAGE_PREFIX)) return stored;
  const blob = Buffer.from(stored.slice(CURSOR_SAFE_STORAGE_PREFIX.length), "base64");
  if (blob.length < 3 + 12 + 16 || blob.subarray(0, 3).toString("utf8") !== "v10") {
    throw new Error("Unsupported Cursor token encryption");
  }
  const decipher = createDecipheriv("aes-256-gcm", aesKey.subarray(0, 32), blob.subarray(3, 15));
  decipher.setAuthTag(blob.subarray(blob.length - 16));
  return Buffer.concat([decipher.update(blob.subarray(15, blob.length - 16)), decipher.final()]).toString("utf8");
}

export function resolveCursorAccessToken(stored: string, platform = process.platform): string {
  if (!stored.startsWith(CURSOR_SAFE_STORAGE_PREFIX)) return stored;
  if (platform !== "win32") {
    throw new Error("Cursor access token is encrypted; decryption is only implemented on Windows");
  }
  return decryptCursorSafeStorageValue(stored, loadWindowsCursorAesKey());
}

function readCursorAccessToken(dbPath = getCursorDbPath()): string {
  const token = parseStorageValue(readStorageValue(dbPath, "cursorAuth/accessToken"));
  if (typeof token === "string" && token.length > 0) return token;
  if (!existsSync(dbPath)) throw new Error(`Cursor database not found: ${dbPath}`);
  throw new Error("Cursor access token not found");
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function cursorOnDemandRemainingPercent(usedCents: number, budgetDollars: number): number {
  const budget = budgetDollars > 0 ? budgetDollars : DEFAULT_CURSOR_ON_DEMAND_MONTHLY_BUDGET;
  return clampPercent(100 - ((usedCents / 100) / budget) * 100);
}

export function asCursorUsageReport(value: CursorUsageSummary | CursorUsageReport | null | undefined): CursorUsageReport | null {
  if (!value || typeof value !== "object") return null;
  if ("accountKind" in value && "current" in value && (value.accountKind === "team" || value.accountKind === "personal")) {
    return value;
  }
  return { accountKind: "personal", current: value as CursorUsageSummary, team: null };
}

export function cursorAvatarMeters(
  usage: CursorUsageSummary | CursorUsageReport | null | undefined,
  options: { mode: CursorAvatarBatteryMode; budget: number },
): CursorAvatarMeters {
  const report = asCursorUsageReport(usage);
  if (!report) throw new Error("missing cursor usage");
  const budget = options.budget > 0 ? options.budget : DEFAULT_CURSOR_ON_DEMAND_MONTHLY_BUDGET;

  if (report.accountKind === "team") {
    const weeklyUsed = finiteNumber(report.current.planUsage?.totalPercentUsed);
    const usedCents = finiteNumber(report.team?.spendLimitUsage?.individualUsed);
    const ring = weeklyUsed === null ? null : clampPercent(100 - weeklyUsed);
    const battery = usedCents === null ? null : cursorOnDemandRemainingPercent(usedCents, budget);
    if (ring === null && battery === null) throw new Error("missing team cursor usage");
    return { battery, ring };
  }

  if (options.mode === "onDemandUse") {
    const usedCents = finiteNumber(report.current.spendLimitUsage?.individualUsed);
    if (usedCents === null) throw new Error("missing spendLimitUsage.individualUsed");
    return { battery: cursorOnDemandRemainingPercent(usedCents, budget), ring: null };
  }

  const apiUsed = finiteNumber(report.current.planUsage?.apiPercentUsed);
  const totalUsed = finiteNumber(report.current.planUsage?.totalPercentUsed);
  const used = apiUsed ?? totalUsed;
  if (used === null) throw new Error("missing planUsage.apiPercentUsed");
  return { battery: clampPercent(100 - used), ring: null };
}

async function fetchCurrentPeriodUsage(token: string, body: Record<string, unknown>): Promise<CursorUsageSummary> {
  const response = await fetch(CURSOR_USAGE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Cursor usage API returned ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as CursorUsageSummary;
}

export async function getCursorUsageSummary(): Promise<CursorUsageReport> {
  const token = resolveCursorAccessToken(readCursorAccessToken());
  const teamId = readCursorTeamId();
  const current = await fetchCurrentPeriodUsage(token, {});
  if (teamId === null) return { accountKind: "personal", current, team: null };
  const team = await fetchCurrentPeriodUsage(token, { teamId, includePooledUsage: true });
  return { accountKind: "team", current, team };
}
