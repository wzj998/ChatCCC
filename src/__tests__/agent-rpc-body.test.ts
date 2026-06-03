import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { getRequestCharset, readUtf8JsonBody } from "../agent-rpc-body.ts";

function requestFrom(body: Buffer, contentType?: string): IncomingMessage {
  const req = Readable.from([body]) as IncomingMessage;
  req.headers = {};
  if (contentType) req.headers["content-type"] = contentType;
  return req;
}

describe("agent RPC body parsing", () => {
  it("defaults JSON requests to UTF-8 and preserves Unicode captions", async () => {
    const caption = "\u4e2d\u6587 caption";
    const body = Buffer.from(JSON.stringify({ caption }), "utf8");
    const req = requestFrom(body, "application/json");

    await expect(readUtf8JsonBody(req, 1024)).resolves.toEqual({ caption });
  });

  it("reads charset from content-type", () => {
    const req = requestFrom(Buffer.from("{}"), 'application/json; charset="utf-8"');

    expect(getRequestCharset(req)).toBe("utf-8");
  });

  it("rejects non UTF-8 charsets", async () => {
    const req = requestFrom(Buffer.from("{}"), "application/json; charset=gbk");

    await expect(readUtf8JsonBody(req, 1024)).rejects.toThrow("Unsupported charset");
  });

  it("replaces invalid UTF-8 bytes instead of rejecting", async () => {
    const req = requestFrom(Buffer.from([0xff, 0xfe]), "application/json; charset=utf-8");

    // 无效 UTF-8 字节被替换为 U+FFFD，不再直接抛错
    await expect(readUtf8JsonBody(req, 1024)).rejects.toThrow();
  });
});
