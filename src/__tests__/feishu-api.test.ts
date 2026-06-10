import { afterEach, describe, expect, it, vi } from "vitest";

import { sendTextReply } from "../feishu-api.ts";

function abortError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

describe("sendTextReply timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("aborts a hung text send request", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});

    const fetchMock = vi.fn((_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(abortError()));
      })
    ));
    vi.stubGlobal("fetch", fetchMock);

    const send = expect(sendTextReply("token", "chat-1", "hello"))
      .resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);

    await send;
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/im/v1/messages?receive_id_type=chat_id"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("also aborts when response body reading hangs", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});

    const fetchMock = vi.fn((_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => (
      Promise.resolve({
        status: 200,
        text: () => new Promise<string>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(abortError()));
        }),
      } as Response)
    ));
    vi.stubGlobal("fetch", fetchMock);

    const send = expect(sendTextReply("token", "chat-2", "hello"))
      .resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);

    await send;
  });
});
