import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import {
  AGENT_SEND_IMAGE_PATH,
  buildAgentImageCapabilityPrompt,
  handleAgentImageRequest,
} from "../agent-image-rpc.ts";
import {
  clearAgentCapabilityGrants,
  issueAgentCapabilityGrant,
} from "../agent-capability-grants.ts";

function request(body: unknown): Readable & {
  url?: string;
  method?: string;
  headers: Record<string, string>;
} {
  const req = Readable.from([Buffer.from(JSON.stringify(body), "utf8")]) as Readable & {
    url?: string;
    method?: string;
    headers: Record<string, string>;
  };
  req.url = AGENT_SEND_IMAGE_PATH;
  req.method = "POST";
  req.headers = { "content-type": "application/json; charset=utf-8" };
  return req;
}

function response() {
  return {
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
}

describe("agent image RPC", () => {
  afterEach(() => clearAgentCapabilityGrants());

  it("builds prompt instructions with session_id", () => {
    const prompt = buildAgentImageCapabilityPrompt({
      url: `http://127.0.0.1:18080${AGENT_SEND_IMAGE_PATH}`,
      sessionId: "sid-test",
      grant: "grant-test",
    });

    expect(prompt).toContain("POST http://127.0.0.1:18080/api/agent/send-image");
    expect(prompt).toContain('"session_id":"sid-test"');
    expect(prompt).toContain('"grant":"grant-test"');
    expect(prompt).toContain("Content-Type: application/json; charset=utf-8");
    expect(prompt).toContain("UTF-8 encoded JSON bytes");
    expect(prompt).toContain('"path"');
    expect(prompt).not.toContain("Authorization: Bearer");
    expect(prompt).not.toContain("CHATCCC_SEND_IMAGE_URL");
    expect(prompt).not.toContain("CHATCCC_SEND_IMAGE_TOKEN");
  });

  it("builds prompt with cwd hint", () => {
    const prompt = buildAgentImageCapabilityPrompt({
      url: `http://127.0.0.1:18080${AGENT_SEND_IMAGE_PATH}`,
      sessionId: "sid-1",
      cwd: "F:/repo",
      grant: "grant-1",
    });

    expect(prompt).toContain("Current working directory: F:/repo");
  });

  it("rejects a request without the current session grant before resolving its path", async () => {
    issueAgentCapabilityGrant("sid-image");
    const req = request({ session_id: "sid-image", path: "missing.png" });
    const res = response();

    await handleAgentImageRequest(req as never, res as never);

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toContain("capability grant");
  });

  it("rejects a grant issued to another session", async () => {
    const otherGrant = issueAgentCapabilityGrant("sid-other");
    const req = request({ session_id: "sid-image", grant: otherGrant, path: "missing.png" });
    const res = response();

    await handleAgentImageRequest(req as never, res as never);

    expect(res.statusCode).toBe(403);
  });
});
