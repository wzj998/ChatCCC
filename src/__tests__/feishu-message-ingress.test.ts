import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FeishuMessageLedger,
  createAckFirstEventHandler,
} from "../feishu-message-ingress.ts";

const tempDirs: string[] = [];

async function createLedger(maxEntries = 5): Promise<FeishuMessageLedger> {
  const dir = await mkdtemp(join(tmpdir(), "chatccc-feishu-ingress-"));
  tempDirs.push(dir);
  return new FeishuMessageLedger(join(dir, "messages.json"), maxEntries);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("createAckFirstEventHandler", () => {
  it("returns before starting the asynchronous event worker", async () => {
    let scheduled: (() => void) | undefined;
    const schedule = vi.fn((task: () => void) => {
      scheduled = task;
    });
    const worker = vi.fn(async () => {});
    const onError = vi.fn();
    const handler = createAckFirstEventHandler(worker, onError, schedule);

    await expect(handler({ message: "test" })).resolves.toBeUndefined();
    expect(schedule).toHaveBeenCalledOnce();
    expect(worker).not.toHaveBeenCalled();

    scheduled?.();
    await vi.waitFor(() => expect(worker).toHaveBeenCalledWith({ message: "test" }));
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports detached worker failures without rejecting the SDK callback", async () => {
    const error = new Error("worker failed");
    const onError = vi.fn();
    const handler = createAckFirstEventHandler(
      async () => {
        throw error;
      },
      onError,
      (task) => task(),
    );

    await expect(handler({})).resolves.toBeUndefined();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(error));
  });
});

describe("FeishuMessageLedger", () => {
  it("rejects an already accepted message after a process restart", async () => {
    const first = await createLedger();
    await first.load();

    expect(await first.accept({
      messageId: "om_001",
      chatId: "oc_chat",
      createTime: 100,
    })).toBe("accepted");

    const restarted = new FeishuMessageLedger(first.filePath, 5);
    await restarted.load();

    expect(await restarted.accept({
      messageId: "om_001",
      chatId: "oc_chat",
      createTime: 100,
    })).toBe("duplicate");
  });

  it("rejects a unique old event after restoring the chat high-water mark", async () => {
    const first = await createLedger();
    await first.load();

    expect(await first.accept({
      messageId: "om_new",
      chatId: "oc_chat",
      createTime: 200,
    })).toBe("accepted");

    const restarted = new FeishuMessageLedger(first.filePath, 5);
    await restarted.load();

    expect(await restarted.accept({
      messageId: "om_old",
      chatId: "oc_chat",
      createTime: 100,
    })).toBe("stale");
  });

  it("accepts distinct messages with the same create timestamp", async () => {
    const ledger = await createLedger();
    await ledger.load();

    expect(await ledger.accept({
      messageId: "om_001",
      chatId: "oc_chat",
      createTime: 100,
    })).toBe("accepted");
    expect(await ledger.accept({
      messageId: "om_002",
      chatId: "oc_chat",
      createTime: 100,
    })).toBe("accepted");
  });

  it("keeps only the configured number of recent message IDs", async () => {
    const ledger = await createLedger(2);
    await ledger.load();

    await ledger.accept({ messageId: "om_001", chatId: "oc_chat", createTime: 100 });
    await ledger.accept({ messageId: "om_002", chatId: "oc_chat", createTime: 200 });
    await ledger.accept({ messageId: "om_003", chatId: "oc_chat", createTime: 300 });

    const restarted = new FeishuMessageLedger(ledger.filePath, 2);
    await restarted.load();

    expect(await restarted.accept({
      messageId: "om_001",
      chatId: "oc_other",
      createTime: 100,
    })).toBe("accepted");
    expect(await restarted.accept({
      messageId: "om_003",
      chatId: "oc_chat",
      createTime: 300,
    })).toBe("duplicate");
  });
});
