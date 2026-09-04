import { createServer } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { waitForPortFree } from "../shared.ts";

const servers: ReturnType<typeof createServer>[] = [];

async function occupyLoopbackPort(): Promise<{ port: number; server: ReturnType<typeof createServer> }> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test port");
  return { port: address.port, server };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  })));
});

describe("cross-platform restart port handoff", () => {
  it("waits until an occupied loopback port is actually released", async () => {
    const { port, server } = await occupyLoopbackPort();
    const waiting = waitForPortFree(port, 1_000, 20);
    setTimeout(() => server.close(), 80);

    await expect(waiting).resolves.toBe(true);
  });

  it("returns false instead of pretending success when the port stays occupied", async () => {
    const { port } = await occupyLoopbackPort();

    await expect(waitForPortFree(port, 80, 20)).resolves.toBe(false);
  });
});
