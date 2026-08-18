import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDeepCccWebRequestHandler } from "../web-server.js";

describe("DeepCCC web HTTP API", () => {
  const servers: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  async function fixture(instance?: { pid: number; port: number; startedAt: string; token: string; shutdown: () => void }) {
    const runtime = {
      listSessions: async () => [],
      createSession: async (input: { cwd: string }) => ({ sessionId: "web-1", title: "New session", ...input }),
      getSession: async () => ({ sessionId: "web-1", status: "idle", events: [], messages: [] }),
      updateSession: async () => ({ sessionId: "web-1" }),
      deleteSession: async () => true,
      sendMessage: async () => ({ runId: "run-1" }),
      stopSession: async () => true,
      resolveApproval: async () => true,
      subscribe: () => () => {},
    };
    let config = {
      provider: "openai" as const,
      baseURL: "https://example.test/v1",
      model: "model-a",
      subModel: "",
      effort: "high",
      contextWindow: 1_000_000,
      streaming: true,
      web: { port: 28080, openOnStart: true },
      apiKeyConfigured: true,
      apiKeyMask: "sk-••••1234",
    };
    const handler = createDeepCccWebRequestHandler({
      runtime: runtime as never,
      getPublicConfig: () => config,
      saveConfig: async (patch) => { config = { ...config, ...patch } as typeof config; return config; },
      defaultCwd: process.cwd(),
      instance,
    });
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("serves the application and never returns the full API key", async () => {
    const base = await fixture();
    const html = await fetch(base).then((response) => response.text());
    expect(html).toContain("DeepCCC");
    expect(html).toContain('id="session-list"');
    expect(html).not.toContain('id="approval-modal"');
    expect(html).toContain("approval-card");
    expect(html).toContain("color-scheme:light");
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Function(script!)).not.toThrow();

    const config = await fetch(`${base}/api/config`).then((response) => response.json());
    expect(config.config.apiKeyConfigured).toBe(true);
    expect(JSON.stringify(config)).not.toContain("test-key");
  });

  it("exposes owned instance identity and only accepts authenticated shutdown", async () => {
    const shutdown = vi.fn();
    const base = await fixture({ pid: 1234, port: 28080, startedAt: "2026-08-18T00:00:00.000Z", token: "owned-token", shutdown });
    const health = await fetch(`${base}/api/health`).then((response) => response.json());
    expect(health).toMatchObject({ service: "deepccc-web", pid: 1234, instanceToken: "owned-token" });

    const denied = await fetch(`${base}/api/shutdown`, { method: "POST", headers: { "x-deepccc-instance-token": "wrong" } });
    expect(denied.status).toBe(403);
    expect(shutdown).not.toHaveBeenCalled();

    const accepted = await fetch(`${base}/api/shutdown`, { method: "POST", headers: { "x-deepccc-instance-token": "owned-token" } });
    expect(accepted.status).toBe(202);
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce());
  });

  it("creates sessions and saves single-provider API settings", async () => {
    const base = await fixture();
    const created = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: process.cwd() }),
    }).then((response) => response.json());
    expect(created.session.sessionId).toBe("web-1");

    const saved = await fetch(`${base}/api/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "model-b", effort: "xhigh" }),
    }).then((response) => response.json());
    expect(saved.config).toMatchObject({ model: "model-b", effort: "xhigh" });
  });
});
