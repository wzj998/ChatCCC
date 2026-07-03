import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import {
  AGENT_RELOAD_CONFIG_PATH,
  handleAgentReloadConfigRequest,
} from "../agent-reload-config-rpc.ts";

function request(path = AGENT_RELOAD_CONFIG_PATH, method = "POST"): Readable & {
  url?: string;
  method?: string;
  headers: Record<string, string>;
} {
  const req = Readable.from([]) as Readable & {
    url?: string;
    method?: string;
    headers: Record<string, string>;
  };
  req.url = path;
  req.method = method;
  req.headers = {};
  return req;
}

function response() {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: "",
    writeHead(status: number, headers: Record<string, string>) {
      this.statusCode = status;
      this.headers = headers;
      return this;
    },
    end(chunk?: string) {
      this.body += chunk ?? "";
      return this;
    },
  };
  return res;
}

describe("agent reload config RPC", () => {
  it("reloads runtime config for POST requests", async () => {
    const reload = vi.fn(async () => ({
      configPath: "C:\\Users\\me\\.chatccc\\config.json",
      defaultAgent: "codex" as const,
      reloadedAt: "2026-07-02T05:00:00.000Z",
    }));
    const res = response();

    await expect(handleAgentReloadConfigRequest(request() as never, res as never, reload)).resolves.toBe(true);

    expect(reload).toHaveBeenCalledWith("agent-reload-api");
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      ok: true,
      configPath: "C:\\Users\\me\\.chatccc\\config.json",
      defaultAgent: "codex",
      reloadedAt: "2026-07-02T05:00:00.000Z",
    });
  });

  it("rejects non-POST requests without reloading", async () => {
    const reload = vi.fn();
    const res = response();

    await expect(handleAgentReloadConfigRequest(request(AGENT_RELOAD_CONFIG_PATH, "GET") as never, res as never, reload)).resolves.toBe(true);

    expect(reload).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(405);
    expect(JSON.parse(res.body)).toMatchObject({ ok: false, error: "Method not allowed" });
  });

  it("does not handle other paths", async () => {
    const res = response();

    await expect(handleAgentReloadConfigRequest(request("/api/other") as never, res as never, vi.fn())).resolves.toBe(false);

    expect(res.body).toBe("");
  });

  it("returns a visible error when reload fails", async () => {
    const res = response();

    await expect(
      handleAgentReloadConfigRequest(
        request() as never,
        res as never,
        vi.fn(async () => {
          throw new Error("bad config");
        }),
      ),
    ).resolves.toBe(true);

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ ok: false, error: "bad config" });
  });
});
