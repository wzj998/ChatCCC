import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

import {
  asCursorUsageReport,
  cursorAvatarMeters,
  cursorOnDemandRemainingPercent,
  decryptCursorSafeStorageValue,
  parseCursorTeamId,
  readCursorTeamId,
  resolveCursorAccessToken,
} from "../cursor-usage.ts";

const require = createRequire(import.meta.url);
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function encryptV10(plain: string, key: Buffer): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `cursor-safe-storage:v1:${Buffer.concat([Buffer.from("v10"), nonce, ciphertext, cipher.getAuthTag()]).toString("base64")}`;
}

describe("Cursor token decryption", () => {
  it("returns a plaintext token unchanged", () => {
    expect(resolveCursorAccessToken("plain-token", "linux")).toBe("plain-token");
  });

  it("decrypts a Windows v10 safe-storage blob with the supplied key", () => {
    const key = randomBytes(32);
    const stored = encryptV10("eyJ.test.token", key);
    expect(decryptCursorSafeStorageValue(stored, key)).toBe("eyJ.test.token");
  });

  it("refuses an encrypted token on non-Windows platforms", () => {
    expect(() => resolveCursorAccessToken("cursor-safe-storage:v1:aaaa", "linux")).toThrow(/only implemented on Windows/);
  });
});

describe("Cursor team id", () => {
  it("reads a positive team id from the cached team record", () => {
    expect(parseCursorTeamId(JSON.stringify({ teamId: 17454673, name: "Example" }))).toBe(17454673);
    expect(parseCursorTeamId({ teamId: 0 })).toBeNull();
    expect(parseCursorTeamId("not-json")).toBeNull();
  });

  it("reads the team id from a Cursor state database", () => {
    let DatabaseSync: new (path: string) => { exec(sql: string): void; prepare(sql: string): { run(...args: unknown[]): void }; close(): void };
    try {
      DatabaseSync = require("node:sqlite").DatabaseSync;
    } catch {
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "chatccc-cursor-db-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "state.vscdb");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE ItemTable (key TEXT, value TEXT)");
    db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
      "cursorAuth/cachedTeam",
      JSON.stringify({ teamId: 42, name: "Team" }),
    );
    db.close();
    expect(readCursorTeamId(dbPath)).toBe(42);
  });
});

describe("Cursor avatar meters", () => {
  it("keeps personal API percentage and falls back to total percentage", () => {
    expect(cursorAvatarMeters({ planUsage: { apiPercentUsed: 40 } }, { mode: "apiPercent", budget: 500 }).battery).toBe(60);
    expect(cursorAvatarMeters({ planUsage: { totalPercentUsed: 25 } }, { mode: "apiPercent", budget: 500 })).toEqual({
      battery: 75,
      ring: null,
    });
  });

  it("uses the configured On demand budget for personal accounts", () => {
    expect(cursorOnDemandRemainingPercent(25000, 500)).toBe(50);
    expect(cursorAvatarMeters(
      { spendLimitUsage: { individualUsed: 25000 } },
      { mode: "onDemandUse", budget: 500 },
    )).toEqual({ battery: 50, ring: null });
  });

  it("uses weekly included remaining for the team ring and team On demand for the battery", () => {
    const report = {
      accountKind: "team" as const,
      current: { planUsage: { totalPercentUsed: 20 } },
      team: { spendLimitUsage: { individualUsed: 25000 } },
    };
    expect(asCursorUsageReport(report)?.accountKind).toBe("team");
    expect(cursorAvatarMeters(report, { mode: "apiPercent", budget: 500 })).toEqual({
      battery: 50,
      ring: 80,
    });
  });
});
