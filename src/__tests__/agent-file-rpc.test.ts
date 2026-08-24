import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import {
  AGENT_SEND_FILE_PATH,
  buildAgentFileCapabilityPrompt,
  handleAgentFileRequest,
} from "../agent-file-rpc.ts";
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
  req.url = AGENT_SEND_FILE_PATH;
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

describe("agent file RPC", () => {
  afterEach(() => clearAgentCapabilityGrants());

  it("includes the session capability grant in prompt instructions", () => {
    const prompt = buildAgentFileCapabilityPrompt({
      url: `http://127.0.0.1:18080${AGENT_SEND_FILE_PATH}`,
      sessionId: "sid-file",
      grant: "grant-file",
    });

    expect(prompt).toContain('"session_id":"sid-file"');
    expect(prompt).toContain('"grant":"grant-file"');
  });

  it("rejects a request without the current session grant before resolving its path", async () => {
    issueAgentCapabilityGrant("sid-file");
    const req = request({ session_id: "sid-file", path: "missing.txt" });
    const res = response();

    await handleAgentFileRequest(req as never, res as never);

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toContain("capability grant");
  });

  it("rejects a grant issued to another session", async () => {
    const otherGrant = issueAgentCapabilityGrant("sid-other");
    const req = request({ session_id: "sid-file", grant: otherGrant, path: "missing.txt" });
    const res = response();

    await handleAgentFileRequest(req as never, res as never);

    expect(res.statusCode).toBe(403);
  });
});
