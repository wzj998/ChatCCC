import { afterEach, describe, expect, it, vi } from "vitest";
import { createFeishuConnectionSupervisor, type FeishuConnectionCallbacks } from "../feishu-connection.ts";

afterEach(() => { vi.useRealTimers(); });

function fixture() {
  vi.useFakeTimers();
  let callbacks!: FeishuConnectionCallbacks;
  let state = "connecting";
  const client = {
    start: vi.fn(async () => {}),
    close: vi.fn(),
    getConnectionStatus: () => ({ state }),
  };
  const onConnected = vi.fn();
  const log = vi.fn();
  const createClient = vi.fn((value: FeishuConnectionCallbacks) => { callbacks = value; return client; });
  const supervisor = createFeishuConnectionSupervisor({ createClient, onConnected, log,
    checkIntervalMs: 10, stalledAfterMs: 100, startupTimeoutMs: 500 });
  return { supervisor, client, createClient, onConnected, log, get callbacks() { return callbacks; },
    connected() { state = "connected"; callbacks.onReady(); },
    state(value: string) { state = value; } };
}

describe("Feishu receiving connection", () => {
  it("waits for onReady, not the early start promise, and tolerates idle healthy connections", async () => {
    const f = fixture();
    let ready = false;
    const start = f.supervisor.start().then(() => { ready = true; });
    await vi.advanceTimersByTimeAsync(30);
    expect(ready).toBe(false);
    f.connected();
    await start;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.client.close).not.toHaveBeenCalled();
    expect(f.onConnected).toHaveBeenCalledOnce();
    f.supervisor.stop();
  });

  it("restarts only the transport when SDK reconnect stalls, keeping the same dispatcher/client", async () => {
    const f = fixture();
    const start = f.supervisor.start(); f.connected(); await start;
    f.state("reconnecting"); f.callbacks.onReconnecting();
    await vi.advanceTimersByTimeAsync(120);
    expect(f.client.close).toHaveBeenCalledWith({ force: true });
    expect(f.client.start).toHaveBeenCalledTimes(2);
    expect(f.createClient).toHaveBeenCalledOnce();
    f.state("connected"); f.callbacks.onReconnected();
    await vi.advanceTimersByTimeAsync(300);
    expect(f.client.start).toHaveBeenCalledTimes(2);
    expect(f.onConnected).toHaveBeenCalledTimes(2);
    f.supervisor.stop();
  });

  it("bounds startup failure, stops its timers, and ignores late readiness", async () => {
    const f = fixture();
    const start = expect(f.supervisor.start()).rejects.toThrow("飞书长连接");
    await vi.advanceTimersByTimeAsync(500);
    await start;
    const attempts = f.client.start.mock.calls.length;
    f.connected();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.client.start).toHaveBeenCalledTimes(attempts);
    expect(f.onConnected).not.toHaveBeenCalled();
  });

  it("handles asynchronous SDK errors and preserves the recovery grace period", async () => {
    const f = fixture();
    const start = f.supervisor.start(); f.connected(); await start;
    f.state("failed"); f.callbacks.onError(new Error("tls handshake eof"));
    await vi.advanceTimersByTimeAsync(50);
    expect(f.client.start).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(70);
    expect(f.client.start).toHaveBeenCalledTimes(2);
    f.supervisor.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(f.client.start).toHaveBeenCalledTimes(2);
  });

  it("recovers rejected start promises without unhandled rejection or duplicate launch", async () => {
    const f = fixture();
    f.client.start.mockRejectedValueOnce(new Error("TLS failed token=private-value"));
    const start = f.supervisor.start();
    await vi.advanceTimersByTimeAsync(120);
    expect(f.client.start).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(f.log.mock.calls)).not.toContain("private-value");
    f.connected();
    await start;
    f.supervisor.stop();
  });

  it("closes late connections after stop instead of resurrecting them", async () => {
    const f = fixture();
    const start = f.supervisor.start(); f.connected(); await start;
    f.supervisor.stop();
    f.callbacks.onReconnected();
    expect(f.client.close).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.onConnected).toHaveBeenCalledOnce();
  });
});
