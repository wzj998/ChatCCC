import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SafeMaintenanceCoordinator,
  type SafeMaintenanceSnapshot,
} from "../safe-maintenance.ts";

const idle = (): SafeMaintenanceSnapshot => ({
  activeSessionIds: [], queuedSessionIds: [], activeEngineIds: [], activeWorkLabels: [],
});

describe("safe maintenance coordinator", () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "chatccc-safe-maintenance-"));
    roots.push(root);
    const filePath = join(root, "state.json");
    let now = Date.UTC(2026, 7, 17);
    let snapshot = idle();
    const execute = vi.fn(async () => true);
    const notify = vi.fn(async () => {});
    let id = 0;
    const coordinator = new SafeMaintenanceCoordinator({
      filePath,
      now: () => new Date(now),
      idFactory: () => `id-${++id}`,
      stableIdleMs: 1_000,
      autoPoll: false,
    });
    coordinator.configure({ getSnapshot: async () => snapshot, execute, notify });
    return {
      coordinator, filePath, execute, notify,
      setSnapshot(value: SafeMaintenanceSnapshot) { snapshot = value; },
      advance(ms: number) { now += ms; },
    };
  }

  it("closes admission, persists the request, and waits for work plus a stable idle window", async () => {
    const f = await fixture();
    const release = f.coordinator.beginTrackedWork("incoming-message");
    f.setSnapshot({ ...idle(), activeSessionIds: ["session-1"], queuedSessionIds: ["session-1"] });
    await f.coordinator.schedule("restart", { platform: "feishu", chatId: "oc_1", openId: "ou_1" });

    expect(f.coordinator.isAdmissionClosed()).toBe(true);
    expect(JSON.parse(await readFile(f.filePath, "utf8"))).toMatchObject({ kind: "restart", phase: "draining" });
    await f.coordinator.tick();
    expect(f.execute).not.toHaveBeenCalled();

    release();
    f.setSnapshot(idle());
    await f.coordinator.tick();
    f.advance(999);
    await f.coordinator.tick();
    expect(f.execute).not.toHaveBeenCalled();
    f.advance(1);
    await f.coordinator.tick();
    expect(f.execute).toHaveBeenCalledWith("restart");
    expect((await f.coordinator.status()).job?.phase).toBe("executing");
  });

  it("coalesces requests and lets update supersede restart", async () => {
    const f = await fixture();
    await f.coordinator.schedule("restart", { platform: "feishu", chatId: "oc_1", openId: "ou_1" });
    const merged = await f.coordinator.schedule("update", { platform: "wechat", chatId: "wx_1", openId: "wx_user" });
    expect(merged.kind).toBe("update");
    expect(merged.requesters).toHaveLength(2);
  });

  it("cancels only while draining and reopens admission", async () => {
    const f = await fixture();
    await f.coordinator.schedule("restart", { platform: "feishu", chatId: "oc_1", openId: "ou_1" });
    expect(await f.coordinator.cancel()).toBe(true);
    expect(f.coordinator.isAdmissionClosed()).toBe(false);
    expect((await f.coordinator.status()).job).toBeNull();
  });

  it("does not close admission when the durable request cannot be written", async () => {
    const root = await mkdtemp(join(tmpdir(), "chatccc-safe-maintenance-blocked-"));
    roots.push(root);
    const blocker = join(root, "blocker");
    await writeFile(blocker, "not a directory", "utf8");
    const coordinator = new SafeMaintenanceCoordinator({ filePath: join(blocker, "state.json"), autoPoll: false });
    coordinator.configure({ getSnapshot: async () => idle(), execute: async () => true, notify: async () => {} });

    await expect(coordinator.schedule("restart", { platform: "feishu", chatId: "oc_1", openId: "ou_1" })).rejects.toBeTruthy();
    expect(coordinator.isAdmissionClosed()).toBe(false);
  });

  it("marks an executing job completed only after an internal replacement starts", async () => {
    const f = await fixture();
    await f.coordinator.schedule("update", { platform: "feishu", chatId: "oc_1", openId: "ou_1" });
    await f.coordinator.tick();
    f.advance(1_000);
    await f.coordinator.tick();

    const replacement = new SafeMaintenanceCoordinator({ filePath: f.filePath, autoPoll: false });
    replacement.configure({ getSnapshot: async () => idle(), execute: async () => true, notify: f.notify });
    await replacement.recoverAfterStartup(true);
    expect((await replacement.status()).job?.phase).toBe("completed");
    expect(replacement.isAdmissionClosed()).toBe(false);
    expect(f.notify).toHaveBeenCalledWith(expect.objectContaining({ chatId: "oc_1" }), "ChatCCC 已安全更新并重新启动。");
  });
});
