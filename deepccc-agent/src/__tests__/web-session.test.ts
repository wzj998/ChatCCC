import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatEvent } from "../index.ts";
import { BuiltinContextManager } from "../context.js";
import { DeepCccWebRuntime } from "../web-runtime.js";
import { WebSessionStore } from "../web-session-store.js";

describe("DeepCCC web sessions", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function storeFixture() {
    const rootDir = await mkdtemp(join(tmpdir(), "deepccc-web-sessions-"));
    roots.push(rootDir);
    let id = 0;
    let tick = 0;
    return new WebSessionStore({
      rootDir,
      idFactory: () => `web-${++id}`,
      now: () => new Date(Date.UTC(2026, 7, 18, 0, 0, tick++)),
    });
  }

  it("persists independent model and effort metadata for each session", async () => {
    const store = await storeFixture();
    const first = await store.create({ cwd: "C:\\repo", model: "model-a", effort: "high" });
    const second = await store.create({ cwd: "C:\\repo", model: "model-b", effort: "low" });

    await store.update(first.sessionId, { title: "Frontend", model: "model-c", effort: "xhigh" });

    expect(await store.list()).toEqual([
      expect.objectContaining({ sessionId: first.sessionId, title: "Frontend", model: "model-c", effort: "xhigh" }),
      expect.objectContaining({ sessionId: second.sessionId, model: "model-b", effort: "low" }),
    ]);
    expect(await store.get(first.sessionId)).toMatchObject({ cwd: "C:\\repo", model: "model-c", effort: "xhigh" });
  });

  it("makes existing CLI sessions available in the Web UI", async () => {
    const store = await storeFixture();
    const context = new BuiltinContextManager({
      contextDir: store.rootDir,
      sessionId: "cli-existing",
      cwd: process.cwd(),
      persist: true,
    });
    context.appendMessage({ role: "user", content: "existing history" });

    expect(await store.get("cli-existing")).toMatchObject({
      sessionId: "cli-existing",
      cwd: process.cwd(),
      model: "",
    });
    expect(await store.list()).toEqual([
      expect.objectContaining({ sessionId: "cli-existing" }),
    ]);
  });

  it("allows different sessions in the same cwd to run concurrently", async () => {
    const store = await storeFixture();
    const gates: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    const runtime = new DeepCccWebRuntime({
      store,
      loadConfig: () => ({
        provider: "openai",
        apiKey: "test-key",
        baseURL: "https://example.test/v1",
        model: "default-model",
        subModel: "",
        effort: "",
        maxOutputTokens: undefined,
        contextWindow: 1_000_000,
        streaming: true,
      }),
      sessionFactory: () => ({
        async *chat(): AsyncGenerator<ChatEvent> {
          active++;
          maxActive = Math.max(maxActive, active);
          yield { type: "status", phase: "generating" };
          await new Promise<void>((resolve) => gates.push(resolve));
          active--;
          yield { type: "done", text: "ok" };
        },
      }),
    });
    const first = await runtime.createSession({ cwd: "C:\\repo" });
    const second = await runtime.createSession({ cwd: "C:\\repo" });

    await Promise.all([
      runtime.sendMessage(first.sessionId, "task one"),
      runtime.sendMessage(second.sessionId, "task two"),
    ]);
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    expect(maxActive).toBe(2);
    gates.splice(0).forEach((resolve) => resolve());
    await Promise.all([runtime.waitForIdle(first.sessionId), runtime.waitForIdle(second.sessionId)]);
  });

  it("surfaces high-risk permission requests and resumes after approval", async () => {
    const store = await storeFixture();
    let permissionResolver: unknown;
    const runtime = new DeepCccWebRuntime({
      store,
      loadConfig: () => ({
        provider: "openai",
        apiKey: "test-key",
        baseURL: "https://example.test/v1",
        model: "default-model",
        subModel: "",
        effort: "",
        maxOutputTokens: undefined,
        contextWindow: 1_000_000,
        streaming: true,
      }),
      sessionFactory: (input) => {
        permissionResolver = input.permissionResolver;
        return {
          async *chat(): AsyncGenerator<ChatEvent> {
            const answer = await input.permissionResolver({
              tool: "run_command",
              action: "git reset --hard",
              reason: "high-risk",
              detail: "危险命令",
            });
            yield { type: "done", text: answer };
          },
        };
      },
      approvalTimeoutMs: 30_000,
    });
    const session = await runtime.createSession({ cwd: "C:\\repo" });
    await runtime.sendMessage(session.sessionId, "reset it");

    const approval = await vi.waitFor(async () => {
      const snapshot = await runtime.getSession(session.sessionId);
      expect(snapshot.pendingApproval).toBeTruthy();
      return snapshot.pendingApproval!;
    });
    expect(permissionResolver).toBeTypeOf("function");
    await runtime.resolveApproval(approval.approvalId, "allow-session");
    await runtime.waitForIdle(session.sessionId);
    const completed = await runtime.getSession(session.sessionId);
    expect(completed.status).toBe("idle");
    expect(completed.approvals).toEqual([
      expect.objectContaining({ approvalId: approval.approvalId, answer: "allow-session", status: "resolved" }),
    ]);
  });
});
