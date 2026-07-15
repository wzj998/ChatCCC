import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acquireUpdateCommandGuard,
  buildUpdateCommandId,
  extractFeishuEventId,
} from "../update-command-guard.ts";

describe("Feishu update command IDs", () => {
  it("extracts and namespaces a card callback event_id", () => {
    const eventId = extractFeishuEventId({
      schema: "2.0",
      header: { event_id: "evt_update_001" },
      event: { action: { value: { action: "update" } } },
    });

    expect(buildUpdateCommandId("card", eventId)).toBe("card:evt_update_001");
    expect(buildUpdateCommandId("message", "om_update_001")).toBe("message:om_update_001");
  });
});

describe("acquireUpdateCommandGuard", () => {
  let tempDir: string;
  let guardFile: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "chatccc-update-guard-"));
    guardFile = join(tempDir, "state", "update-command-guard.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("persists an accepted update ID before returning", async () => {
    const result = acquireUpdateCommandGuard({
      filePath: guardFile,
      commandId: "message:om_update_001",
      now: 1_000,
    });

    expect(result).toEqual({ allowed: true, reason: "accepted" });
    const saved = JSON.parse(await readFile(guardFile, "utf8"));
    expect(saved).toEqual({
      version: 1,
      processed: [{ id: "message:om_update_001", recordedAt: 1_000 }],
    });
  });

  it("rejects the same ID after a simulated process restart", () => {
    expect(acquireUpdateCommandGuard({
      filePath: guardFile,
      commandId: "message:om_update_001",
      now: 1_000,
    }).allowed).toBe(true);

    // 第二次调用不共享任何内存状态，只通过落盘文件模拟新进程重启后的判断。
    expect(acquireUpdateCommandGuard({
      filePath: guardFile,
      commandId: "message:om_update_001",
      now: 9_999_999,
    })).toEqual({ allowed: false, reason: "duplicate_id" });
  });

  it("accepts different IDs immediately without a cooldown", () => {
    expect(acquireUpdateCommandGuard({
      filePath: guardFile,
      commandId: "message:om_update_001",
      now: 1_000,
    }).allowed).toBe(true);

    expect(acquireUpdateCommandGuard({
      filePath: guardFile,
      commandId: "message:om_update_002",
      now: 1_001,
    })).toEqual({ allowed: true, reason: "accepted" });
  });

  it("repairs a corrupt state file and warns without creating an update loop", async () => {
    await mkdir(join(tempDir, "state"), { recursive: true });
    await writeFile(guardFile, "not-json", "utf8");
    const warn = vi.fn();

    expect(acquireUpdateCommandGuard({
      filePath: guardFile,
      commandId: "message:om_update_001",
      now: 1_000,
      warn,
    })).toEqual({ allowed: true, reason: "accepted" });
    expect(warn).toHaveBeenCalledOnce();

    // 损坏文件已被有效状态覆盖，因此重启后的重复投递仍会被拦截。
    expect(acquireUpdateCommandGuard({
      filePath: guardFile,
      commandId: "message:om_update_001",
      now: 2_000,
      warn,
    })).toEqual({ allowed: false, reason: "duplicate_id" });
  });

  it("fails closed when the accepted ID cannot be persisted", async () => {
    const blocker = join(tempDir, "not-a-directory");
    await writeFile(blocker, "block", "utf8");
    const warn = vi.fn();

    expect(acquireUpdateCommandGuard({
      filePath: join(blocker, "update-command-guard.json"),
      commandId: "message:om_update_001",
      now: 1_000,
      warn,
    })).toEqual({ allowed: false, reason: "state_write_failed" });
    expect(warn).toHaveBeenCalledOnce();
  });

  it("allows sources without a stable ID without writing a misleading record", async () => {
    expect(acquireUpdateCommandGuard({
      filePath: guardFile,
      commandId: undefined,
      now: 1_000,
    })).toEqual({ allowed: true, reason: "missing_id" });
    await expect(readFile(guardFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps only the newest configured number of update IDs", async () => {
    for (let i = 0; i < 4; i++) {
      expect(acquireUpdateCommandGuard({
        filePath: guardFile,
        commandId: `message:om_update_${i}`,
        now: i,
        maxEntries: 3,
      }).allowed).toBe(true);
    }

    const saved = JSON.parse(await readFile(guardFile, "utf8"));
    expect(saved.processed.map((entry: { id: string }) => entry.id)).toEqual([
      "message:om_update_1",
      "message:om_update_2",
      "message:om_update_3",
    ]);
  });
});
