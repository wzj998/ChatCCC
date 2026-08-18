import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatEvent } from "../index.ts";
import { parseAttachmentPrompt } from "../attachments.js";
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
    const first = await store.create({ cwd: "C:\\repo", model: "model-a", subModel: "sub-a", effort: "high" });
    const second = await store.create({ cwd: "C:\\repo", model: "model-b", subModel: "sub-b", effort: "low" });

    await store.update(first.sessionId, { title: "Frontend", model: "model-c", subModel: "sub-c", effort: "xhigh" });

    expect(await store.list()).toEqual([
      expect.objectContaining({ sessionId: first.sessionId, title: "Frontend", model: "model-c", subModel: "sub-c", effort: "xhigh" }),
      expect.objectContaining({ sessionId: second.sessionId, model: "model-b", subModel: "sub-b", effort: "low" }),
    ]);
    expect(await store.get(first.sessionId)).toMatchObject({ cwd: "C:\\repo", model: "model-c", subModel: "sub-c", effort: "xhigh" });
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

  it("atomically rejects concurrent sends for the same session", async () => {
    const store = await storeFixture();
    let release!: () => void;
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
          await new Promise<void>((resolve) => { release = resolve; });
          yield { type: "done", text: "ok" };
        },
      }),
    });
    const session = await runtime.createSession({ cwd: "C:\\repo" });

    const results = await Promise.allSettled([
      runtime.sendMessage(session.sessionId, "first"),
      runtime.sendMessage(session.sessionId, "second"),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    release();
    await runtime.waitForIdle(session.sessionId);
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

  it("publishes session changes to global subscribers", async () => {
    const store = await storeFixture();
    let release!: () => void;
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
          await new Promise<void>((resolve) => { release = resolve; });
          yield { type: "done", text: "ok" };
        },
      }),
    });
    const events: Array<{ sessionId: string; type: string }> = [];
    const unsubscribeThrowingGlobal = runtime.subscribeAll(() => { throw new Error("disconnected global SSE"); });
    const unsubscribe = runtime.subscribeAll((event) => events.push(event));

    const session = await runtime.createSession({ cwd: "C:\\repo" });
    const unsubscribeThrowingSession = runtime.subscribe(session.sessionId, () => { throw new Error("disconnected session SSE"); });

    expect(events).toContainEqual(expect.objectContaining({
      sessionId: session.sessionId,
      type: "session_updated",
    }));
    await runtime.sendMessage(session.sessionId, "run it");
    expect(await runtime.listSessions()).toContainEqual(expect.objectContaining({
      sessionId: session.sessionId,
      status: "running",
    }));
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    release();
    await runtime.waitForIdle(session.sessionId);
    expect(events.at(-1)).toEqual(expect.objectContaining({
      sessionId: session.sessionId,
      type: "session_updated",
      data: expect.objectContaining({ status: "idle" }),
    }));
    expect(events.some((event) => event.type === "user" || event.type === "agent")).toBe(false);
    await runtime.deleteSession(session.sessionId);
    expect(events.at(-1)).toEqual(expect.objectContaining({
      sessionId: session.sessionId,
      type: "session_deleted",
    }));
    unsubscribeThrowingSession();
    unsubscribeThrowingGlobal();
    unsubscribe();
  });

  it("immediately denies and clears a pending approval when the session is stopped", async () => {
    const store = await storeFixture();
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
      sessionFactory: (input) => ({
        async *chat(): AsyncGenerator<ChatEvent> {
          await input.permissionResolver({
            tool: "run_command",
            action: "git clean -fd",
            reason: "high-risk",
            detail: "危险命令",
          });
          yield { type: "done", text: "finished" };
        },
      }),
      approvalTimeoutMs: 30_000,
    });
    const session = await runtime.createSession({ cwd: "C:\\repo" });
    await runtime.sendMessage(session.sessionId, "clean it");
    const approval = await vi.waitFor(async () => {
      const snapshot = await runtime.getSession(session.sessionId);
      expect(snapshot.pendingApproval).toBeTruthy();
      return snapshot.pendingApproval!;
    });

    expect(await runtime.stopSession(session.sessionId)).toBe(true);
    await runtime.waitForIdle(session.sessionId);

    const stopped = await runtime.getSession(session.sessionId);
    expect(stopped.pendingApproval).toBeNull();
    expect(stopped.status).toBe("idle");
    expect(stopped.approvals).toContainEqual(expect.objectContaining({
      approvalId: approval.approvalId,
      answer: "deny",
      status: "resolved",
    }));
  });

  it("passes Web images to the Agent as local attachment paths and cleans them with the session", async () => {
    const store = await storeFixture();
    let receivedPrompt = "";
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
        async *chat(input): AsyncGenerator<ChatEvent> {
          receivedPrompt = input;
          yield { type: "done", text: "ok" };
        },
      }),
    });
    const session = await runtime.createSession({ cwd: process.cwd() });
    const attachment = await runtime.addAttachment(session.sessionId, {
      originalName: "screen.png",
      bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]),
    });

    await runtime.sendMessage(session.sessionId, "", [attachment.attachmentId]);
    await runtime.waitForIdle(session.sessionId);

    const parsed = parseAttachmentPrompt(receivedPrompt);
    expect(parsed.text).toBe("请分析这些图片。");
    expect(parsed.attachments).toEqual([attachment]);
    expect(receivedPrompt).toContain("不要假设模型原生支持图片");

    await runtime.deleteSession(session.sessionId);
    expect(await runtime.attachmentStore.get(session.sessionId, attachment.attachmentId)).toBeNull();
  });

  it("only serves presented artifacts from the session workspace or attachment directory", async () => {
    const store = await storeFixture();
    const workspace = await mkdtemp(join(tmpdir(), "deepccc-artifact-workspace-"));
    const outside = await mkdtemp(join(tmpdir(), "deepccc-artifact-outside-"));
    roots.push(workspace, outside);
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    const insidePath = join(workspace, "inside.png");
    const outsidePath = join(outside, "outside.png");
    await Promise.all([writeFile(insidePath, png), writeFile(outsidePath, png)]);
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
    });
    const session = await runtime.createSession({ cwd: workspace });

    await expect(runtime.readArtifact(session.sessionId, insidePath)).resolves.toMatchObject({
      path: insidePath,
      mimeType: "image/png",
    });
    await expect(runtime.readArtifact(session.sessionId, outsidePath)).rejects.toThrow(/outside/);
  });
});
