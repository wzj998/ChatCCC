import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const mockSetDefaultCwd = vi.hoisted(() => vi.fn());
const mockAddRecentDir = vi.hoisted(() => vi.fn());
const mockGetChatsForSession = vi.hoisted(() => vi.fn());

vi.mock("../config.ts", () => ({
  setDefaultCwd: mockSetDefaultCwd,
  addRecentDir: mockAddRecentDir,
}));
vi.mock("../session-chat-binding.ts", () => ({
  getChatsForSession: mockGetChatsForSession,
}));

import {
  AGENT_SET_CWD_PATH,
  handleAgentSetCwdRequest,
} from "../agent-set-cwd-rpc.ts";

function request(body: unknown, path = AGENT_SET_CWD_PATH, method = "POST"): Readable & {
  url?: string;
  method?: string;
  headers: Record<string, string>;
} {
  const req = Readable.from([Buffer.from(JSON.stringify(body), "utf8")]) as Readable & {
    url?: string;
    method?: string;
    headers: Record<string, string>;
  };
  req.url = path;
  req.method = method;
  req.headers = { "content-type": "application/json; charset=utf-8" };
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

describe("agent set-cwd RPC", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "chatccc-set-cwd-"));
    mockSetDefaultCwd.mockReset();
    mockAddRecentDir.mockReset();
    mockGetChatsForSession.mockReset();
    mockGetChatsForSession.mockReturnValue(["chat-id"]);
    mockSetDefaultCwd.mockResolvedValue(undefined);
    mockAddRecentDir.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("persists the directory for the session's bound chat", async () => {
    const req = request({ session_id: "sid-1", dir });
    const res = response();

    await handleAgentSetCwdRequest(req as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, dir, chat_id: "chat-id" });
    expect(mockSetDefaultCwd).toHaveBeenCalledWith(dir, "chat-id");
    expect(mockAddRecentDir).toHaveBeenCalledWith(dir);
  });

  it("rejects a missing session_id", async () => {
    const req = request({ dir });
    const res = response();

    await handleAgentSetCwdRequest(req as never, res as never);

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("session_id");
    expect(mockSetDefaultCwd).not.toHaveBeenCalled();
  });

  it("rejects a missing dir", async () => {
    const req = request({ session_id: "sid-1" });
    const res = response();

    await handleAgentSetCwdRequest(req as never, res as never);

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("dir");
    expect(mockSetDefaultCwd).not.toHaveBeenCalled();
  });

  it("rejects a non-existent directory", async () => {
    const req = request({ session_id: "sid-1", dir: join(dir, "nope") });
    const res = response();

    await handleAgentSetCwdRequest(req as never, res as never);

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("does not exist");
    expect(mockSetDefaultCwd).not.toHaveBeenCalled();
  });

  it("returns 404 when the session has no bound chat", async () => {
    mockGetChatsForSession.mockReturnValue([]);
    const req = request({ session_id: "sid-1", dir });
    const res = response();

    await handleAgentSetCwdRequest(req as never, res as never);

    expect(res.statusCode).toBe(404);
    expect(mockSetDefaultCwd).not.toHaveBeenCalled();
  });

  it("returns false for unrelated paths", async () => {
    const req = request({}, "/api/other");
    const res = response();

    await expect(handleAgentSetCwdRequest(req as never, res as never)).resolves.toBe(false);
  });
});
