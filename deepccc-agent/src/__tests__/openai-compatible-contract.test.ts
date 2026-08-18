import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { config } from "../config.js";
import { ChatSession } from "../index.js";

async function collect(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of iterable) {
    // Consume the complete response so the transport request finishes.
  }
}

describe("OpenAI-compatible wire contract", () => {
  let server: Server | undefined;
  const originalStreaming = config.streaming;

  afterEach(async () => {
    config.streaming = originalStreaming;
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => error ? reject(error) : resolve());
      });
      server = undefined;
    }
  });

  it("sends reasoning_effort and max_tokens in the actual request body", async () => {
    let requestBody: Record<string, unknown> | undefined;
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          id: "chatcmpl-contract",
          object: "chat.completion",
          created: 1,
          model: "contract-model",
          choices: [{
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");

    config.streaming = false;
    const session = new ChatSession({
      provider: "openai",
      apiKey: "sk-contract-test",
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      model: "contract-model",
      effort: "low",
      maxOutputTokens: 8_192,
    });

    await collect(session.chat("hello"));

    expect(requestBody).toMatchObject({
      model: "contract-model",
      reasoning_effort: "low",
      max_tokens: 8_192,
    });
  });
});
