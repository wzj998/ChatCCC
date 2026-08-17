import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { handleCommand } from "../orchestrator.ts";
import type { PlatformAdapter } from "../platform-adapter.ts";
import {
  SafeMaintenanceCoordinator,
  _resetSafeMaintenanceCoordinatorForTest,
  _setSafeMaintenanceCoordinatorForTest,
} from "../safe-maintenance.ts";
import { EngineManager } from "../engines/engine-manager.ts";

function platform(): PlatformAdapter {
  return {
    kind: "wechat",
    sendText: vi.fn(async () => true),
    sendCard: vi.fn(async () => true),
    sendRawCard: vi.fn(async () => true),
    createGroup: vi.fn(async () => "group"),
    updateChatInfo: vi.fn(async () => {}),
    getChatInfo: vi.fn(async () => ({ name: "chat", description: "" })),
    disbandChat: vi.fn(async () => {}),
    setChatAvatar: vi.fn(async () => {}),
    extractSessionInfo: vi.fn(() => null),
    cardCreate: vi.fn(async () => "card"),
    cardSend: vi.fn(async () => "message"),
    cardUpdate: vi.fn(async () => {}),
  };
}

describe("safe maintenance commands", () => {
  const roots: string[] = [];
  afterEach(async () => {
    _resetSafeMaintenanceCoordinatorForTest();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function coordinator() {
    const root = await mkdtemp(join(tmpdir(), "chatccc-safe-command-"));
    roots.push(root);
    const instance = new SafeMaintenanceCoordinator({ filePath: join(root, "state.json"), autoPoll: false });
    instance.configure({
      getSnapshot: async () => ({
        activeSessionIds: ["existing-session"],
        queuedSessionIds: [],
        activeEngineIds: [],
        activeWorkLabels: [],
      }),
      execute: async () => true,
      notify: async () => {},
    });
    _setSafeMaintenanceCoordinatorForTest(instance);
    return instance;
  }

  it("schedules /restart safe and rejects new ordinary work", async () => {
    const instance = await coordinator();
    const adapter = platform();
    await handleCommand(adapter, "/restart safe", "wx-chat", "wx-user", Date.now(), "group");
    expect((await instance.status()).job).toMatchObject({ kind: "restart", phase: "draining" });
    expect(adapter.sendText).toHaveBeenCalledWith("wx-chat", expect.stringContaining("已预约安全重启"));

    await handleCommand(adapter, "开始一个新任务", "wx-chat", "wx-user", Date.now() + 1, "group");
    expect(adapter.sendText).toHaveBeenCalledWith("wx-chat", expect.stringContaining("当前不接受新的任务"));
  });

  it("reports and cancels a draining maintenance request", async () => {
    const instance = await coordinator();
    const adapter = platform();
    await instance.schedule("restart", { platform: "wechat", chatId: "wx-chat", openId: "wx-user" });

    await handleCommand(adapter, "/safestatus", "wx-chat", "wx-user", Date.now(), "group");
    expect(adapter.sendText).toHaveBeenCalledWith("wx-chat", expect.stringContaining("等待现有任务结束"));
    await handleCommand(adapter, "/cancelsf", "wx-chat", "wx-user", Date.now() + 1, "group");
    expect(instance.isAdmissionClosed()).toBe(false);
  });

  it("lets work accepted before the gate drain, while blocking new dependency installs", async () => {
    const instance = await coordinator();
    const adapter = platform();
    await instance.schedule("restart", { platform: "wechat", chatId: "wx-chat", openId: "wx-user" });

    await handleCommand(adapter, "已缓存的旧消息", "wx-chat", "wx-user", Date.now(), "group", undefined, undefined, true);
    expect(adapter.sendText).not.toHaveBeenCalledWith("wx-chat", expect.stringContaining("当前不接受新的任务"));

    const manager = new EngineManager({
      rootDir: join(roots[0], "engines"),
      specs: [{
        id: "test",
        label: "Test Engine",
        version: "1.0.0",
        packages: {},
        entryRelativePath: "index.js",
        expectedBytes: 1,
        minimumNodeVersion: "20.0.0",
      }],
    });
    await expect(manager.startInstall("test")).rejects.toThrow("正在等待安全维护");
  });
});
