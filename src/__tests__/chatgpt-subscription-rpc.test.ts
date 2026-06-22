import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetChatGptSubscriptionStatus = vi.hoisted(() => vi.fn());

vi.mock("../chatgpt-subscription.ts", () => ({
  getChatGptSubscriptionStatus: mockGetChatGptSubscriptionStatus,
}));

import {
  CHATGPT_SUBSCRIPTION_PATH,
  handleChatGptSubscriptionRequest,
} from "../chatgpt-subscription-rpc.ts";

function request(path = CHATGPT_SUBSCRIPTION_PATH, method = "GET"): Readable & {
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

describe("ChatGPT subscription RPC", () => {
  beforeEach(() => {
    mockGetChatGptSubscriptionStatus.mockReset();
    mockGetChatGptSubscriptionStatus.mockResolvedValue({
      ok: false,
      code: "chrome_cdp_disabled",
      reason: "Chrome CDP guard is disabled in ChatCCC config.",
      chromeCdp: { enabled: false, port: 15166, status: "skipped" },
    });
  });

  it("returns the structured subscription lookup JSON", async () => {
    const req = request();
    const res = response();

    await expect(handleChatGptSubscriptionRequest(req as never, res as never)).resolves.toBe(true);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      ok: false,
      code: "chrome_cdp_disabled",
      reason: "Chrome CDP guard is disabled in ChatCCC config.",
      chromeCdp: { enabled: false, port: 15166, status: "skipped" },
    });
  });

  it("does not handle other paths", async () => {
    const res = response();

    await expect(handleChatGptSubscriptionRequest(request("/api/other") as never, res as never)).resolves.toBe(false);
    expect(res.body).toBe("");
  });

  it("rejects non-GET methods", async () => {
    const res = response();

    await expect(handleChatGptSubscriptionRequest(request(CHATGPT_SUBSCRIPTION_PATH, "POST") as never, res as never)).resolves.toBe(true);
    expect(res.statusCode).toBe(405);
    expect(JSON.parse(res.body)).toMatchObject({ ok: false, code: "method_not_allowed" });
  });
});
